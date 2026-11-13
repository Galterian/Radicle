/* Force-included (-include) into every git source file by build_git.sh.
 * bionic has no pthread cancellation; git only uses it to keep async
 * run-command threads from being cancelled mid-cleanup, which never happens
 * here (upload-pack / pack-objects), so the state calls are no-ops. */
#ifndef CHAOSD6_GIT_ANDROID_COMPAT_H
#define CHAOSD6_GIT_ANDROID_COMPAT_H
#ifndef PTHREAD_CANCEL_ENABLE
#define PTHREAD_CANCEL_ENABLE 0
#define PTHREAD_CANCEL_DISABLE 1
static inline int pthread_setcancelstate(int state, int *old) { (void)state; if (old) *old = PTHREAD_CANCEL_ENABLE; return 0; }
#endif
#endif
