#!/bin/bash
set -euo pipefail

NODE22_BIN="${NODE22_BIN:-$HOME/.nvm/versions/node/v22.22.2/bin}"
if [[ ! -x "$NODE22_BIN/node" ]]; then
  echo "Node 22 not found at $NODE22_BIN. Set NODE22_BIN to a Node 22 bin directory." >&2
  exit 1
fi
export PATH="$NODE22_BIN:$PATH"
exec "$@"
