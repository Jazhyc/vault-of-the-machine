#!/usr/bin/env bash
# Build the zero-install Windows bundle: portable Node + cloudflared + the game.
#   bash bundle/make-bundle.sh   →   dist/vault-of-the-machine-win64.zip
# Needs: bash, curl, zip, unzip, and a local node (to parse the version index).
# Downloads are cached in dist/.cache so rebuilds are offline-fast.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
STAGE="$DIST/vault-of-the-machine"
CACHE="$DIST/.cache"

mkdir -p "$DIST" "$CACHE"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# --- portable node.exe (latest LTS, win-x64) -------------------------------
NODE_VER="$(curl -fsSL https://nodejs.org/dist/index.json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).find(v=>v.lts).version))')"
NODE_ZIP="$CACHE/node-$NODE_VER-win-x64.zip"
if [ ! -f "$NODE_ZIP" ]; then
  echo "Downloading Node $NODE_VER (win-x64)…"
  curl -fL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-win-x64.zip" -o "$NODE_ZIP"
fi
mkdir -p "$STAGE/node"
unzip -p "$NODE_ZIP" "node-$NODE_VER-win-x64/node.exe" > "$STAGE/node/node.exe"

# --- cloudflared (single static exe; web.js prefers this bundled copy) -----
CF_EXE="$CACHE/cloudflared.exe"
if [ ! -f "$CF_EXE" ]; then
  echo "Downloading cloudflared (windows-amd64)…"
  curl -fL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -o "$CF_EXE"
fi
cp "$CF_EXE" "$STAGE/cloudflared.exe"

# --- the game --------------------------------------------------------------
cp -r "$ROOT/server" "$ROOT/shared" "$ROOT/public" "$ROOT/node_modules" "$STAGE/"
cp "$ROOT/package.json" "$ROOT/LICENSE" "$ROOT/README.md" "$STAGE/"
cp "$ROOT/bundle/start.bat" "$STAGE/"

# --- zip -------------------------------------------------------------------
OUT="$DIST/vault-of-the-machine-win64.zip"
rm -f "$OUT"
(cd "$DIST" && zip -qr "$(basename "$OUT")" "$(basename "$STAGE")")
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
