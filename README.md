# DigUp for Raycast

Turn Raycast into [DigUp](https://github.com/ARahim3/DigUp): search everything on your Mac by what's in it, in your own
words, from Raycast. Pictures, screenshots, PDFs, documents, recordings, videos, code, and your **iMessage** and
**Beeper** chats (WhatsApp, Messenger, Instagram, Discord, LinkedIn, Signal, Telegram…) with their photos, videos and
voice notes.

- "a dog on the beach" → the photo
- "where they talk about sleep" → that minute of the podcast
- "the clause about pets in the lease" → the PDF page
- "when mom talked about the trip" → the chat, opened in Messages at that message
- "code: retry a failed call with backoff" → the function, opened in your editor at the line

All of it runs on your Mac with Google DeepMind's EmbeddingGemma 2 (through DigUp). Nothing is uploaded.

## Install

Apple Silicon Mac, macOS 14+, [Raycast](https://raycast.com), Node.js and Homebrew.

```sh
git clone https://github.com/viraatdas/digup-raycast && cd digup-raycast
./setup.sh                  # or: ./setup.sh --no-messages, ./setup.sh --folders "~/Documents:~/Pictures"
```

`setup.sh` installs DigUp and its model (865 MB, once), points it at your home folder (and `~/code` for code search),
loads the extension into Raycast, runs DigUp in the background without its own window, and starts the message sync.

Then, two things only you can do:

1. **Full Disk Access for messages.** System Settings → Privacy & Security → Full Disk Access → **+** → ⇧⌘G →
   `~/Library/Application Support/DigUp Messages Sync/DigUp Messages Sync`. (iMessage and Contacts need it; Beeper
   doesn't.)
2. **Make Raycast open in DigUp.** Raycast Settings → General → move Raycast's hotkey (e.g. ⌥Space), then Extensions
   → DigUp → **Dig Up** → Hotkey → ⌘Space. ⌫ on an empty search goes back to regular Raycast. Or keep Raycast as is
   and add Dig Up as a fallback: type anything, click ⚙ beside "Use … with", turn on **Dig Up**.

The first pass over your files runs in the background (minutes for a few hundred files, an hour or more for a big
home folder). **Dig Up → Index Status** shows how far it is.

## Commands

| Command | |
|---|---|
| **Dig Up** | Everything, grouped like DigUp's panel: Messages, Screenshots, Images, Documents, Video, Audio. `code:` searches code |
| **Dig Up Messages** | Only chats and their attachments |
| **Dig Up Pictures** | Pictures, screenshots and video moments as a grid |
| **Dig Up Code** | The code index |
| **Sync Messages** | Export and index new messages now (it also happens on its own) |
| **Index Status** | What's in DigUp's index |

| Key | |
|---|---|
| ↩ | Open: videos at the moment, PDFs with the words in Preview's search, code in your editor at the line, chats in Messages or Beeper |
| ⌘↩ | Show in Finder |
| ⌘Y | Quick Look |
| ⌘C | Copy the file (for a chat, the message) |
| ⌘O | The same search as a picture grid |
| ⌘⇧C / ⌘⇧P | Copy path / show or hide the preview |

## How it works

```
your folders ──► DigUp (menu bar, no window) ──► ~/Library/Application Support/DigUp/index.noindex
iMessage chat.db ─┐
Beeper index.db ──┴► sync agent ──► DigUp Messages/ (a Markdown file per chat per month + attachment clones)
                                   └► digup index ──► DigUp Messages Index/
Raycast ──► digup search-service × 2 (both indexes, merged by score) ──► results
```

- **Search** runs DigUp's own searcher (`DigUp.app/Contents/Helpers/digup search-service`) with DigUp's folder
  settings, so results match DigUp's: keyword matches as you type, meaning once you pause (`src/digup.ts`,
  `src/use-search.ts`).
- **Messages** (`src/messages.ts`): iMessage/SMS/RCS from `~/Library/Messages/chat.db` (names from Contacts,
  attachments from `~/Library/Messages/Attachments`), and Beeper from Beeper Desktop's local
  `~/Library/Application Support/BeeperTexts/index.db` (media Beeper has downloaded, from `BeeperTexts/media/`). Each
  chat becomes one Markdown file per month in `~/Library/Application Support/DigUp Messages/`, its attachments APFS
  clones beside it (no extra disk space), indexed into their own index so new messages are searchable within seconds
  instead of waiting behind DigUp's pass over your files.
- **Staying current**: the `com.digup-ray.messages-sync` LaunchAgent runs whenever either database changes (and every
  5 minutes), through a small helper binary so Full Disk Access goes to it alone, not to Node. Log:
  `~/Library/Application Support/DigUp Messages Sync/sync.log`.
- **DigUp in the background**: the `com.digup-ray.digup` LaunchAgent starts DigUp at login without its window; the
  extension also starts it, hidden, if it isn't running.

## Uninstall

```sh
for a in com.digup-ray.digup com.digup-ray.messages-sync; do
  launchctl bootout gui/$(id -u)/$a; rm ~/Library/LaunchAgents/$a.plist
done
rm -rf ~/Library/Application\ Support/DigUp\ Messages*
brew uninstall --cask --zap digup      # DigUp itself, its model and index
```

Then remove the extension in Raycast (Settings → Extensions → DigUp → Uninstall).

## Develop

```sh
npm install
npm run dev                          # loads it into Raycast, rebuilds on save
scripts/install-sync-agent.sh        # after changing src/messages.ts or src/sync-cli.ts
```

DigUp is by [Abdur Rahim](https://github.com/ARahim3/DigUp) (MIT). This extension is MIT too.
