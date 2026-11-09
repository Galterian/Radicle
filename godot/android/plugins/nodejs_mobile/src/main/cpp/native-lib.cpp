// JNI bridge for the NodejsMobile Godot plugin.
//
// Exposes two symbols the Kotlin side (NodejsMobileService) declares external:
//
//   nativeStartNode(argv: Array<String>, envp: Array<String>) : Int
//       Converts the Java arrays into argc/argv/envp, calls setenv() for each
//       envp entry, redirects stdout/stderr via pipe()+dup2(), and finally
//       invokes `node_start(argc, argv)` from libnode.so. Blocks on the
//       caller's thread until node's event loop exits.
//
//   nativePostMessage(channel: String, msg: String)
//       Phase-1 stub. The eventual bidirectional bridge needs a V8-level
//       binding (see nodejs-mobile-react-native's cordova-plugin-nodejs-mobile
//       `rn-bridge`). Until that lands, this logs the attempt and no-ops.
//
// stdout/stderr routing: on first call we create a pipe, dup2 its write end
// over STDOUT_FILENO (same for stderr), then spawn a reader thread per pipe.
// Each thread calls back into the Kotlin static method
// NodejsMobileService.onNativeStdout(String) / onNativeStderr(String), one
// call per line.

#include <jni.h>
#include <android/log.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <thread>
#include <atomic>
#include <vector>

#define LOG_TAG "nodejs_mobile_bridge"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// libnode.so exports `node::Start(int, char**)` with C++ linkage (see
// nodejs-mobile/include/node/node.h: `NODE_EXTERN int Start(int argc, char*
// argv[])` inside the `node` namespace). Verified against the shipped
// libnode.so symbol table on 2026-11-07: `_ZN4node5StartEiPPc` present.
// We forward-declare the namespace member instead of including the full
// node.h → v8 header stack; the mangled name resolves against libnode.so
// at link time.
namespace node {
    int Start(int argc, char *argv[]);
}

static JavaVM *g_vm = nullptr;
static jclass  g_svc_class = nullptr;   // NodejsMobileService (global ref)
static jmethodID g_mid_stdout = nullptr;
static jmethodID g_mid_stderr = nullptr;
static std::atomic<bool> g_pumps_started{false};

jint JNI_OnLoad(JavaVM *vm, void * /*reserved*/) {
    g_vm = vm;
    JNIEnv *env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK) {
        return JNI_ERR;
    }
    jclass local = env->FindClass("io/chaosd6/nodejs/NodejsMobileService");
    if (local == nullptr) {
        LOGE("JNI_OnLoad: cannot find NodejsMobileService");
        return JNI_ERR;
    }
    g_svc_class = reinterpret_cast<jclass>(env->NewGlobalRef(local));
    env->DeleteLocalRef(local);
    g_mid_stdout = env->GetStaticMethodID(g_svc_class, "onNativeStdout", "(Ljava/lang/String;)V");
    g_mid_stderr = env->GetStaticMethodID(g_svc_class, "onNativeStderr", "(Ljava/lang/String;)V");
    if (g_mid_stdout == nullptr || g_mid_stderr == nullptr) {
        LOGE("JNI_OnLoad: missing onNativeStdout/Stderr methods");
        return JNI_ERR;
    }
    return JNI_VERSION_1_6;
}

static void pump_fd_to_java(int fd, bool is_stderr) {
    JNIEnv *env = nullptr;
    if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK) {
        LOGE("pump: AttachCurrentThread failed");
        return;
    }
    jmethodID mid = is_stderr ? g_mid_stderr : g_mid_stdout;

    std::string buf;
    buf.reserve(4096);
    char chunk[1024];
    while (true) {
        ssize_t n = read(fd, chunk, sizeof(chunk));
        if (n <= 0) {
            // EOF or error — node exited. Flush any remainder as a final line.
            if (!buf.empty()) {
                jstring js = env->NewStringUTF(buf.c_str());
                env->CallStaticVoidMethod(g_svc_class, mid, js);
                env->DeleteLocalRef(js);
            }
            break;
        }
        for (ssize_t i = 0; i < n; ++i) {
            if (chunk[i] == '\n') {
                jstring js = env->NewStringUTF(buf.c_str());
                env->CallStaticVoidMethod(g_svc_class, mid, js);
                env->DeleteLocalRef(js);
                buf.clear();
            } else if (chunk[i] != '\r') {
                buf.push_back(chunk[i]);
            }
        }
    }
    g_vm->DetachCurrentThread();
}

static bool install_std_pumps() {
    bool expected = false;
    if (!g_pumps_started.compare_exchange_strong(expected, true)) return true;

    int out_pipe[2];
    int err_pipe[2];
    if (pipe(out_pipe) != 0 || pipe(err_pipe) != 0) {
        LOGE("pipe() failed");
        return false;
    }
    // Replace fd 1 (stdout) and fd 2 (stderr) with the write ends of the pipes.
    if (dup2(out_pipe[1], STDOUT_FILENO) < 0 ||
        dup2(err_pipe[1], STDERR_FILENO) < 0) {
        LOGE("dup2 failed");
        return false;
    }
    close(out_pipe[1]);
    close(err_pipe[1]);
    // Line-buffer stdout so lines flush when complete.
    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);

    std::thread(pump_fd_to_java, out_pipe[0], /*is_stderr=*/false).detach();
    std::thread(pump_fd_to_java, err_pipe[0], /*is_stderr=*/true ).detach();
    return true;
}

extern "C" JNIEXPORT jint JNICALL
Java_io_chaosd6_nodejs_NodejsMobileService_nativeStartNode(
        JNIEnv *env, jclass /*clazz*/, jobjectArray jargv, jobjectArray jenvp) {
    install_std_pumps();

    // --- apply envp via setenv() so process.env sees them ---
    jsize env_count = env->GetArrayLength(jenvp);
    for (jsize i = 0; i < env_count; ++i) {
        auto js = reinterpret_cast<jstring>(env->GetObjectArrayElement(jenvp, i));
        const char *c = env->GetStringUTFChars(js, nullptr);
        // Each entry is "KEY=VALUE".
        const char *eq = strchr(c, '=');
        if (eq) {
            std::string k(c, eq - c);
            std::string v(eq + 1);
            setenv(k.c_str(), v.c_str(), /*overwrite=*/1);
        }
        env->ReleaseStringUTFChars(js, c);
        env->DeleteLocalRef(js);
    }

    // --- build argv ---
    jsize argc = env->GetArrayLength(jargv);
    std::vector<std::string> arg_storage;
    arg_storage.reserve(argc);
    std::vector<char *> argv;
    argv.reserve(argc + 1);
    for (jsize i = 0; i < argc; ++i) {
        auto js = reinterpret_cast<jstring>(env->GetObjectArrayElement(jargv, i));
        const char *c = env->GetStringUTFChars(js, nullptr);
        arg_storage.emplace_back(c);
        env->ReleaseStringUTFChars(js, c);
        env->DeleteLocalRef(js);
        argv.push_back(const_cast<char *>(arg_storage.back().c_str()));
    }
    argv.push_back(nullptr);

    LOGI("calling node::Start(argc=%d, argv[0]=%s)", (int)argc, argc > 0 ? argv[0] : "<null>");
    int code = node::Start(static_cast<int>(argc), argv.data());
    LOGI("node::Start returned %d", code);
    return static_cast<jint>(code);
}

extern "C" JNIEXPORT void JNICALL
Java_io_chaosd6_nodejs_NodejsMobileService_nativePostMessage(
        JNIEnv *env, jclass /*clazz*/, jstring channel, jstring msg) {
    // Phase 1 stub. Needs a V8 binding or the nodejs-mobile `rn-bridge`-style
    // channel to actually enqueue work on the Node event loop. For now, log
    // and discard so the Kotlin caller gets no surprise exceptions.
    const char *c = env->GetStringUTFChars(channel, nullptr);
    const char *m = env->GetStringUTFChars(msg, nullptr);
    LOGI("nativePostMessage(stub): channel=%s msg=%.80s", c, m);
    env->ReleaseStringUTFChars(channel, c);
    env->ReleaseStringUTFChars(msg, m);
}
