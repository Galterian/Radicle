//! JNI surface of radicle-node for the chaosD6 Android app.
//!
//! The node runs *inside* RadicleNodeService (its own `:radicle` process)
//! instead of being exec()'d, so the APK only ships an ordinary `lib*.so` —
//! nothing Play's W^X / exec rules care about. `run()` mirrors radicle-node's
//! `main.rs` at the pinned heartwood tag minus CLI parsing, systemd and OS
//! signal handlers; `stop()` feeds `Signal::Terminate` into the runtime's
//! channel instead.
//!
//! `saveFile()` replaces `git push rad <branch>` (git send-pack +
//! git-remote-rad, neither of which exists on a phone): commit one file onto a
//! branch in our own namespace in storage, sign refs, announce. The phone only
//! ever touches that one branch.
//!
//! Every entry point returns a String; failures come back as "error: <msg>".

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::str::FromStr as _;
use std::sync::{Mutex, Once, mpsc};
use std::time::Duration;

use jni::JNIEnv;
use jni::objects::{JByteArray, JClass, JString};
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

/// First-run setup, safe to call on every start. Creates an unencrypted key if
/// there is none, writes `config_json` (the APK's template wins over the
/// default Profile::init writes), seeds `rid` with scope `followed` and follows
/// `follow` (the repo's delegate seed) so fetches pull the delegate's refs
/// plus ours — not every other player's namespace. Returns our NID.
fn init(home: &str, alias: &str, config_json: &str, rid_s: &str, follow: &str) -> Res<String> {
    let home = Home::new(home).map_err(err)?;
    if Keystore::new(&home.keys()).public_key().map_err(err)?.is_none() {
        let alias = Alias::from_str(alias).map_err(err)?;
        let mut seed = [0; Seed::BYTES];
        getrandom::fill(&mut seed).map_err(err)?;
        Profile::init(home.clone(), alias, None, Seed::new(seed)).map_err(err)?;
    }
    std::fs::write(home.config(), config_json).map_err(err)?;
    // Fail here with a readable error rather than inside run().
    Config::load(&home.config()).map_err(err)?;

    let mut policies = home.policies_mut().map_err(err)?;
    policies.seed(&rid(rid_s)?, Scope::Followed).map_err(err)?;
    if !follow.is_empty() {
        policies.follow(&NodeId::from_str(follow).map_err(err)?, None).map_err(err)?;
    }

    let signer = signing_key(&home)?;
    if Fingerprint::read(&home).map_err(err)?.is_none() {
        Fingerprint::init(&home, &signer).map_err(err)?;
    }
    Ok(NodeId::from(*signer.public_key()).to_string())
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
    let result = Runtime::init(home, config.node, socket, listen, signals, signer)
        .and_then(|rt| rt.run())
        .map_err(err);
    STOP.lock().map_err(err)?.take();
    result.map(|()| String::new())
}

fn stop() -> Res<String> {
    if let Some(tx) = STOP.lock().map_err(err)?.take() {
        tx.try_send(Signal::Terminate).ok();
    }
    Ok(String::new())
}

/// Write `bytes` as top-level file `file` on `refs/heads/<branch>` in our own
/// namespace of `rid_s`, sign refs, announce. On the first save on a device the
/// repo is fetched from `seed` first (needs the node running). Returns the
/// commit id (unchanged content returns the current tip without a new commit).
fn save_file(home: &str, rid_s: &str, branch: &str, file: &str, bytes: &[u8], message: &str, seed: &str) -> Res<String> {
    if file.is_empty() || file.contains('/') {
        return Err(format!("file must be a top-level name, got {file:?}"));
    }
    let home = Home::new(home).map_err(err)?;
    let rid = rid(rid_s)?;
    let signer = signing_key(&home)?;
    let me = NodeId::from(*signer.public_key());
    let config = Config::load(&home.config()).map_err(err)?;
    let alias = config.node.alias.clone();
    let storage = Storage::open(home.storage(), UserInfo { alias: alias.clone(), key: me }).map_err(err)?;
    let mut node = Node::new(home.socket_from_env());

    if !storage.contains(&rid).map_err(err)? {
        let from = NodeId::from_str(seed).map_err(err)?;
        if let FetchResult::Failed { reason } = node.fetch(rid, from, Duration::from_secs(60), None).map_err(err)? {
            return Err(format!("fetch {rid} from {from}: {reason}"));
        }
    }

    let repo = storage.repository_mut(rid).map_err(err)?;
    let raw = &repo.backend;
    let refname = format!("refs/namespaces/{me}/refs/heads/{branch}");
    let parent = raw.find_reference(&refname).ok().and_then(|r| r.peel_to_commit().ok());
    let base = parent.as_ref().map(|c| c.tree()).transpose().map_err(err)?;

    let mut tb = raw.treebuilder(base.as_ref()).map_err(err)?;
    tb.insert(file, raw.blob(bytes).map_err(err)?, 0o100644).map_err(err)?;
    let tree = raw.find_tree(tb.write().map_err(err)?).map_err(err)?;
    if let Some(p) = parent.as_ref().filter(|p| p.tree_id() == tree.id()) {
        return Ok(p.id().to_string());
    }

    let sig = git2::Signature::now(&alias.to_string(), &me.to_string()).map_err(err)?;
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = raw.commit(Some(&refname), &sig, &sig, message, &tree, &parents).map_err(err)?;
    repo.sign_refs(&signer).map_err(err)?;

    // Committed and signed either way; a down node just means the seed picks
    // it up on the next announce.
    if let Err(e) = node.announce_refs_for(rid, [me]) {
        log::warn!(target: "node", "announce {rid} after save: {e}");
    }
    Ok(oid.to_string())
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
    home: JString<'l>, alias: JString<'l>, config: JString<'l>, rid: JString<'l>, follow: JString<'l>,
) -> jstring {
    let r = (|| {
        let (h, a, c, r, f) = (jstr(&mut env, &home)?, jstr(&mut env, &alias)?, jstr(&mut env, &config)?, jstr(&mut env, &rid)?, jstr(&mut env, &follow)?);
        guarded(|| init(&h, &a, &c, &r, &f))
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

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_chaosd6_radicle_RadicleNative_saveFile<'l>(
    mut env: JNIEnv<'l>, _: JClass<'l>,
    home: JString<'l>, rid: JString<'l>, branch: JString<'l>, file: JString<'l>,
    bytes: JByteArray<'l>, message: JString<'l>, seed: JString<'l>,
) -> jstring {
    let r = (|| {
        let (h, r, b, f, m, s) = (jstr(&mut env, &home)?, jstr(&mut env, &rid)?, jstr(&mut env, &branch)?, jstr(&mut env, &file)?, jstr(&mut env, &message)?, jstr(&mut env, &seed)?);
        let data = env.convert_byte_array(&bytes).map_err(err)?;
        guarded(|| save_file(&h, &r, &b, &f, &data, &m, &s))
    })();
    reply(&mut env, r)
}
