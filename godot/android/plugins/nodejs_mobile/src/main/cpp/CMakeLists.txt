# Builds libnodejs_mobile_bridge.so, the thin JNI shim that forwards
# nativeStartNode / nativePostMessage from Kotlin into libnode.so (from
# nodejs-mobile) and pipes Node's stdout/stderr back into Kotlin as JNI
# callbacks.
#
# Prereq: _tools/fetch_nodejs_mobile.sh has populated:
#   src/main/jniLibs/<abi>/libnode.so
#   src/main/cpp/node-headers/node.h  (and friends from nodejs-mobile/include/)
# before this gradle build runs.

cmake_minimum_required(VERSION 3.22.1)
project(nodejs_mobile_bridge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# libnode.so lives in jniLibs; declare it as an IMPORTED library so we can
# link against it symbolically.
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION
    ${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

add_library(nodejs_mobile_bridge SHARED
    native-lib.cpp)

target_include_directories(nodejs_mobile_bridge PRIVATE
    ${CMAKE_SOURCE_DIR}/node-headers)

find_library(log-lib log)

target_link_libraries(nodejs_mobile_bridge
    libnode
    ${log-lib})
