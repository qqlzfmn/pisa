#!/bin/bash
# 把 scripts/supervise.sh 与 scripts/patrol.sh 安装成 launchd 服务，重复执行会重装。
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
domain="gui/$(id -u)"
agents="$HOME/Library/LaunchAgents"
logs="$HOME/Library/Logs"

mkdir -p "$agents" "$logs" "$repo/.pisa"

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
  <true/>
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

for label in ai.pisa.supervisor ai.pisa.patrol; do
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl bootout "$domain/$label"
  fi
  launchctl bootstrap "$domain" "$agents/$label.plist"
  echo "[install-launchd] 已加载 $label"
done

echo "[install-launchd] 仓库：$repo"
echo "[install-launchd] 日志：$logs/pisa.launchd.log（守护）、$logs/pisa.patrol.log（巡检）"
