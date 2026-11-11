#!/bin/sh
# Runs inside the image (docker/linux/Dockerfile): builds the Linux packages from the source mounted read-only at /src
# and leaves them in /out. Needs TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD) in the environment to sign the updater file.
set -eu

# a clean copy of the sources (the host's node_modules, build output and virtual environments are Windows-shaped)
mkdir -p /work
cd /src
tar --exclude=./node_modules --exclude=./src-tauri/target --exclude=./backend/.venv --exclude=./release --exclude=./dist \
    --exclude=./src-tauri/resources/backend --exclude=./.git --exclude='*.tsbuildinfo' -cf - . | tar -xf - -C /work
cd /work
mkdir -p src-tauri/resources/backend && touch src-tauri/resources/backend/.gitkeep

pnpm install --frozen-lockfile

# the app binary names source files in its error messages: keep the build folder out of them
export CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=/work=firevoice"
unset FIREVOICE_PLAIN_BACKEND

# the build folder is a cache kept between runs: packages from an earlier version must not be picked up below
rm -rf src-tauri/target/release/bundle
pnpm tauri build --bundles "${FIREVOICE_BUNDLES:-appimage,deb,rpm}"

mkdir -p /out
rm -f /out/*
for f in src-tauri/target/release/bundle/appimage/*.AppImage src-tauri/target/release/bundle/appimage/*.AppImage.sig \
         src-tauri/target/release/bundle/deb/*.deb src-tauri/target/release/bundle/rpm/*.rpm; do
  [ -f "$f" ] && cp "$f" /out/
done
cp src-tauri/resources/backend/backend.json /out/backend.json
ls -la /out
