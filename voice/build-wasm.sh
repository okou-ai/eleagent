#!/bin/bash
# Builds public/voice/eleagent-voice.{js,wasm}: sherpa-onnx's C API for keyword spotting and speaker embeddings,
# compiled to WebAssembly with Emscripten, models left out (the page loads them at run time).
# Needs emsdk 4.0.23 activated (sherpa-onnx's known-good version): source /path/to/emsdk/emsdk_env.sh
set -euo pipefail
SHERPA_ONNX_VERSION=v1.13.8
here=$(cd "$(dirname "$0")" && pwd)
work=${WORK:-$(mktemp -d)}
git clone --depth 1 --branch "$SHERPA_ONNX_VERSION" https://github.com/k2-fsa/sherpa-onnx.git "$work/sherpa-onnx"
cd "$work/sherpa-onnx"
mkdir -p wasm/eleagent-voice
cp "$here/wasm/CMakeLists.txt" "$here/wasm/main.cc" wasm/eleagent-voice/
sed -i 's|add_subdirectory(kws)|add_subdirectory(eleagent-voice)|' wasm/CMakeLists.txt
mkdir -p build && cd build
SHERPA_ONNX_IS_USING_BUILD_WASM_SH=ON cmake -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF -DSHERPA_ONNX_ENABLE_TESTS=OFF -DSHERPA_ONNX_ENABLE_CHECK=OFF -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF -DSHERPA_ONNX_ENABLE_JNI=OFF -DSHERPA_ONNX_ENABLE_C_API=ON -DSHERPA_ONNX_ENABLE_TTS=OFF \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF -DSHERPA_ONNX_ENABLE_GPU=OFF -DSHERPA_ONNX_ENABLE_WASM=ON -DSHERPA_ONNX_ENABLE_WASM_KWS=ON \
  -DSHERPA_ONNX_ENABLE_BINARY=OFF -DSHERPA_ONNX_LINK_LIBSTDCPP_STATICALLY=OFF ..
make -j"$(nproc)" eleagent-voice
cp bin/eleagent-voice.js bin/eleagent-voice.wasm "$here/../public/voice/" 2>/dev/null || cp eleagent-voice.js eleagent-voice.wasm "$here/../public/voice/" 2>/dev/null || \
  cp wasm/eleagent-voice/eleagent-voice.js wasm/eleagent-voice/eleagent-voice.wasm "$here/../public/voice/"
