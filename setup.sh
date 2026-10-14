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
if ! command -v node >/dev/null; then
  command -v brew >/dev/null || { echo "Node.js is needed: https://nodejs.org (or install Homebrew first)"; exit 1; }
  say "Installing Node.js"
  brew install node
fi
if [[ ! -d /Applications/Raycast.app ]]; then
  command -v brew >/dev/null || { echo "Raycast is needed: https://raycast.com"; exit 1; }
  say "Installing Raycast"
  brew install --cask raycast
  open -a Raycast
fi

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
  # Has the sync read iMessage yet? Its export step logs within a minute or two; until then, assume it needs access.
  LAST=$(grep '"step":"export"' "$HOME/Library/Application Support/DigUp Messages Sync/sync.log" 2>/dev/null | tail -1)
  if [[ -n "$LAST" && "$LAST" != *"Full Disk Access"* ]]; then
    : # it can read iMessage already
  else
    print -P "
%F{yellow}One step only you can do:%f drag %BDigUp Messages Sync%b from the Finder window into the Full Disk Access
list that just opened (and approve with Touch ID), so it can read iMessage and Contacts. Beeper works without it."
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" || true
    sleep 1
    open -R "$HELPER"
  fi
fi

print -P "
%F{green}Done.%f Open Raycast and type %Bdig up%b.
  • Shorter: Raycast Settings → Extensions → DigUp → Dig Up → Alias (e.g. d) or Hotkey.
  • As a fallback: type anything in Raycast, click ⚙ beside \"Use … with\", turn on Dig Up.
  • The first pass over your files runs in the background; %BDig Up Status%b shows how far it is and fixes problems."
open "raycast://extensions/viraat/digup/index-status" 2>/dev/null || true
