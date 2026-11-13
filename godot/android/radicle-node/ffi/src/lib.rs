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
use radicle::storage::{ReadStorage as _, SignRepository as _, WriteStorage as _};
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
/// What the bridge serves (bridge.json `features`): POST /save, POST /publish.
const BRIDGE_FEATURES: [&str; 2] = ["save", "publish"];
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

/// "rad:a,rad:b" → [a, b] (blank items skipped).
fn rid_list(s: &str) -> Res<Vec<RepoId>> {
    s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(rid).collect()
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

    let rids = rid_list(rid_s)?;
    if rids.is_empty() {
        return Err("no rid to seed".into());
    }
    let mut policies = home.policies_mut().map_err(err)?;
    for r in &rids {
        policies.seed(r, Scope::Followed).map_err(err)?;
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
    let (publish, max) = if line.starts_with("POST /save ") {
        (false, SAVE_MAX)
    } else if line.starts_with("POST /publish ") {
        (true, PUBLISH_MAX)
    } else {
        return respond(&stream, 404, serde_json::json!({ "ok": false, "error": "POST /save or POST /publish only" }));
    };
    if len == 0 || len > max {
        return respond(&stream, 404, serde_json::json!({ "ok": false, "error": format!("body must be 1..={max} bytes") }));
    }
    let mut body = vec![0; len];
    if rd.read_exact(&mut body).is_err() {
        return respond(&stream, 400, serde_json::json!({ "ok": false, "error": "short body" }));
    }
    if publish {
        return match parse_publish(&body).and_then(|req| publish_commit(home, &req)) {
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

fn parse_publish(body: &[u8]) -> Res<PublishRequest> {
    use serde_json::Value;
    let v: Value = serde_json::from_slice(body).map_err(err)?;
    let s = |k: &str| v[k].as_str().map(str::to_string).ok_or_else(|| format!("missing {k}"));
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
    let name = dimension_name(&req.git_ref)?;
    let keep = format!("{DIMENSIONS_DIR}/{name}");
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
}
