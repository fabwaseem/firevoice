#!/bin/sh
# The backend test suite on Linux as GitHub's ubuntu-22.04 runner has it (Ubuntu 22.04 with its own ffmpeg 4.4), in Docker:
#   docker run --rm -v firevoice-uv-cache:/root/.cache/uv -v "$PWD:/src:ro" ubuntu:22.04 sh /src/scripts/test-linux.sh
# Each test has 2 minutes; a hang prints every thread's stack. The uv-cache volume keeps downloads between runs.
# With -e COMPILED=1 it tests the backend compiled as the Linux installer ships it, as a release build does.
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null && apt-get install -y -qq curl ca-certificates xz-utils ffmpeg build-essential >/dev/null
curl -fsSL https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-x64.tar.xz | tar -xJ -C /opt
export PATH="/opt/node-v24.11.1-linux-x64/bin:$HOME/.local/bin:$PATH"
curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1
mkdir -p /work && cd /src
tar --exclude=./node_modules --exclude=./src-tauri/target --exclude=./backend/.venv --exclude=./.git --exclude=./release \
    --exclude=./dist --exclude=./.claude -cf - backend scripts package.json src-tauri | tar -xf - -C /work
cd /work
export FIREVOICE_TORCH_INDEX=https://download.pytorch.org/whl/cpu
export UV_HTTP_TIMEOUT=60 UV_HTTP_RETRIES=5 UV_PYTHON_PREFERENCE=only-managed
echo "== $(. /etc/os-release; echo $PRETTY_NAME), node $(node -v), $(ffmpeg -hide_banner -version | head -1)"
echo "== dev setup"; node scripts/dev-setup.mjs > /tmp/setup.log 2>&1 || { tail -30 /tmp/setup.log; exit 1; }
if [ "${COMPILED:-}" = "1" ]; then
  echo "== compiling the backend"; node scripts/bundle-backend.mjs 2>&1 | grep "\[bundle-backend\] \(staged\|compiling\)\|failed"
  echo "== quick check"; node scripts/test-bundled-backend.mjs 2>&1 | tail -3
  echo "== testing the compiled backend"
  node scripts/test-bundled-backend.mjs --full -rfE --timeout-method=thread -o console_output_style=count 2>&1
else
  echo "== testing"
  cd backend
  .venv/bin/python -m pytest -q -rfE -p no:cacheprovider --timeout-method=thread -o console_output_style=count 2>&1
fi
