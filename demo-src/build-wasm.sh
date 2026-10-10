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
em++ -O3 -std=c++17 -fexceptions -I"$LIB/include" -I"$LIB/src" \
  "$LIB"/src/scyllasband.cpp "$LIB"/src/scyllasband_engine.cpp "$LIB"/src/scyllasband_events.cpp \
  "$LIB"/src/scyllasband_g2p.cpp "$LIB"/src/scyllasband_json.cpp "$LIB"/src/scyllasband_text.cpp \
  "$LIB"/src/scyllasband_unicode.cpp "$HERE/scyllasband_graph_js.cpp" \
  -sASYNCIFY -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createScyllasBand -sENVIRONMENT=worker,node \
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB \
  -sEXPORTED_FUNCTIONS=_sb_create,_sb_voices,_sb_stream,_scyllasband_last_error,_scyllasband_version,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=ccall,FS,UTF8ToString \
  -o "$OUT/scyllasband.mjs"
echo "built $OUT/scyllasband.mjs ($(git -C "$SRC" rev-parse --short HEAD))"
