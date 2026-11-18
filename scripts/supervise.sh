#!/bin/bash
# pisa 看护进程：崩了自动重启，带退避。
# 用法：./scripts/supervise.sh
# token 优先取环境变量，缺省时读 ~/.pisa/ 下的约定文件（见 scripts/tokens.sh）。
set -u
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/.."
# shellcheck source=scripts/tokens.sh
. "$here/tokens.sh"

if [ -z "${PISA_TELEGRAM_TOKEN:-}" ]; then
  echo "[supervise] 缺少 PISA_TELEGRAM_TOKEN" >&2
  exit 1
fi

backoff=1
while true; do
  echo "[supervise] start $(date '+%F %T')"
  bun run src/index.ts
  code=$?
  echo "[supervise] exit code=$code $(date '+%F %T')"
  if [ "$code" -eq 0 ]; then
    echo "[supervise] 正常退出，不再重启"
    exit 0
  fi
  sleep "$backoff"
  backoff=$(( backoff < 30 ? backoff * 2 : 30 ))
done
