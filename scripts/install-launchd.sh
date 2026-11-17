#!/bin/bash
# 把 scripts/supervise.sh 安装成 launchd 常驻服务，并挂一小时一次的巡检，重复执行会重装。
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
label="ai.pisa.supervisor"
ops_check="ai.pisa.opscheck"
plist="$HOME/Library/LaunchAgents/$label.plist"
ops_plist="$HOME/Library/LaunchAgents/$ops_check.plist"
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

# 巡检独立成一个 job：用 StartInterval 而不是常驻进程，pid 挂了也能继续报出来
cat > "$ops_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$ops_check</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$repo/scripts/ops-check.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$repo</string>
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
  <string>$HOME/Library/Logs/pisa.opscheck.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/pisa.opscheck.log</string>
</dict>
</plist>
PLIST

if launchctl print "$domain/$ops_check" >/dev/null 2>&1; then
  launchctl bootout "$domain/$ops_check"
fi

launchctl bootstrap "$domain" "$ops_plist"
echo "[install-launchd] 已加载 $ops_check（每小时巡检）"
echo "[install-launchd] 巡检日志：$HOME/Library/Logs/pisa.opscheck.log"
