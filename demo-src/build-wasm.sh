#!/usr/bin/env bash
# Builds the demo's engine (site/scyllasband/demo/engine/) from a Scylla's Band checkout with Emscripten.
# usage: EMSDK=/path/to/emsdk demo-src/build-wasm.sh /path/to/scyllasband
set -euo pipefail
SRC=${1:?usage: EMSDK=/path/to/emsdk build-wasm.sh /path/to/scyllasband}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../site/scyllasband/demo/engine
LIB=$SRC/libscyllasband
source "${EMSDK:?set EMSDK to an emsdk checkout}/emsdk_env.sh" >/dev/null 2>&1
mkdir -p "$OUT"
# Every engine source except the native graph backends (ONNX Runtime, LiteRT, Apple); scyllasband_graph_js.cpp is this
# build's backend.
SOURCES=()
for f in "$LIB"/src/*.cpp; do
  case "$(basename "$f")" in scyllasband_graph_onnx.cpp|scyllasband_graph_litert.cpp) ;; *) SOURCES+=("$f") ;; esac
done
em++ -O3 -std=c++17 -fexceptions -I"$LIB/include" -I"$LIB/src" \
  "${SOURCES[@]}" "$HERE/scyllasband_graph_js.cpp" \
  -sASYNCIFY -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createScyllasBand -sENVIRONMENT=worker,node \
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB \
  -sEXPORTED_FUNCTIONS=_sb_create,_sb_voices,_sb_stream,_scyllasband_last_error,_scyllasband_version,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=ccall,FS,UTF8ToString \
  -o "$OUT/scyllasband.mjs"
echo "built $OUT/scyllasband.mjs ($(git -C "$SRC" rev-parse --short HEAD))"
