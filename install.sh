#!/bin/zsh
# One-line install:  curl -fsSL https://raw.githubusercontent.com/viraatdas/digup-raycast/main/install.sh | zsh
# Puts the extension in ~/.digup-raycast (or updates it) and runs setup.sh. Pass setup options after `-s --`:
#   curl -fsSL …/install.sh | zsh -s -- --no-messages
set -euo pipefail
DIR="${DIGUP_RAYCAST_DIR:-$HOME/.digup-raycast}"
if [[ -d "$DIR/.git" ]]; then
  git -C "$DIR" pull --ff-only --quiet
else
  git clone --quiet https://github.com/viraatdas/digup-raycast "$DIR"
fi
exec "$DIR/setup.sh" "$@"
