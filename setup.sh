#!/bin/zsh
# Turns Raycast into DigUp: installs DigUp (the indexer and its model), points it at your home folder, loads this
# extension into Raycast, and starts the background pieces (DigUp without its window, and the iMessage/Beeper sync).
#
#   ./setup.sh                    everything
#   ./setup.sh --no-messages      skip iMessage/Beeper
#   ./setup.sh --folders "~/Documents:~/Pictures"   index these instead of the whole home folder
set -euo pipefail
cd "$(dirname "$0")"

MESSAGES=1
FOLDERS="$HOME"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-messages) MESSAGES=0 ;;
    --folders) FOLDERS="${2/#\~/$HOME}"; FOLDERS="${FOLDERS//:~/:$HOME}"; shift ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
  shift
done

say() { print -P "%F{green}==>%f $1"; }
[[ "$(uname -m)" == arm64 ]] || { echo "DigUp needs an Apple Silicon Mac"; exit 1; }
command -v node >/dev/null || { echo "Node.js is needed (brew install node)"; exit 1; }
[[ -d /Applications/Raycast.app ]] || { echo "Raycast is needed (brew install --cask raycast)"; exit 1; }

DIGUP=/Applications/DigUp.app/Contents/Helpers/digup
if [[ ! -x $DIGUP ]]; then
  say "Installing DigUp"
  command -v brew >/dev/null || { echo "Homebrew is needed, or install DigUp from https://github.com/ARahim3/DigUp/releases"; exit 1; }
  brew install --cask arahim3/tap/digup
fi

say "Downloading DigUp's model (865 MB, once)"
"$DIGUP" download-model | tail -1

say "Pointing DigUp at ${FOLDERS//$HOME/~}"
osascript -e 'quit app "DigUp"' 2>/dev/null || true
defaults write com.abdurrahim.DigUp roots -array ${(s.:.)FOLDERS}
if [[ -d "$HOME/code" ]] && ! defaults read com.abdurrahim.DigUp codeRoots >/dev/null 2>&1; then
  defaults write com.abdurrahim.DigUp codeRoots -array "$HOME/code"
fi
defaults write com.abdurrahim.DigUp onboarded -bool true
defaults write com.abdurrahim.DigUp hotkey -string ""   # Raycast is the search now

say "Building the Raycast extension"
npm install --no-audit --no-fund --silent
npx ray build -e dist >/dev/null

say "Loading it into Raycast"
LOG=$(mktemp)
npx ray develop >"$LOG" 2>&1 &
DEV=$!
for _ in {1..60}; do grep -q "built extension successfully" "$LOG" && break; sleep 1; done
sleep 2
kill $DEV 2>/dev/null || true
grep -q "built extension successfully" "$LOG" || { cat "$LOG"; echo "couldn't load the extension into Raycast"; exit 1; }

say "Running DigUp in the background (no window)"
scripts/install-digup-agent.sh

if (( MESSAGES )); then
  say "Syncing iMessage and Beeper"
  scripts/install-sync-agent.sh
  HELPER="$HOME/Library/Application Support/DigUp Messages Sync/DigUp Messages Sync"
  print -P "
%F{yellow}One step only you can do:%f give Full Disk Access to the message sync, so it can read iMessage and Contacts.
  System Settings → Privacy & Security → Full Disk Access → + → ⇧⌘G →
  $HELPER
(Beeper works without it.)"
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" || true
fi

print -P "
%F{green}Done.%f Open Raycast and type %Bdig up%b.
  • Make it the default: Raycast Settings → General → move Raycast's hotkey (e.g. ⌥Space), then
    Extensions → DigUp → Dig Up → Hotkey → ⌘Space. ⌫ on an empty search goes back to regular Raycast.
  • Or as a fallback: type anything in Raycast, click ⚙ beside \"Use … with\", turn on Dig Up.
  • The first pass over your files runs in the background; Dig Up → Index Status shows how far it is."
