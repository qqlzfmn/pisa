# shellcheck shell=bash
# 由 supervise.sh / patrol.sh source：token 优先取环境变量，缺省读 ~/.pisa/<name>_token。
# 与 src/token.ts 的 TOKEN_FILES 同一约定，新增通道时两边一起改。

load_pisa_token() {
  local var="$1" file="$HOME/.pisa/$2"
  if [ -z "${!var:-}" ] && [ -f "$file" ]; then
    export "$var"="$(cat "$file")"
  fi
}

load_pisa_token PISA_TELEGRAM_TOKEN telegram_token
load_pisa_token PISA_WEBHOOK_TOKEN webhook_token
load_pisa_token PISA_WEB_TOKEN web_token
