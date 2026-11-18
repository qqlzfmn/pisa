#!/bin/bash
# pisa 小时巡检：正常静默、异常打印并返回非零退出码（0 正常 / 1 需重启 / 2 部件错误 / 3 待配置）。
# 用法：./scripts/patrol.sh；由 launchd 定时触发，也可手工执行。
# token 优先取环境变量，缺省时读 ~/.pisa/telegram_token；没有 token 时告警只写 stdout。
set -u
cd "$(dirname "$0")/.."

if [ -z "${PISA_TELEGRAM_TOKEN:-}" ] && [ -f "$HOME/.pisa/telegram_token" ]; then
  export PISA_TELEGRAM_TOKEN="$(cat "$HOME/.pisa/telegram_token")"
fi

bun run src/cli.ts patrol
code=$?
if [ "$code" -ne 0 ]; then
  echo "[patrol] exit=$code $(date '+%F %T')" >&2
fi
exit "$code"
