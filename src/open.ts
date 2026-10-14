import { Clipboard, getApplications, getPreferenceValues, open, showHUD, showToast, Toast } from "@raycast/api";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { APP_PATH, appSetting, clock, codeLine, Hit, moment, page, Preferences } from "./digup";
import { ChatEntry, messageAt, messageGuid, monthOfFile } from "./messages";

// Opening a result the way DigUp's panel does (Sources/DigUpApp/Moments.swift and CodeEditors.swift in DigUp):
// recordings at their moment in QuickTime Player or IINA, PDFs with words from the match in Preview's search, and
// code in the chosen editor at the line.

const run = promisify(execFile);
const QUICKTIME = "com.apple.QuickTimePlayerX";
const IINA = "com.colliderli.iina";

/** The bundle id of the app that opens `path` by default. */
async function defaultApp(path: string): Promise<{ id?: string; path: string } | undefined> {
  const apps = await getApplications(path);
  return apps[0] ? { id: apps[0].bundleId, path: apps[0].path } : undefined;
}

export async function openTitle(hit: Hit): Promise<string> {
  if (hit.kind === "code") {
    const editor = codeEditor();
    const name = EDITORS[editor]?.name;
    return name ? `Open in ${name}` : "Open";
  }
  const at = moment(hit);
  if (at !== undefined && at >= 1) {
    const app = await defaultApp(hit.path);
    if (app?.id === QUICKTIME || app?.id === IINA) return `Open at ${clock(at)}`;
  }
  return "Open";
}

export async function openHit(hit: Hit) {
  try {
    if (hit.kind === "code") return await openCode(hit.path, codeLine(hit));
    const at = moment(hit);
    const app = await defaultApp(hit.path);
    if (at !== undefined && at >= 1 && app?.id === IINA) {
      const link = new URL("iina://open");
      link.searchParams.set("url", "file://" + encodeURI(hit.path));
      link.searchParams.set("mpv_start", at.toFixed(1));
      return await open(link.toString());
    }
    if (at !== undefined && at >= 1 && app?.id === QUICKTIME) return await openInQuickTime(hit.path, at);
    const words = searchWords(hit);
    if (page(hit) !== undefined && words && app) return await openSearching(hit.path, app.path, words);
    await open(hit.path);
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Couldn't open it", message: String(error) });
    await open(hit.path);
  }
}

/** Words from the matched page for Preview's search, so its sidebar lists the page (Preview won't go to a page itself). */
function searchWords(hit: Hit): string | undefined {
  const words = (hit.excerpt ?? "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  return words.length >= 2 ? words.slice(0, 5).join(" ") : undefined;
}

/** The Open Documents Apple event with keyAESearchText, as Spotlight opens a document (JXA for the ObjC bridge). */
async function openSearching(path: string, appPath: string, words: string) {
  const script = `
    ObjC.import("AppKit");
    function run(argv) {
      const url = $.NSURL.fileURLWithPath(argv[0]);
      const event = $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(
        0x61657674, 0x6f646f63, $(), -1, 0);  // kCoreEventClass 'aevt', kAEOpenDocuments 'odoc'
      const files = $.NSAppleEventDescriptor.listDescriptor;
      files.insertDescriptorAtIndex($.NSAppleEventDescriptor.descriptorWithFileURL(url), 0);
      event.setParamDescriptorForKeyword(files, 0x2d2d2d2d);  // keyDirectObject '----'
      event.setParamDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithString(argv[2]), 0x73747874);  // keyAESearchText 'stxt'
      const configuration = $.NSWorkspaceOpenConfiguration.configuration;
      configuration.appleEvent = event;
      let done = false;
      $.NSWorkspace.sharedWorkspace.openApplicationAtURLConfigurationCompletionHandler(
        $.NSURL.fileURLWithPath(argv[1]), configuration, () => { done = true; });
      const until = $.NSDate.dateWithTimeIntervalSinceNow(5);
      while (!done && $.NSDate.date.compare(until) < 0) {
        $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
      }
    }`;
  await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, path, appPath, words]);
}

async function openInQuickTime(path: string, seconds: number) {
  const script = `
    on run argv
      set theFile to POSIX file (item 1 of argv)
      set theTime to (item 2 of argv as integer) / 1000
      tell application "QuickTime Player"
        activate
        set theDocument to open theFile
        set current time of theDocument to theTime
        try
          set miniaturized of (first window whose document is theDocument) to false
        end try
        play theDocument
      end tell
    end run`;
  await run("/usr/bin/osascript", ["-e", script, path, String(Math.round(seconds * 1000))]);
}

// MARK: Code editors

type Method =
  | { type: "fileURL"; scheme: string }
  | { type: "command"; path: string }
  | { type: "xed" }
  | { type: "openURL"; scheme: string };

const EDITORS: Record<string, { name: string; method: Method }> = {
  "dev.zed.Zed": { name: "Zed", method: { type: "command", path: "Contents/MacOS/cli" } },
  "dev.zed.Zed-Preview": { name: "Zed Preview", method: { type: "command", path: "Contents/MacOS/cli" } },
  "com.todesktop.230313mzl4w4u92": { name: "Cursor", method: { type: "fileURL", scheme: "cursor" } },
  "com.microsoft.VSCode": { name: "Visual Studio Code", method: { type: "fileURL", scheme: "vscode" } },
  "com.microsoft.VSCodeInsiders": { name: "VS Code Insiders", method: { type: "fileURL", scheme: "vscode-insiders" } },
  "com.exafunction.windsurf": { name: "Windsurf", method: { type: "fileURL", scheme: "windsurf" } },
  "com.vscodium": { name: "VSCodium", method: { type: "fileURL", scheme: "vscodium" } },
  "com.sublimetext.4": { name: "Sublime Text", method: { type: "command", path: "Contents/SharedSupport/bin/subl" } },
  "com.sublimetext.3": { name: "Sublime Text 3", method: { type: "command", path: "Contents/SharedSupport/bin/subl" } },
  "com.apple.dt.Xcode": { name: "Xcode", method: { type: "xed" } },
  "com.barebones.bbedit": { name: "BBEdit", method: { type: "openURL", scheme: "x-bbedit" } },
  "com.macromates.TextMate": { name: "TextMate", method: { type: "openURL", scheme: "txmt" } },
};

/** The editor's bundle id: this extension's choice, or DigUp's own ("" for the file's default app). */
function codeEditor(): string {
  const chosen = getPreferenceValues<Preferences>().codeEditor ?? "digup";
  return chosen === "digup" ? (appSetting<string>("codeEditor") ?? "") : chosen;
}

async function openCode(path: string, line: number) {
  const id = codeEditor();
  const editor = EDITORS[id];
  const app = editor ? (await getApplications()).find((candidate) => candidate.bundleId === id) : undefined;
  if (!editor || !app) return open(path);
  const method = editor.method;
  switch (method.type) {
    case "fileURL":
      return open(`${method.scheme}://file${encodeURI(path)}:${line}:1`);
    case "openURL":
      return open(`${method.scheme}://open?url=${encodeURIComponent("file://" + path)}&line=${line}`);
    case "command": {
      const command = join(app.path, method.path);
      if (!existsSync(command)) return open(path, app.path);
      await run(command, [`${path}:${line}`]);
      return;
    }
    case "xed":
      await run(join(app.path, "Contents/Developer/usr/bin/xed"), ["--line", String(line), path]);
      return;
  }
}

/** ⌘O: DigUp's own search window, with the query on the clipboard (the app can't be handed a query from outside). */
export async function openInDigUp(query: string) {
  if (!existsSync(APP_PATH)) {
    await showToast({ style: Toast.Style.Failure, title: "DigUp isn't in /Applications" });
    return;
  }
  // Reopening a running DigUp shows its search window (applicationShouldHandleReopen).
  await run("/usr/bin/open", ["-a", APP_PATH]);
  if (query.trim()) {
    await Clipboard.copy(query);
    await showHUD("DigUp's window is open · query copied, paste with ⌘V");
  }
}

// MARK: Chats

const MESSAGES_APP = "/System/Applications/Messages.app";
const BEEPER_APP = "/Applications/Beeper Desktop.app";

export function chatApp(chat: ChatEntry): string {
  return chat.source === "imessage" ? MESSAGES_APP : BEEPER_APP;
}

/** Opens the chat a hit is in, at the message: the one in the matched stretch that best fits the search (see
 *  `messageAt`). Messages scrolls to it; Beeper loads the thread around its sort key and selects it. */
export async function openChat(chat: ChatEntry, hit?: Hit, context: { query?: string; passage?: string } = {}) {
  try {
    const message = hit ? messageAt(hit.path, { ...context, excerpt: hit.excerpt }) : undefined;
    if (chat.source === "beeper") {
      if (!chat.handle) return await open(BEEPER_APP);
      const thread = `beeper://select-thread/${encodeURIComponent(chat.handle)}/${encodeURIComponent(chat.id)}`;
      return await open(message ? `${thread}/${encodeURIComponent(message.ref)}` : thread);
    }
    const guid = message?.ref ?? messageGuid(chat, hit?.excerpt, hit ? monthOfFile(hit.path) : undefined);
    if (guid) return await open(`messages://open?message-guid=${encodeURIComponent(guid)}`);
    if (chat.handle) return await open(`imessage://${chat.handle}`, MESSAGES_APP);
    await open(MESSAGES_APP);
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Couldn't open the chat", message: String(error) });
  }
}
