#!/bin/bash
# 把 scripts/supervise.sh 装成常驻服务、把 scripts/patrol.sh 装成小时巡检，重复执行会重装。
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
domain="gui/$(id -u)"
agents="$HOME/Library/LaunchAgents"
logs="$HOME/Library/Logs"

mkdir -p "$agents" "$logs" "$repo/.pisa"

apply() {
  local label="$1"
  local plist="$agents/$label.plist"
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl bootout "$domain/$label"
  fi
  launchctl bootstrap "$domain" "$plist"
}

cat > "$agents/ai.pisa.supervisor.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.pisa.supervisor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$repo/scripts/supervise.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$repo</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PISA_SUPERVISED</key>
    <string>1</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.bun/bin</string>
    <key>HTTPS_PROXY</key>
    <string>http://127.0.0.1:7897</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$logs/pisa.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$logs/pisa.launchd.log</string>
</dict>
</plist>
PLIST

cat > "$agents/ai.pisa.patrol.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.pisa.patrol</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$repo/scripts/patrol.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$repo</string>
  <key>RunAtLoad</key>
  <false/>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.bun/bin</string>
    <key>HTTPS_PROXY</key>
    <string>http://127.0.0.1:7897</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$logs/pisa.patrol.log</string>
  <key>StandardErrorPath</key>
  <string>$logs/pisa.patrol.log</string>
</dict>
</plist>
PLIST

apply ai.pisa.supervisor
apply ai.pisa.patrol

echo "[install-launchd] 已加载 ai.pisa.supervisor → $repo"
echo "[install-launchd] 已加载 ai.pisa.patrol（每小时）"
echo "[install-launchd] 日志：$logs/pisa.launchd.log、$logs/pisa.patrol.log"
