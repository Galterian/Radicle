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
/// the default Profile::init writes), seeds `rid` with scope `followed` and
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

    let mut policies = home.policies_mut().map_err(err)?;
    policies.seed(&rid(rid_s)?, Scope::Followed).map_err(err)?;
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
    start_bridge(home.clone())?;
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

/// Binds 127.0.0.1:<random>, writes { port, token } to RAD_HOME/bridge.json
/// (app-private), serves `POST /save` with a JSON SaveRequest.
fn start_bridge(home: Home) -> Res<()> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(err)?;
    let port = listener.local_addr().map_err(err)?.port();
    let mut raw = [0u8; 24];
    getrandom::fill(&mut raw).map_err(err)?;
    let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let file = home.path().join(BRIDGE_FILE);
    let tmp: PathBuf = home.path().join(format!("{BRIDGE_FILE}.tmp"));
    std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)
        .and_then(|mut f| f.write_all(serde_json::json!({ "port": port, "token": token }).to_string().as_bytes()))
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
    if !line.starts_with("POST /save ") || len == 0 || len > 1 << 20 {
        return respond(&stream, 404, serde_json::json!({ "ok": false, "error": "POST /save only" }));
    }
    let mut body = vec![0; len];
    if rd.read_exact(&mut body).is_err() {
        return respond(&stream, 400, serde_json::json!({ "ok": false, "error": "short body" }));
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
}
