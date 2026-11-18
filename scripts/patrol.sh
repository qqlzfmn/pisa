#!/bin/bash
# 每小时巡检：正常静默，异常才输出并提醒。由 launchd 定时调用，也可手动跑。
set -u
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/.."
# shellcheck source=scripts/tokens.sh
. "$here/tokens.sh"
exec bun run src/cli.ts patrol
