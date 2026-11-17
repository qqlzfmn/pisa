#!/bin/bash
# 把 scripts/supervise.sh 安装成 launchd 常驻服务，重复执行会重装。
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
label="ai.pisa.supervisor"
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$repo/.pisa"

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
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
  <string>$HOME/Library/Logs/pisa.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/pisa.launchd.log</string>
</dict>
</plist>
PLIST

if launchctl print "$domain/$label" >/dev/null 2>&1; then
  launchctl bootout "$domain/$label"
fi

launchctl bootstrap "$domain" "$plist"
echo "[install-launchd] 已加载 $label → $repo"
echo "[install-launchd] 日志：$HOME/Library/Logs/pisa.launchd.log"
