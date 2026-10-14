#!/bin/zsh
# Keeps DigUp's copy of your messages current: a LaunchAgent that exports new iMessage and Beeper messages (and
# their attachments) whenever either app's database changes, and every 5 minutes regardless.
set -euo pipefail
cd "$(dirname "$0")/.."
LABEL=com.digup-ray.messages-sync
DIR="$HOME/Library/Application Support/DigUp Messages Sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE=$(realpath "$(command -v node)")

mkdir -p "$DIR"
node_modules/.bin/esbuild src/sync-cli.ts --bundle --platform=node --target=node18 --outfile="$DIR/sync.js" --log-level=warning
# The binary Full Disk Access is granted to (System Settings → Privacy & Security → Full Disk Access).
HELPER="$DIR/DigUp Messages Sync"
clang -O2 -DNODE_PATH="\"$NODE\"" -o "$HELPER.new" scripts/sync-helper.c
codesign --force --sign - --identifier "$LABEL" "$HELPER.new"
# Replaced only when it changed, so the access granted to it stays.
if ! cmp -s "$HELPER.new" "$HELPER"; then mv "$HELPER.new" "$HELPER"; else rm "$HELPER.new"; fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$HELPER</string></array>
  <key>WatchPaths</key>
  <array>
    <string>$HOME/Library/Application Support/BeeperTexts/index.db</string>
    <string>$HOME/Library/Application Support/BeeperTexts/index.db-wal</string>
    <string>$HOME/Library/Messages/chat.db</string>
    <string>$HOME/Library/Messages/chat.db-wal</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>ThrottleInterval</key><integer>20</integer>
  <key>RunAtLoad</key><true/>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DIR/sync.log</string>
  <key>StandardErrorPath</key><string>$DIR/sync.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL → $DIR/sync.log"
