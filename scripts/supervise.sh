#!/bin/bash
# pisa 看护进程：崩了自动重启，带退避。
# 用法：./scripts/supervise.sh
# token 优先取环境变量，缺省时读 ~/.pisa/telegram_token、~/.pisa/webhook_token。
set -u
cd "$(dirname "$0")/.."

if [ -z "${PISA_TELEGRAM_TOKEN:-}" ] && [ -f "$HOME/.pisa/telegram_token" ]; then
  export PISA_TELEGRAM_TOKEN="$(cat "$HOME/.pisa/telegram_token")"
fi

if [ -z "${PISA_WEBHOOK_TOKEN:-}" ] && [ -f "$HOME/.pisa/webhook_token" ]; then
  export PISA_WEBHOOK_TOKEN="$(cat "$HOME/.pisa/webhook_token")"
fi

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
