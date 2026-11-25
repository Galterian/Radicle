//! JNI surface of radicle-node for the chaosD6 Android app.
//!
//! The node runs *inside* RadicleNodeService (its own `:radicle` process)
//! instead of being exec()'d, so the APK only ships an ordinary `lib*.so` —
//! nothing Play's W^X / exec rules care about. `run()` mirrors radicle-node's
//! `main.rs` at the pinned heartwood tag minus CLI parsing, systemd and OS
//! signal handlers; `stop()` feeds `Signal::Terminate` into the runtime's
//! channel instead.
//!
//! The node is the P2P write path of chaosD6-Profiles (user ruling
//! 2026-11-13). The device's Radicle key IS its profile identity
//! (`identity.pem`, the `z6Mk…` id in a team's `owners`), so `init()` derives
//! the keystore from that file. game/profile-sync.mjs (in nodejs-mobile) does
//! the merging and builds each commit; it hands the same commit to this node
//! through a token-guarded loopback endpoint (`bridge.json` in RAD_HOME), which
//! re-creates it byte for byte (same oid) on `refs/heads/teams/<Team>` (or
//! `profiles/<id>`) in our own namespace, signs refs and announces. The OCI
//! seed (infra/oci/profiles-push.mjs) promotes it to the canonical branch after
//! its owner / fast-forward checks; if that does not happen in time the JS
//! side pushes the identical commit over HTTPS instead.
//!
//! The same bridge serves `POST /publish` for chaosD6-Dimensions: a whole
//! dimension snapshot (files under `ActiveDimensions/<Name>/`) committed on
//! `refs/heads/ActiveDimensions/<Name>` in our namespace, parent = our own
//! previous tip there. `init()` seeds every RID of a comma-separated list.
//!
//! `POST /publish` with `mode: "definition"` (feature "defs") is the phone half
//! of game/editor-publish.mjs: ONE new skill / effect / class on
//! `refs/heads/players/<team>/<slug>` of chaosD6-Skills / -Effects / -Classes =
//! the repo's canonical `main` tree + `<subdir>/<id>.json` + the index.json
//! manifest entry, built exactly like the desktop git plumbing so that the same
//! inputs give the same commit oid on both.
//!
//! Every entry point returns a String; failures come back as "error: <msg>".

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::OpenOptionsExt as _;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::str::FromStr as _;
use std::sync::{Mutex, Once, mpsc};
use std::time::Duration;

use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::jstring;

use radicle::crypto::ssh::keystore::Keystore;
use radicle::crypto::{Seed, Signer as _, SigningKey};
use radicle::git::UserInfo;
use radicle::identity::RepoId;
use radicle::node::policy::Scope;
use radicle::node::{Alias, FetchResult, Handle as _, NodeId};
use radicle::profile::{Config, Home, Profile};
use radicle::storage::{ReadRepository as _, ReadStorage as _, SignRepository as _, WriteStorage as _};
use radicle::{Node, Storage};
use radicle_node::fingerprint::Fingerprint;
use radicle_node::runtime::Runtime;
use radicle_signals::Signal;

type Res<T> = Result<T, String>;

/// Sender half of the running node's signal channel; `None` when stopped.
static STOP: Mutex<Option<mpsc::SyncSender<Signal>>> = Mutex::new(None);
static LOGGING: Once = Once::new();

const BRIDGE_FILE: &str = "bridge.json";
/// The only file a profile branch holds (same as profile-sync.mjs / profiles-push.mjs).
const PROFILE_FILE: &str = "profile.json";
/// What the bridge serves (bridge.json `features`): POST /save, POST /publish,
/// POST /publish `mode: "definition"` (defs; "gamemodels": the GameModels folders + several manifest entries),
/// POST /publish of refs/heads/votes/<me> (votes), POST /fetch (fetch).
const BRIDGE_FEATURES: [&str; 6] = ["save", "publish", "defs", "votes", "gamemodels", "fetch"];
/// Definition branches (game/editor-publish.mjs branchOf): refs/heads/players/<team-slug>/<slug>.
const PLAYERS_REF_PREFIX: &str = "refs/heads/players/";
/// The only directories a definition publish may write (+ DEFS_MANIFEST at the root).
/// chaosD6-Skills / -Effects / -Classes, and chaosD6-GameModels (2026-11-25: an NPC bundle = the NPC + its quests + the
/// village / race it changes; a building; a monster). `lib/` stays hand-authored in every repo.
const DEFS_DIRS: [&str; 9] = ["skills", "effects", "classes", "races", "buildings", "npcs", "monsters", "villages", "quests"];
const DEFS_MANIFEST: &str = "index.json";
const DEFS_MAX_FILES: usize = 24;
const DEFS_FILE_MAX: usize = 256 << 10;
/// Vote branches (game/proposal-votes.mjs voteBranch): refs/heads/votes/<voter id> = this node's own NID, votes/… only.
const VOTES_REF_PREFIX: &str = "refs/heads/votes/";
const VOTES_DIR: &str = "votes";
/// Dimension branches (chaosD6-Dimensions): refs/heads/ActiveDimensions/<Name>,
/// holding ActiveDimensions/<Name>/… only.
const DIMENSIONS_REF_PREFIX: &str = "refs/heads/ActiveDimensions/";
const DIMENSIONS_DIR: &str = "ActiveDimensions";
const SAVE_MAX: usize = 1 << 20;
const PUBLISH_MAX: usize = 8 << 20;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// stderr goes nowhere in an Android app process; route `log` to logcat.
fn init_logging() {
    LOGGING.call_once(|| {
        #[cfg(target_os = "android")]
        android_logger::init_once(
            android_logger::Config::default()
                .with_tag("radicle-node")
                .with_max_level(log::LevelFilter::Info),
        );
        #[cfg(not(target_os = "android"))]
        let _ = log::set_boxed_logger(Box::new(radicle_log::Logger::new()));
        log::set_max_level(log::LevelFilter::Info);
        std::panic::set_hook(Box::new(|info| log::error!(target: "panic", "{info}")));
    });
}

fn rid(s: &str) -> Res<RepoId> {
    let urn = if s.starts_with("rad:") { s.to_string() } else { format!("rad:{s}") };
    RepoId::from_str(&urn).map_err(err)
}

/// "rad:a,rad:b" → [a, b] (blank items skipped; a trailing "@all" scope marker is dropped).
fn rid_list(s: &str) -> Res<Vec<RepoId>> {
    Ok(rid_scopes(s)?.into_iter().map(|(r, _)| r).collect())
}

/// "rad:a,rad:b@all" → [(a, Followed), (b, All)]. `@all`: every player's namespace (chaosD6-GameModels: the other
/// teams' proposals the phone lists and votes on); the rest only the delegate's refs plus ours.
fn rid_scopes(s: &str) -> Res<Vec<(RepoId, Scope)>> {
    s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(|item| match item.strip_suffix("@all") {
        Some(r) => rid(r).map(|r| (r, Scope::All)),
        None => rid(item).map(|r| (r, Scope::Followed)),
    }).collect()
}

fn signing_key(home: &Home) -> Res<SigningKey> {
    Keystore::new(&home.keys())
        .secret_key(None)
        .map_err(err)?
        .ok_or_else(|| format!("no secret key in {}", home.keys().display()))
}

// ---- identity.pem (shared with game/profile-sync.mjs) ----

/// DER prefix of an ed25519 PKCS#8 private key; the 32-byte seed follows.
/// Exactly what node:crypto's `export({ format: 'pem', type: 'pkcs8' })` writes.
const PKCS8_ED25519_PREFIX: [u8; 16] = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::new();
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { B64[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

fn b64_decode(s: &str) -> Res<Vec<u8>> {
    let (mut out, mut acc, mut bits) = (Vec::new(), 0u32, 0);
    for ch in s.bytes().filter(|b| !b.is_ascii_whitespace() && *b != b'=') {
        let v = B64.iter().position(|&x| x == ch).ok_or("bad base64 in identity.pem")? as u32;
        acc = acc << 6 | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

fn seed_from_pem(pem: &str) -> Res<[u8; 32]> {
    let body: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    let der = b64_decode(&body)?;
    if der.len() != 48 || der[..16] != PKCS8_ED25519_PREFIX {
        return Err("identity.pem is not an ed25519 PKCS#8 key".into());
    }
    Ok(der[16..].try_into().expect("32 bytes"))
}

/// The device key's seed: read from `path`, or created there (0600, create-new so
/// that whichever of this and profile-sync.mjs runs first wins and the other reads it).
fn identity_seed(path: &Path) -> Res<[u8; 32]> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let mut seed = [0; 32];
    getrandom::fill(&mut seed).map_err(err)?;
    let mut der = PKCS8_ED25519_PREFIX.to_vec();
    der.extend_from_slice(&seed);
    let pem = format!("-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n", b64_encode(&der));
    match std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path) {
        Ok(mut f) => {
            f.write_all(pem.as_bytes()).map_err(err)?;
            log::info!(target: "node", "created {}", path.display());
            return Ok(seed);
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("{}: {e}", path.display())),
    }
    // The other side may still be writing it.
    for _ in 0..30 {
        if let Ok(seed) = std::fs::read_to_string(path).map_err(err).and_then(|p| seed_from_pem(&p)) {
            return Ok(seed);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    seed_from_pem(&std::fs::read_to_string(path).map_err(err)?)
}

/// First-run setup, safe to call on every start. Creates the keystore from
/// `identity` (identity.pem) if there is none — refusing to run if an existing
/// key is a different one — writes `config_json` (the APK's template wins over
/// the default Profile::init writes), seeds every rid in `rid_s` (one RID or a
/// comma-separated list: chaosD6-Profiles, chaosD6-Dimensions) with scope `followed` and
/// follows `follow` (the repo's delegate seed) so fetches pull the delegate's
/// refs plus ours, not every other player's namespace. Returns our NID.
fn init(home: &str, alias: &str, config_json: &str, rid_s: &str, follow: &str, identity: &str) -> Res<String> {
    let home = Home::new(home).map_err(err)?;
    let seed = identity_seed(Path::new(identity))?;
    let want = NodeId::from(*SigningKey::from_seed(Seed::new(seed)).public_key());
    if Keystore::new(&home.keys()).public_key().map_err(err)?.is_none() {
        let alias = Alias::from_str(alias).map_err(err)?;
        Profile::init(home.clone(), alias, None, Seed::new(seed)).map_err(err)?;
    }
    let signer = signing_key(&home)?;
    let nid = NodeId::from(*signer.public_key());
    if nid != want {
        return Err(format!("radicle key {nid} is not the profile identity {want} ({identity}); remove {} to re-key", home.keys().display()));
    }
    std::fs::write(home.config(), config_json).map_err(err)?;
    // Fail here with a readable error rather than inside run().
    Config::load(&home.config()).map_err(err)?;

    let rids = rid_scopes(rid_s)?;
    if rids.is_empty() {
        return Err("no rid to seed".into());
    }
    let mut policies = home.policies_mut().map_err(err)?;
    for (r, scope) in &rids {
        policies.seed(r, *scope).map_err(err)?;
    }
    if !follow.is_empty() {
        policies.follow(&NodeId::from_str(follow).map_err(err)?, None).map_err(err)?;
    }
    if Fingerprint::read(&home).map_err(err)?.is_none() {
        Fingerprint::init(&home, &signer).map_err(err)?;
    }
    Ok(nid.to_string())
}

/// Blocks until `stop()` (or a fatal error).
fn run(home: &str) -> Res<String> {
    let home = Home::new(home).map_err(err)?;
    let mut config = Config::load(&home.config()).map_err(err)?;
    log::set_max_level(log::Level::from(config.node.log).to_level_filter());
    let signer = signing_key(&home)?;

    config.node.connect.extend(config.preferred_seeds);
    let listen = config.node.listen.clone();
    let (notify, signals) = mpsc::sync_channel(1);
    *STOP.lock().map_err(err)? = Some(notify);

    let socket = home.socket_from_env();
    // A killed :radicle process leaves the socket behind; we're the only owner.
    std::fs::remove_file(&socket).ok();
    start_bridge(home.clone(), NodeId::from(*signer.public_key()))?;
    let result = Runtime::init(home.clone(), config.node, socket, listen, signals, signer)
        .and_then(|rt| rt.run())
        .map_err(err);
    std::fs::remove_file(home.path().join(BRIDGE_FILE)).ok();
    STOP.lock().map_err(err)?.take();
    result.map(|()| String::new())
}

fn stop() -> Res<String> {
    if let Some(tx) = STOP.lock().map_err(err)?.take() {
        tx.try_send(Signal::Terminate).ok();
    }
    Ok(String::new())
}

// ---- profile commits (the P2P write path) ----

/// One commit as profile-sync.mjs builds it with isomorphic-git.
struct SaveRequest {
    rid: String,
    /// refs/heads/teams/<Team> or refs/heads/profiles/<our id>.
    git_ref: String,
    /// Canonical tip the commit builds on (None = the branch is being created).
    parent: Option<String>,
    /// Exact profile.json bytes.
    content: Vec<u8>,
    name: String,
    email: String,
    timestamp: i64,
    message: String,
    /// The oid isomorphic-git computed; ours must match or nothing is written.
    expect: String,
    /// Delegate seed to fetch the repo / parent from when it isn't local yet.
    seed: String,
}

fn valid_ref(git_ref: &str, me: &NodeId) -> bool {
    let team = git_ref.strip_prefix("refs/heads/teams/").is_some_and(|s| {
        let b = s.as_bytes();
        !b.is_empty() && b.len() <= 40 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
    });
    team || git_ref == format!("refs/heads/profiles/{me}")
}

/// Write `req` as a commit on `req.git_ref` in our own namespace, sign refs,
/// announce. Returns the commit id.
fn save_commit(home: &Home, req: &SaveRequest) -> Res<String> {
    let rid = rid(&req.rid)?;
    let signer = signing_key(home)?;
    let me = NodeId::from(*signer.public_key());
    if !valid_ref(&req.git_ref, &me) {
        return Err(format!("refusing {}", req.git_ref));
    }
    let config = Config::load(&home.config()).map_err(err)?;
    let storage = Storage::open(home.storage(), UserInfo { alias: config.node.alias.clone(), key: me }).map_err(err)?;
    let mut node = Node::new(home.socket_from_env());
    let parent = req.parent.as_deref().map(git2::Oid::from_str).transpose().map_err(err)?;

    // The repo, and the canonical tip we build on, must be in local storage.
    let have_parent = |s: &Storage| -> Res<bool> {
        if !s.contains(&rid).map_err(err)? {
            return Ok(false);
        }
        Ok(parent.is_none_or(|p| s.repository(rid).is_ok_and(|r| r.backend.find_commit(p).is_ok())))
    };
    if !have_parent(&storage)? {
        let from = NodeId::from_str(&req.seed).map_err(err)?;
        if let FetchResult::Failed { reason } = node.fetch(rid, from, Duration::from_secs(45), None).map_err(err)? {
            return Err(format!("fetch {rid} from {from}: {reason}"));
        }
        if !have_parent(&storage)? {
            return Err(format!("parent {} of {} not replicated from {from} yet", req.parent.as_deref().unwrap_or("-"), req.git_ref));
        }
    }

    let repo = storage.repository_mut(rid).map_err(err)?;
    let raw = &repo.backend;
    let mut tb = raw.treebuilder(None).map_err(err)?;
    tb.insert(PROFILE_FILE, raw.blob(&req.content).map_err(err)?, 0o100644).map_err(err)?;
    let tree = raw.find_tree(tb.write().map_err(err)?).map_err(err)?;
    let sig = git2::Signature::new(&req.name, &req.email, &git2::Time::new(req.timestamp, 0)).map_err(err)?;
    let parents = parent.map(|p| raw.find_commit(p)).transpose().map_err(err)?;
    let parents: Vec<&git2::Commit> = parents.iter().collect();
    let oid = raw.commit(None, &sig, &sig, &req.message, &tree, &parents).map_err(err)?;
    if oid.to_string() != req.expect {
        return Err(format!("commit {oid} differs from profile-sync's {}; not written", req.expect));
    }
    // Our own namespace: just point the ref at it (an earlier, never-promoted save may sit there).
    let nsref = format!("refs/namespaces/{me}/{}", req.git_ref);
    raw.reference(&nsref, oid, true, "chaosD6 profile save").map_err(err)?;
    repo.sign_refs(&signer).map_err(err)?;
    if let Err(e) = node.announce_refs_for(rid, [me]) {
        log::warn!(target: "node", "announce {rid} after save: {e}");
    }
    log::info!(target: "node", "profile {} → {oid} (parent {})", req.git_ref, req.parent.as_deref().unwrap_or("none"));
    Ok(oid.to_string())
}

// ---- loopback bridge for profile-sync.mjs (nodejs-mobile has no channel back into Kotlin) ----

/// Binds 127.0.0.1:<random>, writes { port, token, nid, features } to
/// RAD_HOME/bridge.json (app-private), serves `POST /save` with a JSON
/// SaveRequest and `POST /publish` with a JSON PublishRequest.
fn start_bridge(home: Home, nid: NodeId) -> Res<()> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(err)?;
    let port = listener.local_addr().map_err(err)?.port();
    let mut raw = [0u8; 24];
    getrandom::fill(&mut raw).map_err(err)?;
    let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let file = home.path().join(BRIDGE_FILE);
    let tmp: PathBuf = home.path().join(format!("{BRIDGE_FILE}.tmp"));
    std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)
        .and_then(|mut f| f.write_all(serde_json::json!({ "port": port, "token": token, "nid": nid.to_string(), "features": BRIDGE_FEATURES }).to_string().as_bytes()))
        .and_then(|()| std::fs::rename(&tmp, &file))
        .map_err(err)?;
    log::info!(target: "node", "profile bridge on 127.0.0.1:{port}");
    std::thread::Builder::new().name("profile-bridge".into()).spawn(move || {
        for stream in listener.incoming().flatten() {
            let (home, token) = (home.clone(), token.clone());
            // One save at a time is plenty, and keeps storage writes serial.
            if let Err(e) = catch_unwind(AssertUnwindSafe(|| serve(stream, &home, &token))) {
                log::error!(target: "node", "bridge request panicked: {e:?}");
            }
        }
    }).map_err(err)?;
    Ok(())
}

fn respond(mut s: &TcpStream, code: u16, body: serde_json::Value) {
    let body = body.to_string();
    let _ = write!(s, "HTTP/1.1 {code} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        if code == 200 { "OK" } else { "Error" }, body.len());
}

fn serve(stream: TcpStream, home: &Home, token: &str) {
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
    let mut rd = BufReader::new(&stream);
    let mut line = String::new();
    if rd.read_line(&mut line).is_err() {
        return;
    }
    let mut len = 0usize;
    let mut auth = false;
    loop {
        let mut h = String::new();
        if rd.read_line(&mut h).is_err() || h.trim().is_empty() {
            break;
        }
        let (k, v) = h.split_once(':').unwrap_or((&h, ""));
        match k.trim().to_ascii_lowercase().as_str() {
            "content-length" => len = v.trim().parse().unwrap_or(0),
            "x-bridge-token" => auth = v.trim() == token,
            _ => {}
        }
    }
    if !auth {
        return respond(&stream, 403, serde_json::json!({ "ok": false, "error": "bad token" }));
    }
    let fetch = line.starts_with("POST /fetch ");
    let (publish, max) = if line.starts_with("POST /save ") {
        (false, SAVE_MAX)
    } else if line.starts_with("POST /publish ") {
        (true, PUBLISH_MAX)
    } else if fetch {
        (false, SAVE_MAX)
    } else {
        return respond(&stream, 404, serde_json::json!({ "ok": false, "error": "POST /save, /publish or /fetch only" }));
    };
    if len == 0 || len > max {
        return respond(&stream, 404, serde_json::json!({ "ok": false, "error": format!("body must be 1..={max} bytes") }));
    }
    let mut body = vec![0; len];
    if rd.read_exact(&mut body).is_err() {
        return respond(&stream, 400, serde_json::json!({ "ok": false, "error": "short body" }));
    }
    if fetch {
        return match fetch_repo(home, &body) {
            Ok(n) => respond(&stream, 200, serde_json::json!({ "ok": true, "updated": n })),
            Err(e) => {
                log::warn!(target: "node", "bridge fetch: {e}");
                respond(&stream, 200, serde_json::json!({ "ok": false, "error": e }))
            }
        };
    }
    if publish {
        return match publish_any(home, &body) {
            Ok((oid, false)) => respond(&stream, 200, serde_json::json!({ "ok": true, "oid": oid })),
            Ok((oid, true)) => respond(&stream, 200, serde_json::json!({ "ok": true, "oid": oid, "unchanged": true })),
            Err(e) => {
                log::warn!(target: "node", "bridge publish: {e}");
                respond(&stream, 200, serde_json::json!({ "ok": false, "error": e }))
            }
        };
    }
    match parse_save(&body).and_then(|req| save_commit(home, &req)) {
        Ok(oid) => respond(&stream, 200, serde_json::json!({ "ok": true, "oid": oid })),
        Err(e) => {
            log::warn!(target: "node", "bridge save: {e}");
            respond(&stream, 200, serde_json::json!({ "ok": false, "error": e }))
        }
    }
}

/// POST /fetch { rid, seed }: fetch a seeded repo from `seed` now (the editor's "Refresh" of the GameModels proposals;
/// the node also fetches on its own when the seed announces). → the number of refs updated.
fn fetch_repo(home: &Home, body: &[u8]) -> Res<usize> {
    let v: serde_json::Value = serde_json::from_slice(body).map_err(err)?;
    let s = |k: &str| v[k].as_str().map(str::to_string).ok_or_else(|| format!("missing {k}"));
    let rid = rid(&s("rid")?)?;
    if !home.policies_mut().map_err(err)?.is_seeding(&rid).map_err(err)? {
        return Err(format!("{rid} is not seeded by this node"));
    }
    let from = NodeId::from_str(&s("seed")?).map_err(err)?;
    let mut node = Node::new(home.socket_from_env());
    match node.fetch(rid, from, Duration::from_secs(45), None).map_err(err)? {
        FetchResult::Success { updated, .. } => Ok(updated.len()),
        FetchResult::Failed { reason } => Err(format!("fetch {rid} from {from}: {reason}")),
    }
}

fn parse_save(body: &[u8]) -> Res<SaveRequest> {
    let v: serde_json::Value = serde_json::from_slice(body).map_err(err)?;
    let s = |k: &str| v[k].as_str().map(str::to_string).ok_or_else(|| format!("missing {k}"));
    Ok(SaveRequest {
        rid: s("rid")?,
        git_ref: s("ref")?,
        parent: v["parent"].as_str().map(str::to_string),
        content: s("content")?.into_bytes(),
        name: s("name")?,
        email: s("email")?,
        timestamp: v["timestamp"].as_i64().ok_or("missing timestamp")?,
        message: s("message")?,
        expect: s("expect")?,
        seed: s("seed")?,
    })
}

// ---- dimension branches (chaosD6-Dimensions, POST /publish) ----

/// One dimension publish: a whole-branch snapshot of ActiveDimensions/<Name>/…
/// on refs/heads/ActiveDimensions/<Name>, built on our own namespace's tip.
struct PublishRequest {
    rid: String,
    /// refs/heads/ActiveDimensions/<Name>.
    git_ref: String,
    /// Repo-relative path → exact file bytes (UTF-8 from JSON).
    files: Vec<(String, Vec<u8>)>,
    /// Paths (files or directories) to drop from the base tree.
    remove: Vec<String>,
    /// e.g. "ActiveDimensions/": every entry of that directory except <Name> is dropped.
    prune_prefix: Option<String>,
    name: String,
    email: String,
    timestamp: i64,
    message: String,
    /// Delegate seed to fetch the repo from when it isn't local yet.
    seed: String,
}

/// POST /publish: `mode` absent / "snapshot" → a dimension snapshot,
/// "definition" → one definition on a players/ branch.
fn publish_any(home: &Home, body: &[u8]) -> Res<(String, bool)> {
    let v: serde_json::Value = serde_json::from_slice(body).map_err(err)?;
    match v.get("mode").and_then(|m| m.as_str()) {
        Some("definition") => parse_definition(&v).and_then(|req| definition_commit(home, &req)),
        None | Some("snapshot") => parse_publish(&v).and_then(|req| publish_commit(home, &req)),
        Some(m) => Err(format!("unknown publish mode {m:?}")),
    }
}

fn parse_publish(v: &serde_json::Value) -> Res<PublishRequest> {
    use serde_json::Value;
    let s =|k: &str| v[k].as_str().map(str::to_string).ok_or_else(|| format!("missing {k}"));
    let files = v["files"].as_object().ok_or("missing files")?.iter()
        .map(|(p, c)| c.as_str().map(|c| (p.clone(), c.as_bytes().to_vec())).ok_or_else(|| format!("files[{p}] is not a string")))
        .collect::<Res<Vec<_>>>()?;
    let remove = match &v["remove"] {
        Value::Null => Vec::new(),
        Value::Array(a) => a.iter().map(|p| p.as_str().map(str::to_string).ok_or_else(|| "remove holds a non-string".to_string())).collect::<Res<_>>()?,
        _ => return Err("remove must be an array".into()),
    };
    let prune_prefix = match &v["prune_prefix"] {
        Value::Null => None,
        Value::String(p) if p.is_empty() => None,
        Value::String(p) => Some(p.clone()),
        _ => return Err("prune_prefix must be a string".into()),
    };
    Ok(PublishRequest {
        rid: s("rid")?,
        git_ref: s("ref")?,
        files,
        remove,
        prune_prefix,
        name: s("name")?,
        email: s("email")?,
        timestamp: v["timestamp"].as_i64().ok_or("missing timestamp")?,
        message: s("message")?,
        seed: s("seed")?,
    })
}

/// The one directory a snapshot publish owns: refs/heads/ActiveDimensions/<Name> → "ActiveDimensions/<Name>";
/// refs/heads/votes/<me> → "votes" (game/proposal-votes-publish.mjs publishRepoBridge: all my votes, nothing else) —
/// only my own vote branch.
fn snapshot_dir(git_ref: &str, me: &str) -> Res<String> {
    match git_ref.strip_prefix(VOTES_REF_PREFIX) {
        Some(voter) if voter == me => Ok(VOTES_DIR.to_string()),
        Some(_) => Err(format!("refusing {git_ref} (votes go on {VOTES_REF_PREFIX}{me})")),
        None => Ok(format!("{DIMENSIONS_DIR}/{}", dimension_name(git_ref)?)),
    }
}

/// refs/heads/ActiveDimensions/<Name> → <Name>, if a valid git ref name.
fn dimension_name(git_ref: &str) -> Res<&str> {
    match git_ref.strip_prefix(DIMENSIONS_REF_PREFIX) {
        Some(name) if !name.is_empty() && git2::Reference::is_valid_name(git_ref) => Ok(name),
        _ => Err(format!("refusing {git_ref}")),
    }
}

/// Relative, no "..", no empty / "." segments, no NUL.
fn check_rel_path(p: &str) -> Res<()> {
    if p.is_empty() || p.starts_with('/') || p.contains("..") || p.contains('\0') || p.split('/').any(|s| s.is_empty() || s == ".") {
        return Err(format!("bad path {p:?}"));
    }
    Ok(())
}

/// A file/remove path: under `prefix` ("ActiveDimensions/<Name>/") and well-formed.
fn check_path(p: &str, prefix: &str) -> Res<()> {
    check_rel_path(p)?;
    if !p.starts_with(prefix) {
        return Err(format!("path {p:?} is outside {prefix}"));
    }
    Ok(())
}

/// One tree entry while a publish rewrites the tree: untouched subtrees stay
/// `Leaf`s (oid + mode) and are only expanded when a path goes through them.
enum TNode {
    Leaf(git2::Oid, i32),
    Dir(Dir),
}
type Dir = std::collections::BTreeMap<String, TNode>;
const MODE_TREE: i32 = 0o040000;
const MODE_BLOB: i32 = 0o100644;

fn expand(repo: &git2::Repository, oid: git2::Oid) -> Res<Dir> {
    let tree = repo.find_tree(oid).map_err(err)?;
    tree.iter().map(|e| {
        let name = e.name().map_err(|_| format!("non-UTF-8 entry name in tree {oid}"))?.to_string();
        Ok((name, TNode::Leaf(e.id(), e.filemode())))
    }).collect()
}

impl TNode {
    /// This entry as a directory: expands a subtree; a file becomes an empty
    /// directory if `create`, else None.
    fn as_dir(&mut self, repo: &git2::Repository, create: bool) -> Res<Option<&mut Dir>> {
        if let TNode::Leaf(oid, mode) = *self {
            if mode == MODE_TREE {
                *self = TNode::Dir(expand(repo, oid)?);
            } else if create {
                *self = TNode::Dir(Dir::new());
            } else {
                return Ok(None);
            }
        }
        match self {
            TNode::Dir(d) => Ok(Some(d)),
            TNode::Leaf(..) => unreachable!(),
        }
    }
}

/// The directory at `segs` below `dir` (created on the way if `create`).
fn subdir<'a>(repo: &git2::Repository, dir: &'a mut Dir, segs: &[&str], create: bool) -> Res<Option<&'a mut Dir>> {
    let Some((first, rest)) = segs.split_first() else { return Ok(Some(dir)) };
    if !create && !dir.contains_key(*first) {
        return Ok(None);
    }
    let node = dir.entry(first.to_string()).or_insert_with(|| TNode::Dir(Dir::new()));
    match node.as_dir(repo, create)? {
        Some(d) => subdir(repo, d, rest, create),
        None => Ok(None),
    }
}

/// Writes `dir` as nested trees, one TreeBuilder per directory; empty
/// directories are dropped (None).
fn write_dir(repo: &git2::Repository, dir: &Dir) -> Res<Option<git2::Oid>> {
    let mut tb = repo.treebuilder(None).map_err(err)?;
    for (name, node) in dir {
        let (oid, mode) = match node {
            TNode::Leaf(oid, mode) => (*oid, *mode),
            TNode::Dir(d) => match write_dir(repo, d)? {
                Some(oid) => (oid, MODE_TREE),
                None => continue,
            },
        };
        tb.insert(name, oid, mode).map_err(err)?;
    }
    if tb.len() == 0 {
        return Ok(None);
    }
    tb.write().map(Some).map_err(err)
}

fn empty_tree(repo: &git2::Repository) -> Res<git2::Oid> {
    repo.treebuilder(None).and_then(|tb| tb.write()).map_err(err)
}

/// base tree → prune (every entry of `prune` except the one leading to `keep`)
/// → `remove` → `files`. Paths must already be validated. Returns the new root tree.
fn build_tree(repo: &git2::Repository, base: Option<git2::Oid>, keep: &str, prune: Option<&str>, remove: &[String], files: &[(String, Vec<u8>)]) -> Res<git2::Oid> {
    let mut root = match base {
        Some(t) => expand(repo, t)?,
        None => Dir::new(),
    };
    if let Some(prune) = prune {
        let segs: Vec<&str> = prune.split('/').collect();
        let kept = keep.strip_prefix(prune).and_then(|r| r.strip_prefix('/')).and_then(|r| r.split('/').next());
        if let Some(d) = subdir(repo, &mut root, &segs, false)? {
            d.retain(|name, _| Some(name.as_str()) == kept);
        }
    }
    for p in remove {
        let segs: Vec<&str> = p.split('/').collect();
        let (last, parent) = segs.split_last().expect("validated path");
        if let Some(d) = subdir(repo, &mut root, parent, false)? {
            d.remove(*last);
        }
    }
    for (p, content) in files {
        let segs: Vec<&str> = p.split('/').collect();
        let (last, parent) = segs.split_last().expect("validated path");
        let blob = repo.blob(content).map_err(err)?;
        let d = subdir(repo, &mut root, parent, true)?.expect("created");
        d.insert(last.to_string(), TNode::Leaf(blob, MODE_BLOB));
    }
    match write_dir(repo, &root)? {
        Some(t) => Ok(t),
        None => empty_tree(repo),
    }
}

/// Commit `req` on `req.git_ref` in our own namespace (parent = our current tip
/// there, if any), sign refs, announce. Returns (oid, unchanged).
fn publish_commit(home: &Home, req: &PublishRequest) -> Res<(String, bool)> {
    let rid = rid(&req.rid)?;
    let keep = snapshot_dir(&req.git_ref, &NodeId::from(*signing_key(home)?.public_key()).to_string())?;
    let prefix = format!("{keep}/");
    for p in req.files.iter().map(|(p, _)| p).chain(&req.remove) {
        check_path(p, &prefix)?;
    }
    let prune = req.prune_prefix.as_deref().map(|p| {
        let p = p.trim_end_matches('/');
        check_rel_path(p).map(|()| p)
    }).transpose()?;
    if !home.policies_mut().map_err(err)?.is_seeding(&rid).map_err(err)? {
        return Err(format!("{rid} is not seeded by this node"));
    }
    let signer = signing_key(home)?;
    let me = NodeId::from(*signer.public_key());
    let config = Config::load(&home.config()).map_err(err)?;
    let storage = Storage::open(home.storage(), UserInfo { alias: config.node.alias.clone(), key: me }).map_err(err)?;
    let mut node = Node::new(home.socket_from_env());

    if !storage.contains(&rid).map_err(err)? {
        let from = NodeId::from_str(&req.seed).map_err(err)?;
        if let FetchResult::Failed { reason } = node.fetch(rid, from, Duration::from_secs(45), None).map_err(err)? {
            return Err(format!("fetch {rid} from {from}: {reason}"));
        }
        if !storage.contains(&rid).map_err(err)? {
            return Err(format!("{rid} not replicated from {from} yet"));
        }
    }

    let repo = storage.repository_mut(rid).map_err(err)?;
    let raw = &repo.backend;
    let nsref = format!("refs/namespaces/{me}/{}", req.git_ref);
    let tip = match raw.find_reference(&nsref) {
        Ok(r) => Some(r.peel_to_commit().map_err(err)?),
        Err(e) if e.code() == git2::ErrorCode::NotFound => None,
        Err(e) => return Err(err(e)),
    };
    let base = tip.as_ref().map(|c| c.tree_id());
    let tree_id = build_tree(raw, base, &keep, prune, &req.remove, &req.files)?;
    if tree_id == base.map_or_else(|| empty_tree(raw), Ok)? {
        return match &tip {
            Some(c) => Ok((c.id().to_string(), true)),
            None => Err(format!("nothing to publish on {}", req.git_ref)),
        };
    }
    let tree = raw.find_tree(tree_id).map_err(err)?;
    let sig = git2::Signature::new(&req.name, &req.email, &git2::Time::new(req.timestamp, 0)).map_err(err)?;
    let parents: Vec<&git2::Commit> = tip.iter().collect();
    let oid = raw.commit(None, &sig, &sig, &req.message, &tree, &parents).map_err(err)?;
    raw.reference(&nsref, oid, true, "chaosD6 dimension publish").map_err(err)?;
    repo.sign_refs(&signer).map_err(err)?;
    if let Err(e) = node.announce_refs_for(rid, [me]) {
        log::warn!(target: "node", "announce {rid} after publish: {e}");
    }
    log::info!(target: "node", "dimension {} → {oid} (parent {})", req.git_ref, tip.as_ref().map_or("none".into(), |c| c.id().to_string()));
    Ok((oid.to_string(), false))
}

// ---- definition branches (chaosD6-Skills / -Effects / -Classes, POST /publish mode "definition") ----

/// index.json[key][id] = sha256, as game/editor-publish.mjs commitGit rewrites the manifest.
struct ManifestUpdate {
    key: String,
    id: String,
    sha256: String,
}

/// One new definition (game/editor-publish.mjs publishBridge) on a players/ branch.
struct DefinitionRequest {
    rid: String,
    /// refs/heads/players/<team-slug>/<slug>.
    git_ref: String,
    /// The canonical branch the definition builds on (refs/heads/main).
    base: String,
    /// <subdir>/<id>.json → exact file bytes.
    files: Vec<(String, Vec<u8>)>,
    /// index.json entries, applied in order (one per definition of a GameModels bundle).
    manifest: Vec<ManifestUpdate>,
    name: String,
    email: String,
    timestamp: i64,
    /// Subject, body and trailers, verbatim (`git commit-tree -F -` does no cleanup either).
    message: String,
    /// Delegate seed to fetch the repo from when it isn't local yet.
    seed: String,
}

fn parse_definition(v: &serde_json::Value) -> Res<DefinitionRequest> {
    use serde_json::Value;
    let s = |k: &str| v[k].as_str().map(str::to_string).ok_or_else(|| format!("missing {k}"));
    let files = v["files"].as_object().ok_or("missing files")?.iter()
        .map(|(p, c)| c.as_str().map(|c| (p.clone(), c.as_bytes().to_vec())).ok_or_else(|| format!("files[{p}] is not a string")))
        .collect::<Res<Vec<_>>>()?;
    match &v["remove"] {
        Value::Null => {}
        Value::Array(a) if a.is_empty() => {}
        _ => return Err("a definition publish removes nothing (remove must be empty)".into()),
    }
    let entry = |m: &Value| -> Res<ManifestUpdate> {
        if !m.is_object() {
            return Err("a manifest entry must be an object".into());
        }
        let f = |k: &str| m[k].as_str().map(str::to_string).ok_or_else(|| format!("missing manifest.{k}"));
        if m["file"].as_str().unwrap_or(DEFS_MANIFEST) != DEFS_MANIFEST {
            return Err(format!("manifest.file must be {DEFS_MANIFEST}"));
        }
        Ok(ManifestUpdate { key: f("key")?, id: f("id")?, sha256: f("sha256")? })
    };
    let manifest = match &v["manifest"] {
        Value::Null => Vec::new(),
        m @ Value::Object(_) => vec![entry(m)?],
        Value::Array(a) => a.iter().map(entry).collect::<Res<_>>()?,
        _ => return Err("manifest must be an object or an array".into()),
    };
    Ok(DefinitionRequest {
        rid: s("rid")?,
        git_ref: s("ref")?,
        base: s("base")?,
        files,
        manifest,
        name: s("name")?,
        email: s("email")?,
        timestamp: v["timestamp"].as_i64().ok_or("missing timestamp")?,
        message: s("message")?,
        seed: s("seed")?,
    })
}

/// ^refs/heads/players/[A-Za-z0-9][A-Za-z0-9_-]{0,39}/[a-z0-9][a-z0-9-]{0,63}$
fn players_ref_ok(git_ref: &str) -> bool {
    let Some((team, slug)) = git_ref.strip_prefix(PLAYERS_REF_PREFIX).and_then(|r| r.split_once('/')) else { return false };
    let (t, s) = (team.as_bytes(), slug.as_bytes());
    (1..=40).contains(&t.len()) && t[0].is_ascii_alphanumeric() && t.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
        && (1..=64).contains(&s.len()) && (s[0].is_ascii_lowercase() || s[0].is_ascii_digit())
        && s.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// A canonical branch to build on: refs/heads/<name>, never a players/ branch.
fn base_ref_ok(base: &str) -> bool {
    base.strip_prefix("refs/heads/").is_some_and(|n| !n.is_empty() && !n.starts_with("players/")) && git2::Reference::is_valid_name(base)
}

/// <skills|effects|classes>/<name>.json, one level deep.
fn def_path_ok(p: &str) -> bool {
    let Some((dir, file)) = p.split_once('/') else { return false };
    check_rel_path(p).is_ok() && DEFS_DIRS.contains(&dir) && file.len() > 5 && file.ends_with(".json") && !file.starts_with('.')
        && file.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
}

fn check_definition(req: &DefinitionRequest) -> Res<()> {
    if !players_ref_ok(&req.git_ref) {
        return Err(format!("refusing {} (a definition goes on refs/heads/players/<team>/<slug>)", req.git_ref));
    }
    if !base_ref_ok(&req.base) {
        return Err(format!("refusing base {}", req.base));
    }
    if req.files.is_empty() || req.files.len() > DEFS_MAX_FILES {
        return Err(format!("a definition publish holds 1..={DEFS_MAX_FILES} files"));
    }
    for (p, content) in &req.files {
        let manifest_file = p == DEFS_MANIFEST && req.manifest.is_empty();
        if !manifest_file && !def_path_ok(p) {
            return Err(format!("path {p:?} is outside {}/<id>.json", DEFS_DIRS.join("|")));
        }
        if content.len() > DEFS_FILE_MAX {
            return Err(format!("{p} is larger than {DEFS_FILE_MAX} bytes"));
        }
    }
    if req.manifest.len() > DEFS_MAX_FILES {
        return Err(format!("at most {DEFS_MAX_FILES} manifest entries"));
    }
    for m in &req.manifest {
        let id_ok = (1..=80).contains(&m.id.len()) && m.id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_');
        let sha_ok = m.sha256.len() == 64 && m.sha256.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
        if !DEFS_DIRS.contains(&m.key.as_str()) || !id_ok || !sha_ok {
            return Err(format!("bad manifest entry {}[{}] = {}", m.key, m.id, m.sha256));
        }
        let file = format!("{}/{}.json", m.key, m.id);
        if !req.files.iter().any(|(p, _)| *p == file) {
            return Err(format!("manifest entry {}[{}] without {file}", m.key, m.id));
        }
    }
    Ok(())
}

// JSON.stringify(value, null, 2) of node/V8, byte for byte, for what JSON.parse can return.

/// A canonical array index ("0", "17"; < 2^32-1): JS objects list those first, ascending.
fn js_array_index(k: &str) -> Option<u32> {
    if k.is_empty() || (k.len() > 1 && k.starts_with('0')) || !k.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    k.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

/// Number.prototype.toString: shortest round-trip digits, exponent outside 1e-7 < |x| < 1e21.
fn js_number(n: &serde_json::Number) -> String {
    const SAFE: u64 = 1 << 53;
    if let Some(u) = n.as_u64() && u <= SAFE {
        return u.to_string();
    }
    if let Some(i) = n.as_i64() && i.unsigned_abs() <= SAFE {
        return i.to_string();
    }
    let f = n.as_f64().unwrap_or(0.0);
    if f == 0.0 {
        return "0".into();
    }
    let e = format!("{f:e}");
    let exp: i32 = e.rsplit_once('e').and_then(|(_, x)| x.parse().ok()).unwrap_or(0);
    if (-6..21).contains(&exp) {
        format!("{f}")
    } else if exp > 0 {
        e.replace('e', "e+")
    } else {
        e
    }
}

fn js_write(out: &mut String, v: &serde_json::Value, depth: usize) {
    use serde_json::Value;
    let pad = |out: &mut String, d: usize| out.extend(std::iter::repeat_n("  ", d));
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number(n)),
        // serde_json escapes exactly JSON.stringify's set: " \ \b \f \n \r \t, other C0 as \u00xx.
        Value::String(s) => out.push_str(&serde_json::to_string(s).expect("string")),
        Value::Array(a) if a.is_empty() => out.push_str("[]"),
        Value::Object(o) if o.is_empty() => out.push_str("{}"),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                out.push_str(if i == 0 { "\n" } else { ",\n" });
                pad(out, depth + 1);
                js_write(out, x, depth + 1);
            }
            out.push('\n');
            pad(out, depth);
            out.push(']');
        }
        Value::Object(o) => {
            let mut idx: Vec<(u32, &String, &Value)> = o.iter().filter_map(|(k, x)| js_array_index(k).map(|n| (n, k, x))).collect();
            idx.sort_by_key(|(n, ..)| *n);
            let named = o.iter().filter(|(k, _)| js_array_index(k).is_none());
            out.push('{');
            for (i, (k, x)) in idx.into_iter().map(|(_, k, x)| (k, x)).chain(named).enumerate() {
                out.push_str(if i == 0 { "\n" } else { ",\n" });
                pad(out, depth + 1);
                out.push_str(&serde_json::to_string(k).expect("key"));
                out.push_str(": ");
                js_write(out, x, depth + 1);
            }
            out.push('\n');
            pad(out, depth);
            out.push('}');
        }
    }
}

fn js_pretty(v: &serde_json::Value) -> String {
    let mut out = String::new();
    js_write(&mut out, v, 0);
    out
}

/// commitGit's manifest rewrite: `manifest[key] = sorted({ ...manifest[key], [id]: sha256 })`, the rest of index.json
/// kept in order, written as JSON.stringify(manifest, null, 2) + "\n". None (index.json left alone) when the old text
/// is not JSON or not an object/array — exactly when the desktop skips it. A non-object manifest[key] counts as {}.
fn manifest_update(old: &[u8], m: &ManifestUpdate) -> Option<Vec<u8>> {
    use serde_json::{Map, Value};
    let mut v: Value = serde_json::from_slice(old).ok()?;
    match &mut v {
        Value::Object(o) => {
            let mut map = match o.get(&m.key) {
                Some(Value::Object(x)) => x.clone(),
                _ => Map::new(),
            };
            map.insert(m.id.clone(), Value::String(m.sha256.clone()));
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));   // Array.prototype.sort on strings
            let sorted: Map<String, Value> = keys.into_iter().map(|k| (k.clone(), map[k].clone())).collect();
            o.insert(m.key.clone(), Value::Object(sorted));
        }
        // JSON.stringify drops the named property set on an array: the array is only re-printed.
        Value::Array(_) => {}
        _ => return None,
    }
    Some(format!("{}\n", js_pretty(&v)).into_bytes())
}

/// What git does to GIT_AUTHOR_NAME / _EMAIL (ident.c strbuf_addstr_without_crud): trim "crud" at both ends, drop
/// '\n' '<' '>' inside.
fn git_ident(s: &str) -> String {
    let crud = |c: char| (c as u32) <= 32 || ".,:;<>\"\\'".contains(c);
    s.trim_matches(crud).chars().filter(|c| !matches!(c, '\n' | '<' | '>')).collect()
}

/// The commit commitGit (game/editor-publish.mjs) makes: tree = `main`'s tree + `files` + the manifest rewrite;
/// parent = `tip` (+ `main` when main is not in tip's history), else `main`; author = committer = name/email at
/// timestamp +0000. `tip` whose tree already is that tree → (tip, true): no empty commit.
fn definition_tree_commit(raw: &git2::Repository, main: git2::Oid, tip: Option<&git2::Commit>, req: &DefinitionRequest) -> Res<(git2::Oid, bool)> {
    let main_c = raw.find_commit(main).map_err(err)?;
    let main_tree = main_c.tree().map_err(err)?;
    let mut files = req.files.clone();
    if !req.manifest.is_empty() {
        let old = main_tree.get_path(Path::new(DEFS_MANIFEST)).ok()
            .filter(|e| e.kind() == Some(git2::ObjectType::Blob))
            .and_then(|e| raw.find_blob(e.id()).ok())
            .map(|b| b.content().to_vec());
        // commitGit sets every entry on the parsed manifest, then stringifies once; re-parsing our own output between
        // entries gives the same bytes (key order kept, numbers / strings round-trip).
        let mut text = old;
        for m in &req.manifest {
            text = text.and_then(|o| manifest_update(&o, m));
        }
        if let Some(text) = text {
            files.retain(|(p, _)| p != DEFS_MANIFEST);
            files.push((DEFS_MANIFEST.to_string(), text));
        }
    }
    let tree_id = build_tree(raw, Some(main_tree.id()), "", None, &[], &files)?;
    if let Some(t) = tip && t.tree_id() == tree_id {
        return Ok((t.id(), true));
    }
    let mut parents: Vec<git2::Commit> = Vec::new();
    match tip {
        Some(t) => {
            parents.push(t.clone());
            if t.id() != main && !raw.graph_descendant_of(t.id(), main).map_err(err)? {
                parents.push(main_c.clone());
            }
        }
        None => parents.push(main_c.clone()),
    }
    let sig = git2::Signature::new(&git_ident(&req.name), &git_ident(&req.email), &git2::Time::new(req.timestamp, 0)).map_err(err)?;
    let tree = raw.find_tree(tree_id).map_err(err)?;
    let refs: Vec<&git2::Commit> = parents.iter().collect();
    let oid = raw.commit(None, &sig, &sig, &req.message, &tree, &refs).map_err(err)?;
    Ok((oid, false))
}

/// `base` in local storage: the canonical ref the node keeps (what `git fetch rad://<rid> main` reads on a desktop),
/// else — not written yet — the delegates' quorum for the identity's default branch.
fn base_oid(repo: &radicle::storage::git::Repository, base: &str) -> Res<Option<git2::Oid>> {
    match repo.backend.refname_to_id(base) {
        Ok(oid) => return Ok(Some(oid)),
        Err(e) if e.code() == git2::ErrorCode::NotFound => {}
        Err(e) => return Err(err(e)),
    }
    Ok(match repo.canonical_head() {
        Ok((name, oid)) if name.as_str() == base => Some(oid.into()),
        _ => None,
    })
}

/// Commit `req` on `req.git_ref` in our own namespace (see definition_tree_commit), sign refs, announce (also when
/// unchanged, so a retry re-announces). Returns (oid, unchanged).
fn definition_commit(home: &Home, req: &DefinitionRequest) -> Res<(String, bool)> {
    check_definition(req)?;
    let rid = rid(&req.rid)?;
    if !home.policies_mut().map_err(err)?.is_seeding(&rid).map_err(err)? {
        return Err(format!("{rid} is not seeded by this node (RadicleBoot.gd seeds chaosD6-Skills / -Effects / -Classes / -GameModels)"));
    }
    let signer = signing_key(home)?;
    let me = NodeId::from(*signer.public_key());
    let config = Config::load(&home.config()).map_err(err)?;
    let storage = Storage::open(home.storage(), UserInfo { alias: config.node.alias.clone(), key: me }).map_err(err)?;
    let mut node = Node::new(home.socket_from_env());

    let main_of = |s: &Storage| -> Res<Option<git2::Oid>> {
        if !s.contains(&rid).map_err(err)? {
            return Ok(None);
        }
        base_oid(&s.repository(rid).map_err(err)?, &req.base)
    };
    let main = match main_of(&storage)? {
        Some(m) => m,
        None => {
            // Not replicated yet: the same fetch as the snapshot / save paths, then look again.
            let from = NodeId::from_str(&req.seed).map_err(err)?;
            if let FetchResult::Failed { reason } = node.fetch(rid, from, Duration::from_secs(45), None).map_err(err)? {
                return Err(format!("cannot read {} of {rid}: fetch from {from}: {reason}", req.base));
            }
            main_of(&storage)?.ok_or_else(|| format!("cannot read {} of {rid} (not replicated from {from} yet)", req.base))?
        }
    };

    let repo = storage.repository_mut(rid).map_err(err)?;
    let raw = &repo.backend;
    let nsref = format!("refs/namespaces/{me}/{}", req.git_ref);
    let tip = match raw.find_reference(&nsref) {
        Ok(r) => Some(r.peel_to_commit().map_err(err)?),
        Err(e) if e.code() == git2::ErrorCode::NotFound => None,
        Err(e) => return Err(err(e)),
    };
    let (oid, unchanged) = definition_tree_commit(raw, main, tip.as_ref(), req)?;
    if !unchanged {
        raw.reference(&nsref, oid, true, "chaosD6 definition publish").map_err(err)?;
        repo.sign_refs(&signer).map_err(err)?;
    }
    if let Err(e) = node.announce_refs_for(rid, [me]) {
        log::warn!(target: "node", "announce {rid} after definition publish: {e}");
    }
    log::info!(target: "node", "definition {} → {oid}{} (main {main})", req.git_ref, if unchanged { " (unchanged)" } else { "" });
    Ok((oid.to_string(), unchanged))
}

// ---- JNI glue: io.chaosd6.radicle.RadicleNative ----

fn jstr(env: &mut JNIEnv, s: &JString) -> Res<String> {
    env.get_string(s).map(Into::into).map_err(err)
}

fn reply(env: &mut JNIEnv, r: Res<String>) -> jstring {
    let s = r.unwrap_or_else(|e| {
        log::error!(target: "node", "{e}");
        format!("error: {e}")
    });
    env.new_string(s).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

/// Panics must not unwind across the JNI boundary.
fn guarded(f: impl FnOnce() -> Res<String>) -> Res<String> {
    init_logging();
    catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|_| Err("panicked (see logcat tag radicle-node)".into()))
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_chaosd6_radicle_RadicleNative_init<'l>(
    mut env: JNIEnv<'l>, _: JClass<'l>,
    home: JString<'l>, alias: JString<'l>, config: JString<'l>, rid: JString<'l>, follow: JString<'l>, identity: JString<'l>,
) -> jstring {
    let r = (|| {
        let (h, a, c, r, f, i) = (jstr(&mut env, &home)?, jstr(&mut env, &alias)?, jstr(&mut env, &config)?, jstr(&mut env, &rid)?, jstr(&mut env, &follow)?, jstr(&mut env, &identity)?);
        guarded(|| init(&h, &a, &c, &r, &f, &i))
    })();
    reply(&mut env, r)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_chaosd6_radicle_RadicleNative_run<'l>(
    mut env: JNIEnv<'l>, _: JClass<'l>, home: JString<'l>,
) -> jstring {
    let r = jstr(&mut env, &home).and_then(|h| guarded(|| run(&h)));
    reply(&mut env, r)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_chaosd6_radicle_RadicleNative_stop<'l>(
    mut env: JNIEnv<'l>, _: JClass<'l>,
) -> jstring {
    let r = guarded(stop);
    reply(&mut env, r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pem_roundtrip() {
        let seed: [u8; 32] = core::array::from_fn(|i| i as u8 * 7);
        let mut der = PKCS8_ED25519_PREFIX.to_vec();
        der.extend_from_slice(&seed);
        let pem = format!("-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n", b64_encode(&der));
        assert_eq!(seed_from_pem(&pem).unwrap(), seed);
    }

    /// profile-sync.mjs builds this commit with isomorphic-git; the node must
    /// produce the same oid. CHAOSD6_ISOGIT_OID / CHAOSD6_ISOGIT_PARENT come
    /// from game/tools/profile-p2p-check.mjs (see there).
    #[test]
    fn commit_matches_isomorphic_git() {
        let Ok(expect) = std::env::var("CHAOSD6_ISOGIT_OID") else { return };
        let dir = std::env::temp_dir().join(format!("ffi-commit-{}", std::process::id()));
        let raw = git2::Repository::init_bare(&dir).unwrap();
        let content = std::env::var("CHAOSD6_ISOGIT_CONTENT").unwrap();
        let mut tb = raw.treebuilder(None).unwrap();
        tb.insert(PROFILE_FILE, raw.blob(content.as_bytes()).unwrap(), 0o100644).unwrap();
        let tree = raw.find_tree(tb.write().unwrap()).unwrap();
        let ts: i64 = std::env::var("CHAOSD6_ISOGIT_TS").unwrap().parse().unwrap();
        let id = std::env::var("CHAOSD6_ISOGIT_ID").unwrap();
        // identity.pem as node:crypto writes it → the same id as the radicle NID.
        let pem = std::fs::read_to_string(std::env::var("CHAOSD6_ISOGIT_PEM").unwrap()).unwrap();
        let nid = NodeId::from(*SigningKey::from_seed(Seed::new(seed_from_pem(&pem).unwrap())).public_key());
        assert_eq!(nid.to_string(), id);
        let sig = git2::Signature::new(&id[..16], &format!("{id}@profiles.chaosd6"), &git2::Time::new(ts, 0)).unwrap();
        let oid = raw.commit(None, &sig, &sig, "profile\n", &tree, &[]).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(oid.to_string(), expect);
    }

    #[test]
    fn rid_lists() {
        let rids = rid_list(" rad:z4Y11mZyhHRbkHMGN98w5gPwTWTFH, z2xbfJfwT3kukR73m8LXmmuvchEwr,").unwrap();
        assert_eq!(rids.iter().map(|r| r.to_string()).collect::<Vec<_>>(),
            ["rad:z4Y11mZyhHRbkHMGN98w5gPwTWTFH", "rad:z2xbfJfwT3kukR73m8LXmmuvchEwr"]);
        assert!(rid_list("rad:nope").is_err());
    }

    #[test]
    fn publish_paths() {
        assert_eq!(dimension_name("refs/heads/ActiveDimensions/Moon_Guard-1").unwrap(), "Moon_Guard-1");
        for bad in ["refs/heads/ActiveDimensions/", "refs/heads/ActiveDimensions/a..b", "refs/heads/ActiveDimensions/a b",
            "refs/heads/ActiveDimensions/x.lock", "refs/heads/teams/x", "refs/heads/ActiveDimensionsX"] {
            assert!(dimension_name(bad).is_err(), "{bad}");
        }
        let pre = "ActiveDimensions/Moon/";
        assert!(check_path("ActiveDimensions/Moon/dimension.json", pre).is_ok());
        assert!(check_path("ActiveDimensions/Moon/a/b/c.json", pre).is_ok());
        for bad in ["ActiveDimensions/Moon/", "ActiveDimensions/Moon//x", "/ActiveDimensions/Moon/x", "ActiveDimensions/Moon/../x",
            "ActiveDimensions/Moon/./x", "ActiveDimensions/Moon2/x", "ActiveDimensions/Sun/x", "README.md", "ActiveDimensions/Moon"] {
            assert!(check_path(bad, pre).is_err(), "{bad}");
        }
    }

    fn paths(repo: &git2::Repository, tree: git2::Oid) -> Vec<String> {
        let mut out = Vec::new();
        repo.find_tree(tree).unwrap().walk(git2::TreeWalkMode::PreOrder, |dir, e| {
            if e.kind() == Some(git2::ObjectType::Blob) {
                let blob = repo.find_blob(e.id()).unwrap();
                out.push(format!("{dir}{}={}", e.name().unwrap(), String::from_utf8_lossy(blob.content())));
            }
            git2::TreeWalkResult::Ok
        }).unwrap();
        out.sort();
        out
    }

    #[test]
    fn nested_tree_builder() {
        let dir = std::env::temp_dir().join(format!("ffi-tree-{}", std::process::id()));
        let raw = git2::Repository::init_bare(&dir).unwrap();
        let f = |p: &str, c: &str| (p.to_string(), c.as_bytes().to_vec());
        let keep = "ActiveDimensions/Moon";
        let base = build_tree(&raw, None, keep, None, &[], &[
            f("README.md", "r"), f("ActiveDimensions/Sun/a.json", "sun"), f("ActiveDimensions/Moon/x.json", "x"),
            f("ActiveDimensions/Moon/sub/y.json", "y"), f("Other/z.json", "z"),
        ]).unwrap();
        assert_eq!(paths(&raw, base), ["ActiveDimensions/Moon/sub/y.json=y", "ActiveDimensions/Moon/x.json=x",
            "ActiveDimensions/Sun/a.json=sun", "Other/z.json=z", "README.md=r"]);
        // Same content as git would write: compare with a flat index-built tree.
        let mut idx = git2::Index::new().unwrap();
        for (p, c) in [("README.md", "r"), ("ActiveDimensions/Sun/a.json", "sun"), ("ActiveDimensions/Moon/x.json", "x"),
            ("ActiveDimensions/Moon/sub/y.json", "y"), ("Other/z.json", "z")] {
            let mut e = git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0), mtime: git2::IndexTime::new(0, 0), dev: 0, ino: 0, mode: 0o100644, uid: 0, gid: 0,
                file_size: c.len() as u32, id: raw.blob(c.as_bytes()).unwrap(), flags: 0, flags_extended: 0, path: p.as_bytes().to_vec(),
            };
            e.flags = p.len() as u16;
            idx.add(&e).unwrap();
        }
        assert_eq!(idx.write_tree_to(&raw).unwrap(), base);

        // Nothing to do → same tree id (publish reports unchanged).
        assert_eq!(build_tree(&raw, Some(base), keep, None, &[], &[]).unwrap(), base);
        assert_eq!(build_tree(&raw, Some(base), keep, None, &[], &[f("ActiveDimensions/Moon/x.json", "x")]).unwrap(), base);

        // prune other dimensions, remove a file (its dir empties and goes), add nested files, overwrite one.
        let next = build_tree(&raw, Some(base), keep, Some("ActiveDimensions"),
            &["ActiveDimensions/Moon/sub/y.json".into(), "ActiveDimensions/Moon/missing/q.json".into()],
            &[f("ActiveDimensions/Moon/deep/n/z.json", "deep"), f("ActiveDimensions/Moon/x.json", "x2")]).unwrap();
        assert_eq!(paths(&raw, next), ["ActiveDimensions/Moon/deep/n/z.json=deep", "ActiveDimensions/Moon/x.json=x2", "Other/z.json=z", "README.md=r"]);
        // Untouched sibling subtree keeps its oid.
        let sub = |t: git2::Oid, p: &str| raw.find_tree(t).unwrap().get_path(Path::new(p)).unwrap().id();
        assert_eq!(sub(base, "Other"), sub(next, "Other"));

        // Removing a whole directory; pruning when <Name> is absent drops every dimension.
        let gone = build_tree(&raw, Some(next), "ActiveDimensions/Star", Some("ActiveDimensions"), &[], &[]).unwrap();
        assert_eq!(paths(&raw, gone), ["Other/z.json=z", "README.md=r"]);
        let rm_dir = build_tree(&raw, Some(next), keep, None, &["ActiveDimensions/Moon/deep".into()], &[]).unwrap();
        assert_eq!(paths(&raw, rm_dir), ["ActiveDimensions/Moon/x.json=x2", "Other/z.json=z", "README.md=r"]);
        // A file where a directory is needed is replaced by the directory.
        let over = build_tree(&raw, Some(next), keep, None, &[], &[f("ActiveDimensions/Moon/x.json/inner", "i")]).unwrap();
        assert!(paths(&raw, over).contains(&"ActiveDimensions/Moon/x.json/inner=i".to_string()));
        std::fs::remove_dir_all(&dir).ok();
    }

    const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn def_req(files: &[(&str, &str)], manifest: Option<(&str, &str, &str)>) -> DefinitionRequest {
        DefinitionRequest {
            rid: "rad:z2L7U9KeYdiynSmeg9gNoE84BP3i5".into(),
            git_ref: "refs/heads/players/Gold-Team/ice-wall".into(),
            base: "refs/heads/main".into(),
            files: files.iter().map(|(p, c)| (p.to_string(), c.as_bytes().to_vec())).collect(),
            manifest: manifest.map(|(key, id, sha)| ManifestUpdate { key: key.into(), id: id.into(), sha256: sha.into() }).into_iter().collect(),
            name: "Gold Team".into(),
            email: "z6Mkexample@chaosd6".into(),
            timestamp: 1_790_000_000,
            message: "skill_ice_wall 0.1.0: Ice Wall\n\nChaosd6-Author: z6Mkexample\n".into(),
            seed: "z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT".into(),
        }
    }

    #[test]
    fn definition_refs_and_paths() {
        for ok in ["refs/heads/players/Gold-Team/ice-wall", "refs/heads/players/a/b", "refs/heads/players/T_1/9-x",
            &format!("refs/heads/players/{}/{}", "A".repeat(40), "a".repeat(64))] {
            assert!(players_ref_ok(ok), "{ok}");
        }
        for bad in ["refs/heads/main", "refs/heads/players/", "refs/heads/players/Gold", "refs/heads/players/Gold/", "refs/heads/players//x",
            "refs/heads/players/-Gold/x", "refs/heads/players/Gold/Ice", "refs/heads/players/Gold/-x", "refs/heads/players/Gold/a/b",
            "refs/heads/players/Go.ld/x", "refs/heads/players/Gold/x.lock", "refs/heads/players/Gold/a_b", "refs/heads/teams/Gold",
            "refs/heads/votes/x/y", &format!("refs/heads/players/{}/x", "A".repeat(41)), &format!("refs/heads/players/a/{}", "a".repeat(65))] {
            assert!(!players_ref_ok(bad), "{bad}");
        }
        assert!(base_ref_ok("refs/heads/main"));
        for bad in ["refs/heads/", "refs/heads/players/a/b", "main", "refs/tags/v1", "refs/heads/a..b"] {
            assert!(!base_ref_ok(bad), "{bad}");
        }
        for ok in ["skills/skill_ice_wall.json", "effects/effect_x.json", "classes/class_y-1.json"] {
            assert!(def_path_ok(ok), "{ok}");
        }
        for ok in ["npcs/npc_empire_bard.json", "villages/vil_empire.json", "races/race_empire.json", "quests/quest_x.json", "buildings/bld_x.json", "monsters/mon_x.json"] {
            assert!(def_path_ok(ok), "{ok}");
        }
        for bad in ["lib/x.json", "skills/a/b.json", "skills/.json", "skills/x.txt", "skills/../index.json", "README.md", "skills/", "index.json",
            "/skills/x.json", "skills/.hidden.json", "skills/a b.json"] {
            assert!(!def_path_ok(bad), "{bad}");
        }

        let good = def_req(&[("skills/skill_ice_wall.json", "{}\n")], Some(("skills", "skill_ice_wall", SHA_A)));
        assert!(check_definition(&good).is_ok());
        let refused = |r: DefinitionRequest| check_definition(&r).is_err();
        assert!(refused(DefinitionRequest { git_ref: "refs/heads/main".into(), ..def_req(&[("skills/a.json", "1")], None) }));
        assert!(refused(DefinitionRequest { base: "refs/heads/players/x/y".into(), ..def_req(&[("skills/a.json", "1")], None) }));
        assert!(refused(def_req(&[], None)));
        assert!(refused(def_req(&[("lib/a.json", "1")], None)));
        assert!(refused(def_req(&[("README.md", "1")], None)));
        assert!(refused(def_req(&[("skills/skill_ice_wall.json", "{}"), ("index.json", "{}")], Some(("skills", "skill_ice_wall", SHA_A)))));
        assert!(!refused(def_req(&[("skills/a.json", "1"), ("index.json", "{}")], None)));
        assert!(refused(def_req(&[("skills/skill_ice_wall.json", "{}")], Some(("lib", "skill_ice_wall", SHA_A)))));
        assert!(refused(def_req(&[("skills/skill_ice_wall.json", "{}")], Some(("skills", "skill_ice_wall", "abc")))));
        assert!(refused(def_req(&[("skills/skill_ice_wall.json", "{}")], Some(("skills", "Skill_Ice", SHA_A)))));
        assert!(refused(def_req(&[("skills/other.json", "{}")], Some(("skills", "skill_ice_wall", SHA_A)))));
        let big = "x".repeat(DEFS_FILE_MAX + 1);
        assert!(refused(def_req(&[("skills/a.json", &big)], None)));
        let many: Vec<(String, &str)> = (0..=DEFS_MAX_FILES).map(|i| (format!("skills/a{i}.json"), "1")).collect();
        assert!(refused(def_req(&many.iter().map(|(p, c)| (p.as_str(), *c)).collect::<Vec<_>>(), None)));

        // The request shape game/editor-publish.mjs publishBridge sends.
        let body = serde_json::json!({ "rid": "rad:z2L7U9KeYdiynSmeg9gNoE84BP3i5", "ref": "refs/heads/players/Gold-Team/ice-wall",
            "mode": "definition", "base": "refs/heads/main", "files": { "skills/skill_ice_wall.json": "{}\n" }, "remove": [],
            "manifest": { "file": "index.json", "key": "skills", "id": "skill_ice_wall", "sha256": SHA_A },
            "name": "Gold Team", "email": "z6Mk@chaosd6", "timestamp": 1_790_000_000, "message": "m\n", "seed": "z6Mk" });
        let r = parse_definition(&body).unwrap();
        assert_eq!((r.files.len(), r.manifest[0].id.as_str(), r.timestamp), (1, "skill_ice_wall", 1_790_000_000));
        let mut b2 = body.clone();
        b2["remove"] = serde_json::json!(["skills/x.json"]);
        assert!(parse_definition(&b2).is_err());
        b2["remove"] = serde_json::json!([]);
        b2["manifest"]["file"] = "other.json".into();
        assert!(parse_definition(&b2).is_err());
    }

    #[test]
    fn js_stringify() {
        // Expected strings are node's JSON.stringify(JSON.parse(text), null, 2).
        let p = |t: &str| js_pretty(&serde_json::from_str(t).unwrap());
        assert_eq!(p(r#"{"b":1,"a":[],"c":{},"d":[1,"x",null,true]}"#), "{\n  \"b\": 1,\n  \"a\": [],\n  \"c\": {},\n  \"d\": [\n    1,\n    \"x\",\n    null,\n    true\n  ]\n}");
        assert_eq!(p(r#"{"z":0,"10":1,"2":2,"01":3,"a":4}"#), "{\n  \"2\": 2,\n  \"10\": 1,\n  \"z\": 0,\n  \"01\": 3,\n  \"a\": 4\n}");
        assert_eq!(p(r#"["\u0001\"\\\n\t/é\u2028"]"#), "[\n  \"\\u0001\\\"\\\\\\n\\t/é\u{2028}\"\n]");
        assert_eq!(p("[1.0, -0.0, 0.1, 1.5e-7, 1e-6, 1e21, 123456789012345678901, 2.5e300, -3, 9007199254740993]"),
            "[\n  1,\n  0,\n  0.1,\n  1.5e-7,\n  0.000001,\n  1e+21,\n  123456789012345680000,\n  2.5e+300,\n  -3,\n  9007199254740992\n]");
    }

    #[test]
    fn manifest_rewrite() {
        let m = ManifestUpdate { key: "skills".into(), id: "skill_ice_wall".into(), sha256: SHA_A.into() };
        let old = format!("{{\n  \"format\": 1,\n  \"hash\": \"sha256(canonical-json)\",\n  \"skills\": {{\n    \"skill_zap\": \"{SHA_B}\",\n    \"skill_dodge\": \"{SHA_B}\"\n  }},\n  \"lib\": {{\n    \"b\": \"1\",\n    \"a\": \"2\"\n  }}\n}}\n");
        let new = String::from_utf8(manifest_update(old.as_bytes(), &m).unwrap()).unwrap();
        assert_eq!(new, format!("{{\n  \"format\": 1,\n  \"hash\": \"sha256(canonical-json)\",\n  \"skills\": {{\n    \"skill_dodge\": \"{SHA_B}\",\n    \"skill_ice_wall\": \"{SHA_A}\",\n    \"skill_zap\": \"{SHA_B}\"\n  }},\n  \"lib\": {{\n    \"b\": \"1\",\n    \"a\": \"2\"\n  }}\n}}\n"));
        // Missing map → appended at the end; existing id → overwritten.
        let new = String::from_utf8(manifest_update(b"{\"format\":1}", &m).unwrap()).unwrap();
        assert_eq!(new, format!("{{\n  \"format\": 1,\n  \"skills\": {{\n    \"skill_ice_wall\": \"{SHA_A}\"\n  }}\n}}\n"));
        let again = String::from_utf8(manifest_update(new.as_bytes(), &ManifestUpdate { sha256: SHA_B.into(), ..m }).unwrap()).unwrap();
        assert!(again.contains(SHA_B) && !again.contains(SHA_A));
        let m = ManifestUpdate { key: "skills".into(), id: "skill_ice_wall".into(), sha256: SHA_A.into() };
        for skip in ["not json", "null", "3", "\"s\""] {
            assert!(manifest_update(skip.as_bytes(), &m).is_none(), "{skip}");
        }
        assert_eq!(manifest_update(b"[1]", &m).unwrap(), b"[\n  1\n]\n");
        assert_eq!(git_ident(" Gold Team. "), "Gold Team");
        assert_eq!(git_ident("a<b>c"), "abc");
    }

    #[test]
    fn definition_commits() {
        let dir = std::env::temp_dir().join(format!("ffi-defs-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        let raw = git2::Repository::init_bare(&dir).unwrap();
        let f = |p: &str, c: &str| (p.to_string(), c.as_bytes().to_vec());
        let main_tree = build_tree(&raw, None, "", None, &[], &[f("README.md", "r"), f("skills/skill_dodge.json", "{}\n"),
            f("lib/x.json", "{}\n"), f("index.json", &format!("{{\"format\":1,\"skills\":{{\"skill_dodge\":\"{SHA_B}\"}}}}"))]).unwrap();
        let seed = git2::Signature::new("seed", "seed@x", &git2::Time::new(1, 0)).unwrap();
        let main = raw.commit(None, &seed, &seed, "main\n", &raw.find_tree(main_tree).unwrap(), &[]).unwrap();

        let req = def_req(&[("skills/skill_ice_wall.json", "{\n  \"id\": \"skill_ice_wall\"\n}\n")], Some(("skills", "skill_ice_wall", SHA_A)));
        let (c1, unchanged) = definition_tree_commit(&raw, main, None, &req).unwrap();
        assert!(!unchanged);
        let c1c = raw.find_commit(c1).unwrap();
        assert_eq!(c1c.parent_ids().collect::<Vec<_>>(), [main]);
        assert_eq!(paths(&raw, c1c.tree_id()), ["README.md=r", &format!("index.json={{\n  \"format\": 1,\n  \"skills\": {{\n    \"skill_dodge\": \"{SHA_B}\",\n    \"skill_ice_wall\": \"{SHA_A}\"\n  }}\n}}\n"),
            "lib/x.json={}\n", "skills/skill_dodge.json={}\n", "skills/skill_ice_wall.json={\n  \"id\": \"skill_ice_wall\"\n}\n"]);
        assert_eq!((c1c.author().name().ok(), c1c.author().email().ok(), c1c.author().when().seconds(), c1c.author().when().offset_minutes()),
            (Some("Gold Team"), Some("z6Mkexample@chaosd6"), 1_790_000_000, 0));
        assert_eq!(c1c.committer().name().ok(), Some("Gold Team"));
        assert_eq!(c1c.message_bytes(), req.message.as_bytes());
        // Same inputs → same oid (deterministic), and on top of an equal tip → unchanged.
        assert_eq!(definition_tree_commit(&raw, main, None, &req).unwrap(), (c1, false));
        assert_eq!(definition_tree_commit(&raw, main, Some(&c1c), &req).unwrap(), (c1, true));
        // New version → fast-forward on the tip only.
        let req2 = def_req(&[("skills/skill_ice_wall.json", "{\n  \"v\": 2\n}\n")], Some(("skills", "skill_ice_wall", SHA_B)));
        let (c2, _) = definition_tree_commit(&raw, main, Some(&c1c), &req2).unwrap();
        assert_eq!(raw.find_commit(c2).unwrap().parent_ids().collect::<Vec<_>>(), [c1]);
        // main moved → second parent main, tree built on the new main.
        let main2_tree = build_tree(&raw, Some(main_tree), "", None, &[], &[f("skills/skill_new.json", "n")]).unwrap();
        let main2 = raw.commit(None, &seed, &seed, "main 2\n", &raw.find_tree(main2_tree).unwrap(), &[&raw.find_commit(main).unwrap()]).unwrap();
        let (c3, _) = definition_tree_commit(&raw, main2, Some(&c1c), &req2).unwrap();
        let c3c = raw.find_commit(c3).unwrap();
        assert_eq!(c3c.parent_ids().collect::<Vec<_>>(), [c1, main2]);
        assert!(paths(&raw, c3c.tree_id()).contains(&"skills/skill_new.json=n".to_string()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gamemodels_bundles_votes_scopes() {
        // A GameModels NPC bundle: three files + three manifest entries in one commit, the array form of `manifest`.
        let body = serde_json::json!({ "rid": "rad:z48usa3nUHDWMc67TYwiFzL8DixbC", "ref": "refs/heads/players/sun-riders/npc-empire-bard",
            "mode": "definition", "base": "refs/heads/main", "remove": [],
            "files": { "npcs/npc_empire_bard.json": "{}\n", "villages/vil_empire.json": "{}\n", "races/race_empire.json": "{}\n" },
            "manifest": [{ "file": "index.json", "key": "npcs", "id": "npc_empire_bard", "sha256": SHA_A },
                { "file": "index.json", "key": "villages", "id": "vil_empire", "sha256": SHA_B },
                { "file": "index.json", "key": "races", "id": "race_empire", "sha256": SHA_A }],
            "name": "Sun Riders", "email": "z6Mk@chaosd6", "timestamp": 1_790_000_000, "message": "m\n", "seed": "z6Mk" });
        let req = parse_definition(&body).unwrap();
        assert_eq!(req.manifest.len(), 3);
        check_definition(&req).unwrap();
        let mut bad = body.clone();
        bad["manifest"][1]["id"] = "vil_other".into();
        assert!(check_definition(&parse_definition(&bad).unwrap()).is_err(), "an entry without its file");
        bad["manifest"] = serde_json::json!([1]);
        assert!(parse_definition(&bad).is_err());

        let dir = std::env::temp_dir().join(format!("ffi-gm-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        let raw = git2::Repository::init_bare(&dir).unwrap();
        let f = |p: &str, c: &str| (p.to_string(), c.as_bytes().to_vec());
        let main_tree = build_tree(&raw, None, "", None, &[], &[f("lib/agenda_x.json", "{}\n"),
            f("index.json", &format!("{{\"format\":1,\"races\":{{\"race_empire\":\"{SHA_B}\"}},\"npcs\":{{\"npc_z\":\"{SHA_B}\"}},\"villages\":{{}}}}"))]).unwrap();
        let sig = git2::Signature::new("seed", "seed@x", &git2::Time::new(1, 0)).unwrap();
        let main = raw.commit(None, &sig, &sig, "main\n", &raw.find_tree(main_tree).unwrap(), &[]).unwrap();
        let (c, _) = definition_tree_commit(&raw, main, None, &req).unwrap();
        let idx = paths(&raw, raw.find_commit(c).unwrap().tree_id()).into_iter().find(|p| p.starts_with("index.json=")).unwrap();
        assert_eq!(idx, format!("index.json={{\n  \"format\": 1,\n  \"races\": {{\n    \"race_empire\": \"{SHA_A}\"\n  }},\n  \"npcs\": {{\n    \"npc_empire_bard\": \"{SHA_A}\",\n    \"npc_z\": \"{SHA_B}\"\n  }},\n  \"villages\": {{\n    \"vil_empire\": \"{SHA_B}\"\n  }}\n}}\n"));
        std::fs::remove_dir_all(&dir).ok();

        // Votes: only my own branch, and the whole votes/ directory.
        let me = "z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT";
        assert_eq!(snapshot_dir(&format!("refs/heads/votes/{me}"), me).unwrap(), "votes");
        assert!(snapshot_dir("refs/heads/votes/z6MkOther", me).is_err());
        assert_eq!(snapshot_dir("refs/heads/ActiveDimensions/Ashfall", me).unwrap(), "ActiveDimensions/Ashfall");
        assert!(snapshot_dir("refs/heads/main", me).is_err());

        // Seeding scopes: "@all" only where asked.
        let s = rid_scopes("rad:z4Y11mZyhHRbkHMGN98w5gPwTWTFH, rad:z48usa3nUHDWMc67TYwiFzL8DixbC@all").unwrap();
        assert_eq!(s.iter().map(|(_, sc)| *sc == Scope::All).collect::<Vec<_>>(), [false, true]);
        assert_eq!(rid_list("rad:z48usa3nUHDWMc67TYwiFzL8DixbC@all").unwrap().len(), 1);
    }

    /// game/editor-publish.mjs commitGit (desktop git) and this node must give the same commit for the same
    /// definition. CHAOSD6_DEFS_CROSS = a JSON file written by a JS harness: { gitdir (bare repo holding main + the
    /// desktop commits), cases: [ { body (the bridge request publishBridge sent), main, tip|null, expect (desktop oid) } ] }.
    #[test]
    fn definition_matches_desktop_git() {
        let Ok(file) = std::env::var("CHAOSD6_DEFS_CROSS") else { return };
        let x: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
        let raw = git2::Repository::open_bare(x["gitdir"].as_str().unwrap()).unwrap();
        let cases = x["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for c in cases {
            let req = parse_definition(&c["body"]).unwrap();
            check_definition(&req).unwrap();
            let main = git2::Oid::from_str(c["main"].as_str().unwrap()).unwrap();
            let tip = c["tip"].as_str().map(|t| raw.find_commit(git2::Oid::from_str(t).unwrap()).unwrap());
            let (oid, _) = definition_tree_commit(&raw, main, tip.as_ref(), &req).unwrap();
            assert_eq!(oid.to_string(), c["expect"].as_str().unwrap(), "{}", req.git_ref);
        }
    }
}
