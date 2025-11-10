#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_CPP="$ROOT_DIR/wasm/peaks.cpp"
SRC_WAT="$ROOT_DIR/wasm/peaks.wat"
OUT_WASM="$ROOT_DIR/src/workers/peaks.wasm"

mkdir -p "$(dirname "$OUT_WASM")"

if command -v emcc >/dev/null 2>&1; then
  echo "[wasm] building with emcc"
  emcc "$SRC_CPP" -O3 -s STANDALONE_WASM -s EXPORTED_FUNCTIONS=_compute_peaks \
    -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=1048576 -o "$OUT_WASM"
  exit 0
fi

echo "[wasm] emcc not found; falling back to wat2wasm"
WAT2WASM=""
if command -v wat2wasm >/dev/null 2>&1; then
  WAT2WASM="$(command -v wat2wasm)"
elif [ -x "$ROOT_DIR/node_modules/.bin/wat2wasm" ]; then
  WAT2WASM="$ROOT_DIR/node_modules/.bin/wat2wasm"
fi
if [ -z "$WAT2WASM" ]; then
  echo "error: wat2wasm is required when emcc is unavailable" >&2
  echo "hint: npm install --save-dev wabt" >&2
  exit 1
fi

"$WAT2WASM" "$SRC_WAT" -o "$OUT_WASM"
echo "[wasm] wrote $OUT_WASM"
