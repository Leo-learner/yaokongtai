#!/bin/bash
set -euo pipefail

MODE="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_ROOT="${TARGET_ROOT:-/opt/apps/yaokongtai}"
PORT="${PORT:-3300}"

if [[ "$MODE" != "--dry-run" && "$MODE" != "--deploy" ]]; then
  echo "Usage: $0 --dry-run|--deploy" >&2
  exit 2
fi

cd "$ROOT"
test -f package-lock.json
git diff --exit-code
git diff --cached --exit-code
COMMIT="$(git rev-parse HEAD)"
if [[ "$MODE" == "--deploy" ]]; then
  git merge-base --is-ancestor "$COMMIT" origin/main
  test -f apps/relay/dist/main.js
  test -f apps/web/dist/index.html
fi

echo "release_commit=$COMMIT"
echo "target_root=$TARGET_ROOT"
echo "listen=127.0.0.1:$PORT"
echo "nginx_template=deploy/nginx/control.dkz12345.com.conf"
echo "systemd_template=deploy/systemd/yaokongtai.service"

if [[ "$MODE" == "--dry-run" ]]; then
  echo "DRY RUN: no files, services, certificates, DNS, or databases were changed."
  exit 0
fi

if [[ "${ALLOW_PRODUCTION_DEPLOY:-}" != "yes" ]]; then
  echo "Refusing deployment: set ALLOW_PRODUCTION_DEPLOY=yes explicitly." >&2
  exit 3
fi

RELEASE="$TARGET_ROOT/releases/$COMMIT"
mkdir -p "$RELEASE" "$TARGET_ROOT/shared/data" "$TARGET_ROOT/shared/updates"
git archive "$COMMIT" | tar -x -C "$RELEASE"
cd "$RELEASE"
npm ci
npm run build
npm prune --omit=dev
ln -sfn "$RELEASE" "$TARGET_ROOT/current"
echo "Release staged. Service and Nginx activation are intentionally separate administrator steps."
