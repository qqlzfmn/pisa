#!/bin/bash
# 小时巡检：pisa status --alert 正常时静默，异常且问题变化时才输出并推送。
# 由 launchd 的 ai.pisa.opscheck 每小时触发；也可手动执行验证。
set -u
cd "$(dirname "$0")/.."

# 与 supervise.sh 相同的 token 约定：优先环境变量，缺省读 ~/.pisa/telegram_token
if [ -z "${PISA_TELEGRAM_TOKEN:-}" ] && [ -f "$HOME/.pisa/telegram_token" ]; then
  export PISA_TELEGRAM_TOKEN="$(cat "$HOME/.pisa/telegram_token")"
fi

exec bun run src/cli.ts status --alert
