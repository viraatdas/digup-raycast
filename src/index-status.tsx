import { Action, ActionPanel, Icon, Keyboard, List, open, showHUD } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { APP_PATH, appSetting, helperPath } from "./digup";
import { MESSAGES_INDEX } from "./messages";

// Status: is everything Dig Up needs in place, how far indexing is, and a fix for whatever isn't right.

const run = promisify(execFile);
const HOME = homedir();
const SYNC_DIR = join(HOME, "Library/Application Support/DigUp Messages Sync");
const SYNC_HELPER = join(SYNC_DIR, "DigUp Messages Sync");
const SYNC_LOG = join(SYNC_DIR, "sync.log");
const FULL_DISK_ACCESS = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
const MODEL = join(HOME, "Library/Application Support/DigUp/Models/mmproj-embeddinggemma-2-Q8_0.gguf");

type State = "ok" | "working" | "problem" | "off";
interface Check {
  title: string;
  state: State;
  detail: string;
  fix?: { title: string; run: () => Promise<unknown> | void };
}

const ICONS: Record<State, { source: Icon; tintColor: string }> = {
  ok: { source: Icon.CheckCircle, tintColor: "#34C759" },
  working: { source: Icon.CircleProgress50, tintColor: "#0A84FF" },
  problem: { source: Icon.ExclamationMark, tintColor: "#FF9F0A" },
  off: { source: Icon.Circle, tintColor: "#8E8E93" },
};

/** `digup status`: the vector count and what's still pending per kind. */
async function indexStatus(index?: string) {
  const args = ["status", ...(index ? ["--index", index] : [])];
  const { stdout } = await run(helperPath(), args, { maxBuffer: 1 << 22 });
  const vectors = /vectors: ([\d,]+)/.exec(stdout)?.[1] ?? "0";
  let pending = 0;
  let done = 0;
  for (const match of stdout.matchAll(/(\d[\d,]*) (done|pending|partial)/g)) {
    const count = Number(match[1].replace(/,/g, ""));
    if (match[2] === "done") done += count;
    else pending += count;
  }
  return { vectors, pending, done, raw: stdout };
}

async function checks(): Promise<{ list: Check[]; raw: string }> {
  const list: Check[] = [];
  const installed = existsSync(helperPath());
  list.push(
    installed
      ? { title: "DigUp installed", state: "ok", detail: APP_PATH }
      : {
          title: "DigUp isn't installed",
          state: "problem",
          detail: "brew install --cask arahim3/tap/digup",
          fix: { title: "Get DigUp", run: () => open("https://github.com/ARahim3/DigUp/releases/latest") },
        },
  );
  if (!installed) return { list, raw: "" };

  list.push(
    existsSync(MODEL)
      ? { title: "Model downloaded", state: "ok", detail: "EmbeddingGemma 2" }
      : {
          title: "Model not downloaded yet",
          state: "problem",
          detail: "865 MB, once",
          fix: {
            title: "Download Model",
            run: async () => {
              await showHUD("Downloading DigUp's model…");
              await run(helperPath(), ["download-model"], { maxBuffer: 1 << 24 });
              await showHUD("Model ready");
            },
          },
        },
  );

  const running = await run("/usr/bin/pgrep", ["-x", "DigUp"]).then(
    () => true,
    () => false,
  );
  list.push(
    running
      ? { title: "DigUp indexing in the background", state: "ok", detail: "new files are searchable a moment later" }
      : {
          title: "DigUp isn't running",
          state: "problem",
          detail: "nothing new gets indexed until it runs",
          fix: {
            title: "Start DigUp in the Background",
            run: () => run("/usr/bin/open", ["-g", "-a", APP_PATH, "--args", "-debugWaitForIndex", "NO"]),
          },
        },
  );

  const roots = appSetting<string[]>("roots") ?? [];
  const index = appSetting<string>("indexDir")?.replace(/^~/, HOME);
  let raw = "";
  try {
    const main = await indexStatus(index);
    raw = main.raw;
    list.push({
      title: main.pending > 0 ? "Indexing your files" : "Files indexed",
      state: main.pending > 0 ? "working" : "ok",
      detail:
        `${main.done.toLocaleString()} done` +
        (main.pending ? ` · ${main.pending.toLocaleString()} to go` : "") +
        ` · ${roots.map((root) => root.replace(HOME, "~")).join(", ") || "no folders chosen"}`,
    });
  } catch (error) {
    list.push({ title: "Couldn't read DigUp's index", state: "problem", detail: String(error).slice(0, 200) });
  }

  // Messages: the sync agent, its last run, and the messages' own index.
  if (!existsSync(SYNC_HELPER)) {
    list.push({
      title: "Messages not set up",
      state: "off",
      detail: "run ./setup.sh (without --no-messages) to search iMessage and Beeper",
    });
    return { list, raw };
  }
  let last: { at?: string; errors?: string[] } = {};
  try {
    const lines = readFileSync(SYNC_LOG, "utf8").trim().split("\n");
    for (const line of lines.reverse()) {
      if (line.startsWith("{") && !line.includes('"step":"index"')) {
        last = JSON.parse(line);
        break;
      }
    }
  } catch {
    // no runs yet
  }
  const needsAccess = (last.errors ?? []).some((error) => error.includes("Full Disk Access"));
  list.push(
    needsAccess
      ? {
          title: "iMessage needs Full Disk Access",
          state: "problem",
          detail: "add “DigUp Messages Sync” in Full Disk Access (drag it from Finder into the list)",
          fix: {
            title: "Open Full Disk Access and Show the Helper",
            run: async () => {
              await open(FULL_DISK_ACCESS);
              await run("/usr/bin/open", ["-R", SYNC_HELPER]);
            },
          },
        }
      : last.errors?.length
        ? { title: "Message sync had a problem", state: "problem", detail: last.errors.join(" · ").slice(0, 200) }
        : {
            title: "Messages syncing",
            state: last.at ? "ok" : "working",
            detail: last.at ? `last synced ${new Date(last.at).toLocaleString()}` : "first sync running",
          },
  );
  try {
    const messages = await indexStatus(MESSAGES_INDEX);
    list.push({
      title: messages.pending > 0 ? "Indexing messages" : "Messages indexed",
      state: messages.pending > 0 ? "working" : "ok",
      detail:
        `${messages.done.toLocaleString()} chats and attachments done` +
        (messages.pending ? ` · ${messages.pending.toLocaleString()} to go` : ""),
    });
  } catch {
    list.push({ title: "Messages index not built yet", state: "working", detail: "the sync builds it" });
  }
  return { list, raw };
}

export default function Command() {
  const { data, isLoading, revalidate } = usePromise(checks);
  return (
    <List isLoading={isLoading} isShowingDetail={false} navigationTitle="Dig Up Status">
      {(data?.list ?? []).map((check) => (
        <List.Item
          key={check.title}
          icon={ICONS[check.state]}
          title={check.title}
          subtitle={check.detail}
          actions={
            <ActionPanel>
              {check.fix ? (
                <Action
                  title={check.fix.title}
                  icon={Icon.Hammer}
                  onAction={async () => {
                    await check.fix!.run();
                    revalidate();
                  }}
                />
              ) : null}
              <Action
                title="Refresh"
                icon={Icon.ArrowClockwise}
                shortcut={Keyboard.Shortcut.Common.Refresh}
                onAction={revalidate}
              />
              <Action
                title="Sync Messages Now"
                icon={Icon.Message}
                onAction={() => open("raycast://extensions/viraat/digup/sync-messages")}
              />
              {data?.raw ? <Action.CopyToClipboard title="Copy Index Details" content={data.raw} /> : null}
              <Action title="Open DigUp Settings" icon={Icon.Gear} onAction={() => open(APP_PATH)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
