import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";

// Messages for DigUp: iMessage (~/Library/Messages/chat.db) and Beeper (Beeper Desktop's local index.db) written out
// as one Markdown file per chat per month, with the chat's attachments beside them as APFS clones (no extra disk
// space) under names DigUp can classify. DigUp indexes the folder like any other, so messages and their pictures,
// videos, voice notes and PDFs are searched by meaning with everything else. Nothing leaves the Mac.
//
// No Raycast imports here: `node` can run it from a terminal for the first, long export.

const HOME = homedir();
export const EXPORT_ROOT = join(HOME, "Library/Application Support/DigUp Messages");
const MANIFEST = join(EXPORT_ROOT, ".manifest.json");
const CHAT_DB = join(HOME, "Library/Messages/chat.db");
const BEEPER_DIR = join(HOME, "Library/Application Support/BeeperTexts");
const BEEPER_DB = join(BEEPER_DIR, "index.db");
const ADDRESS_BOOK = join(HOME, "Library/Application Support/AddressBook");

/** Attachments DigUp reads: pictures, recordings, videos and documents. */
const MEDIA = new Set([
  "jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "tiff", "tif", "bmp", "dng",
  "mov", "mp4", "m4v", "3gp", "webm",
  "m4a", "caf", "mp3", "aac", "wav", "amr", "ogg", "opus",
  "pdf", "txt", "md", "rtf", "doc", "docx", "html",
]); // prettier-ignore

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/gif": "gif", "image/webp": "webp",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/x-caf": "caf",
  "application/pdf": "pdf",
}; // prettier-ignore

export type Source = "imessage" | "beeper";

export interface ChatEntry {
  source: Source;
  /** iMessage: the chat's ROWID; Beeper: the thread id. */
  id: string;
  title: string;
  /** "iMessage", "SMS", "WhatsApp"… */
  network: string;
  /** The folder the chat's files are in, relative to EXPORT_ROOT. */
  folder: string;
  /** iMessage 1:1 chats: the other person's phone or email; Beeper: the account id (for beeper:// links). */
  handle?: string;
  /** iMessage: a message's guid per month file ("2026-10"), for messages://open?message-guid=. */
  guids?: Record<string, string>;
}

interface Manifest {
  /** 2: month files carry a hidden list of their messages' ids (see writeMonth). */
  version: number;
  imessageRowID: number;
  beeperRowID: number;
  chats: Record<string, ChatEntry>; // key: `${source}:${id}`
}

const MANIFEST_VERSION = 2;

export function readManifest(): Manifest {
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
    // An export from before message ids: write every month again (unchanged text isn't rewritten, so DigUp doesn't
    // index it again; only the id lists are new). The chats' folders stay.
    if ((manifest.version ?? 1) < MANIFEST_VERSION) {
      return { ...manifest, version: MANIFEST_VERSION, imessageRowID: 0, beeperRowID: 0 };
    }
    return manifest;
  } catch {
    return { version: MANIFEST_VERSION, imessageRowID: 0, beeperRowID: 0, chats: {} };
  }
}

/** The chat a file in the export belongs to, or undefined when `path` isn't one of ours. */
export function chatOf(path: string, manifest = readManifest()): ChatEntry | undefined {
  if (!path.startsWith(EXPORT_ROOT + sep)) return undefined;
  const parts = relative(EXPORT_ROOT, path).split(sep);
  for (let depth = parts.length - 1; depth > 0; depth--) {
    const folder = parts.slice(0, depth).join(sep);
    const chat = Object.values(manifest.chats).find((entry) => entry.folder === folder);
    if (chat) return chat;
  }
  return undefined;
}

// MARK: SQLite

function query<T>(db: string, sql: string): T[] {
  // A WAL database read-only needs its -shm file; with no app holding it open (Beeper quit), there's none, and
  // nothing is writing, so it's read as an immutable snapshot.
  const target = existsSync(db + "-shm") ? db : `file:${encodeURI(db)}?immutable=1`;
  const out = execFileSync("/usr/bin/sqlite3", ["-readonly", "-json", target, sql], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.trim() ? (JSON.parse(out) as T[]) : [];
}

const quote = (text: string) => "'" + text.replace(/'/g, "''") + "'";

// MARK: Contacts

/** Phone numbers (last 10 digits) and emails → names, from the Contacts databases. */
function contacts(): Map<string, string> {
  const names = new Map<string, string>();
  const databases: string[] = [];
  const main = join(ADDRESS_BOOK, "AddressBook-v22.abcddb");
  if (existsSync(main)) databases.push(main);
  try {
    for (const source of readdirSync(join(ADDRESS_BOOK, "Sources"))) {
      const db = join(ADDRESS_BOOK, "Sources", source, "AddressBook-v22.abcddb");
      if (source && existsSync(db)) databases.push(db);
    }
  } catch {
    // no sources
  }
  type Row = { value: string; first?: string; last?: string; org?: string; nick?: string };
  const name = (row: Row) => [row.first, row.last].filter(Boolean).join(" ").trim() || row.nick || row.org || undefined;
  for (const db of databases) {
    try {
      const people = `r.ZFIRSTNAME as first, r.ZLASTNAME as last, r.ZORGANIZATION as org, r.ZNICKNAME as nick`;
      for (const row of query<Row>(
        db,
        `select p.ZFULLNUMBER as value, ${people} from ZABCDPHONENUMBER p join ZABCDRECORD r on r.Z_PK = p.ZOWNER`,
      )) {
        const key = phoneKey(row.value);
        const value = name(row);
        if (key && value && !names.has(key)) names.set(key, value);
      }
      for (const row of query<Row>(
        db,
        `select e.ZADDRESS as value, ${people} from ZABCDEMAILADDRESS e join ZABCDRECORD r on r.Z_PK = e.ZOWNER`,
      )) {
        const value = name(row);
        if (row.value && value) names.set(row.value.toLowerCase(), value);
      }
    } catch {
      // a source without these tables
    }
  }
  return names;
}

function phoneKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.includes("@")) return value.toLowerCase();
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-10) : undefined;
}

function contactName(names: Map<string, string>, handle: string | undefined): string | undefined {
  const key = phoneKey(handle);
  return key ? names.get(key) : undefined;
}

// MARK: Files

function safeName(text: string): string {
  const cleaned = text
    // eslint-disable-next-line no-control-regex -- control characters are what it removes
    .replace(/[/:\\\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();
  return (cleaned || "Untitled").slice(0, 80);
}

/** The chat's folder, kept once chosen (search results map back through it). */
function folderFor(manifest: Manifest, key: string, parent: string, title: string): string {
  const existing = manifest.chats[key]?.folder;
  if (existing) return existing;
  const taken = new Set(Object.values(manifest.chats).map((chat) => chat.folder));
  let folder = join(parent, safeName(title));
  for (let n = 2; taken.has(folder); n++) folder = join(parent, `${safeName(title)} (${n})`);
  return folder;
}

function writeIfChanged(path: string, content: string) {
  try {
    if (readFileSync(path, "utf8") === content) return;
  } catch {
    // new file
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + ".partial";
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

/** An APFS clone of the attachment (a copy that shares the original's blocks), once. */
function cloneAttachment(from: string, to: string): boolean {
  if (existsSync(to)) return false;
  try {
    if (!statSync(from).isFile()) return false;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to, constants.COPYFILE_FICLONE);
    return true;
  } catch {
    return false;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
const monthTitle = (key: string) => `${MONTHS[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`;
const dayTitle = (date: Date) =>
  date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const time = (date: Date) => date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const day = (date: Date) => date.toISOString().slice(0, 10);

interface Line {
  date: Date;
  sender: string;
  text: string;
  /** Where the app finds the message: iMessage's guid, Beeper's sort key. */
  ref: string;
}

/** A month of a chat as Markdown: a heading per day, a line per message. */
function monthFile(title: string, network: string, month: string, lines: Line[]): string {
  const out = [`# ${title} · ${network} · ${monthTitle(month)}`, ""];
  let current = "";
  for (const line of lines) {
    const today = dayTitle(line.date);
    if (today !== current) {
      out.push("", `## ${today}`, "");
      current = today;
    }
    out.push(`${line.sender}, ${time(line.date)}: ${line.text.replace(/\s*\n\s*/g, " / ")}`);
  }
  return out.join("\n") + "\n";
}

/** The ids of a month file's messages, in the order of its message lines (hidden, so DigUp doesn't index it). */
function refsFile(monthPath: string): string {
  return join(dirname(monthPath), "." + basename(monthPath, ".md") + ".refs.json");
}

function writeMonth(folder: string, title: string, network: string, month: string, lines: Line[]) {
  const path = join(EXPORT_ROOT, folder, `${safeName(title)} · ${monthTitle(month)}.md`);
  writeIfChanged(path, monthFile(title, network, month, lines));
  writeIfChanged(refsFile(path), JSON.stringify(lines.map((line) => line.ref)));
}

// MARK: iMessage

/** The text of an iMessage whose `text` column is empty: it's in attributedBody, an NSAttributedString typedstream. */
export function attributedText(hex: string | null | undefined): string | undefined {
  if (!hex) return undefined;
  const bytes = Buffer.from(hex, "hex");
  const marker = bytes.indexOf("NSString");
  if (marker < 0) return undefined;
  let at = bytes.indexOf(0x2b, marker + 8); // '+': the string follows
  if (at < 0) return undefined;
  at += 1;
  let length = bytes[at];
  at += 1;
  if (length === 0x81) {
    length = bytes.readUInt16LE(at);
    at += 2;
  } else if (length === 0x82) {
    length = bytes.readUInt32LE(at);
    at += 4;
  }
  const text = bytes.subarray(at, at + length).toString("utf8");
  return text.replace(/￼/g, "").trim() || undefined;
}

/** Nanoseconds (or seconds, before 2017) since 2001-01-01 → Date. */
const appleDate = (value: number) => new Date(Date.UTC(2001, 0, 1) + (value > 1e12 ? value / 1e6 : value * 1000));

const appleTime = (date: Date) => (date.getTime() - Date.UTC(2001, 0, 1)) * 1e6;

interface IMessageRow {
  rowid: number;
  guid: string;
  date: number;
  mine: number;
  text: string | null;
  body: string | null;
  handle: string | null;
}

function syncIMessage(manifest: Manifest, names: Map<string, string>, report: Report) {
  if (!existsSync(CHAT_DB)) return;
  let top: number;
  try {
    top = query<{ top: number }>(CHAT_DB, "select max(ROWID) as top from message")[0]?.top ?? 0;
  } catch (error) {
    report.errors.push(
      `iMessage: can't read chat.db (${firstLine(error)}). Give Full Disk Access to the app running this.`,
    );
    return;
  }
  const since = manifest.imessageRowID;
  if (top <= since) return;

  // Chats with new messages, and the first month that changed in each.
  const changed = query<{ chat: number; first: number }>(
    CHAT_DB,
    `select cmj.chat_id as chat, min(m.date) as first from message m
     join chat_message_join cmj on cmj.message_id = m.ROWID
     where m.ROWID > ${since} group by cmj.chat_id`,
  );
  type ChatRow = { id: number; identifier: string; name: string | null; style: number; service: string | null };
  const chats = new Map(
    query<ChatRow>(
      CHAT_DB,
      `select ROWID as id, chat_identifier as identifier, display_name as name, style, service_name as service from chat`,
    ).map((chat) => [chat.id, chat]),
  );
  const members = new Map<number, string[]>();
  for (const row of query<{ chat: number; handle: string }>(
    CHAT_DB,
    `select chj.chat_id as chat, h.id as handle from chat_handle_join chj join handle h on h.ROWID = chj.handle_id`,
  )) {
    members.set(row.chat, [...(members.get(row.chat) ?? []), row.handle]);
  }

  for (const { chat: chatID, first } of changed) {
    const chat = chats.get(chatID);
    if (!chat) continue;
    const people = members.get(chatID) ?? [];
    const group = chat.style === 43;
    const title =
      chat.name?.trim() ||
      (group
        ? people.map((handle) => contactName(names, handle) ?? handle).join(", ") || chat.identifier
        : (contactName(names, chat.identifier) ?? chat.identifier));
    const network = chat.service === "iMessage" ? "iMessage" : (chat.service ?? "SMS");
    const key = `imessage:${chatID}`;
    const folder = folderFor(manifest, key, "iMessage", title);
    const entry: ChatEntry = (manifest.chats[key] = {
      ...manifest.chats[key],
      source: "imessage",
      id: String(chatID),
      title,
      network,
      folder,
      handle: group ? undefined : chat.identifier,
      guids: manifest.chats[key]?.guids ?? {},
    });

    // Every month from the first that changed, written whole.
    const start = new Date(appleDate(first).getFullYear(), appleDate(first).getMonth(), 1);
    const rows = query<IMessageRow>(
      CHAT_DB,
      `select m.ROWID as rowid, m.guid, m.date, m.is_from_me as mine, m.text,
              case when m.text is null or m.text = '' then hex(m.attributedBody) end as body, h.id as handle
       from message m join chat_message_join cmj on cmj.message_id = m.ROWID
       left join handle h on h.ROWID = m.handle_id
       where cmj.chat_id = ${chatID} and m.date >= ${appleTime(start)} and m.associated_message_type = 0
             and m.item_type = 0
       order by m.date`,
    );
    const months = new Map<string, Line[]>();
    for (const row of rows) {
      const text = (row.text?.replace(/￼/g, "").trim() || attributedText(row.body))?.trim();
      if (!text) continue;
      const date = appleDate(row.date);
      const month = monthKey(date);
      const sender = row.mine ? "Me" : (contactName(names, row.handle ?? undefined) ?? row.handle ?? title);
      months.set(month, [...(months.get(month) ?? []), { date, sender, text, ref: row.guid }]);
      entry.guids![month] = row.guid;
    }
    for (const [month, lines] of months) {
      writeMonth(folder, title, network, month, lines);
      report.files++;
    }

    // Its attachments that are on this Mac (the rest are in iCloud until Messages downloads them).
    type AttachmentRow = {
      rowid: number;
      filename: string | null;
      name: string | null;
      mime: string | null;
      date: number;
    };
    for (const row of query<AttachmentRow>(
      CHAT_DB,
      `select a.ROWID as rowid, a.filename, a.transfer_name as name, a.mime_type as mime, m.date
       from attachment a join message_attachment_join maj on maj.attachment_id = a.ROWID
       join message m on m.ROWID = maj.message_id join chat_message_join cmj on cmj.message_id = m.ROWID
       where cmj.chat_id = ${chatID} and m.ROWID > ${since} and a.filename is not null`,
    )) {
      const from = row.filename!.replace(/^~/, HOME);
      const ext = extname(from).slice(1).toLowerCase() || MIME_EXTENSIONS[row.mime ?? ""] || "";
      if (!MEDIA.has(ext)) continue;
      const stem = safeName(basename(row.name ?? from, extname(row.name ?? from))).slice(0, 60);
      const to = join(EXPORT_ROOT, folder, "Attachments", `${day(appleDate(row.date))} ${stem} ${row.rowid}.${ext}`);
      if (cloneAttachment(from, to)) report.attachments++;
    }
  }
  manifest.imessageRowID = top;
}

// MARK: Beeper

const NETWORKS: Record<string, string> = {
  whatsapp: "WhatsApp", facebookgo: "Messenger", instagramgo: "Instagram", discordgo: "Discord", linkedin: "LinkedIn",
  telegram: "Telegram", signal: "Signal", slackgo: "Slack", twitter: "X", googlechat: "Google Chat", gmessages: "Google Messages",
  imessage: "iMessage", imessagego: "iMessage", hungryserv: "Beeper", bluesky: "Bluesky",
}; // prettier-ignore

function networkName(accountID: string | null): string {
  if (!accountID) return "Beeper";
  const base = accountID.replace(/[_-].*$/, "").toLowerCase();
  return NETWORKS[base] ?? NETWORKS[accountID] ?? base.charAt(0).toUpperCase() + base.slice(1);
}

interface BeeperRow {
  rowid: number;
  room: string;
  sender: string;
  ts: number;
  mine: number;
  type: string;
  text: string | null;
  sortKey: string | number | null;
  attachments: string | null;
}

function syncBeeper(manifest: Manifest, report: Report) {
  if (!existsSync(BEEPER_DB)) return;
  let top: number;
  try {
    top = query<{ top: number }>(BEEPER_DB, "select max(id) as top from mx_room_messages")[0]?.top ?? 0;
  } catch (error) {
    report.errors.push(`Beeper: can't read its index (${firstLine(error)})`);
    return;
  }
  const since = manifest.beeperRowID;
  if (top <= since) return;

  const changed = query<{ room: string; first: number }>(
    BEEPER_DB,
    `select roomID as room, min(timestamp) as first from mx_room_messages where id > ${since} group by roomID`,
  );
  type ThreadRow = { id: string; account: string | null; title: string | null; kind: string | null };
  const threads = new Map(
    query<ThreadRow>(
      BEEPER_DB,
      `select threadID as id, accountID as account, json_extract(thread, '$.title') as title,
              json_extract(thread, '$.type') as kind from threads`,
    ).map((thread) => [thread.id, thread]),
  );
  const people = new Map<string, Map<string, string>>(); // room → sender id → name
  const others = new Map<string, string[]>(); // room → the other people's names
  for (const row of query<{ room: string; id: string; name: string | null; self: number | null }>(
    BEEPER_DB,
    `select room_id as room, id, coalesce(nullif(full_name, ''), nickname) as name, is_self as self from participants`,
  )) {
    if (!row.name) continue;
    if (!people.has(row.room)) people.set(row.room, new Map());
    people.get(row.room)!.set(row.id, row.name);
    if (!row.self) others.set(row.room, [...(others.get(row.room) ?? []), row.name]);
  }

  for (const { room, first } of changed) {
    const thread = threads.get(room);
    if (!thread) continue;
    const network = networkName(thread.account);
    if (network === "iMessage") continue; // already exported from chat.db
    const names = [...new Set(others.get(room) ?? [])];
    const title = thread.title?.trim() || names.slice(0, 4).join(", ") || "Chat";
    const key = `beeper:${room}`;
    const folder = folderFor(manifest, key, join("Beeper", safeName(network)), title);
    manifest.chats[key] = { source: "beeper", id: room, title, network, folder, handle: thread.account ?? undefined };

    const start = new Date(new Date(first).getFullYear(), new Date(first).getMonth(), 1).getTime();
    const rows = query<BeeperRow>(
      BEEPER_DB,
      `select id as rowid, roomID as room, senderContactID as sender, timestamp as ts, isSentByMe as mine, type,
              json_extract(message, '$.text') as text, json_extract(message, '$.sortKey') as sortKey,
              json_extract(message, '$.attachments') as attachments
       from mx_room_messages
       where roomID = ${quote(room)} and timestamp >= ${start} and isDeleted = 0
             and type in ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'VOICE', 'FILE')
       order by timestamp`,
    );
    const months = new Map<string, Line[]>();
    const senders = people.get(room);
    for (const row of rows) {
      const date = new Date(row.ts);
      const sender = row.mine ? "Me" : (senders?.get(row.sender) ?? "Them");
      const text = row.text?.trim();
      if (text) {
        const month = monthKey(date);
        months.set(month, [...(months.get(month) ?? []), { date, sender, text, ref: String(row.sortKey ?? "") }]);
      }
      if (!row.attachments || row.rowid <= since) continue;
      let attachments: { id?: string; fileName?: string; mimeType?: string }[] = [];
      try {
        attachments = JSON.parse(row.attachments);
      } catch {
        continue;
      }
      for (const attachment of attachments) {
        const media = attachment.id?.startsWith("mxc://")
          ? join(BEEPER_DIR, "media", attachment.id.slice(6))
          : undefined;
        if (!media || !existsSync(media)) continue; // not downloaded by Beeper yet
        const ext =
          MIME_EXTENSIONS[attachment.mimeType ?? ""] ||
          extname(attachment.fileName ?? "")
            .slice(1)
            .toLowerCase();
        if (!MEDIA.has(ext)) continue;
        const stem = safeName(basename(attachment.fileName ?? "attachment", extname(attachment.fileName ?? ""))).slice(
          0,
          60,
        );
        const tag = createHash("sha1").update(attachment.id!).digest("hex").slice(0, 6);
        const to = join(EXPORT_ROOT, folder, "Attachments", `${day(date)} ${stem} ${tag}.${ext}`);
        if (cloneAttachment(media, to)) report.attachments++;
      }
    }
    for (const [month, lines] of months) {
      writeMonth(folder, title, network, month, lines);
      report.files++;
    }
  }
  manifest.beeperRowID = top;
}

// MARK: Sync

export interface Report {
  files: number;
  attachments: number;
  errors: string[];
}

function firstLine(error: unknown): string {
  return String((error as { stderr?: string }).stderr || error)
    .split("\n")[0]
    .slice(0, 200);
}

/** Brings the export up to date with both sources; only chats with new messages are rewritten. */
export function syncMessages(): Report {
  mkdirSync(EXPORT_ROOT, { recursive: true });
  const manifest = readManifest();
  const report: Report = { files: 0, attachments: 0, errors: [] };
  const names = contacts();
  syncIMessage(manifest, names, report);
  writeIfChanged(MANIFEST, JSON.stringify(manifest)); // progress kept even if Beeper fails
  syncBeeper(manifest, report);
  writeIfChanged(MANIFEST, JSON.stringify(manifest));
  return report;
}

/** The messages' own index: kept apart from DigUp's main one so new messages are searchable within seconds, not
 *  after DigUp's pass over the home folder (and the chats never wait behind thousands of photos). */
export const MESSAGES_INDEX = join(HOME, "Library/Application Support/DigUp Messages Index");
const DIGUP = "/Applications/DigUp.app/Contents/Helpers/digup";
const MEDIA_EXTENSIONS = [...MEDIA].filter((ext) => !["txt", "md", "rtf", "doc", "docx", "html"].includes(ext));

/** Indexes what's new in the export: the chats' text first, then their attachments. */
export function indexMessages(options: { attachments: boolean }): string | undefined {
  if (!existsSync(DIGUP)) return "DigUp isn't installed";
  const run = (extra: string[]) =>
    spawnSync(DIGUP, ["index", EXPORT_ROOT, "--index", MESSAGES_INDEX, ...extra], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: 1 << 26,
    });
  mkdirSync(MESSAGES_INDEX, { recursive: true });
  const text = run(["--exclude-ext", MEDIA_EXTENSIONS.join(",")]);
  if (text.status !== 0) return `digup index: ${text.stderr?.trim().split("\n").pop()}`;
  if (!options.attachments) return undefined;
  const all = run([]);
  return all.status === 0 ? undefined : `digup index: ${all.stderr?.trim().split("\n").pop()}`;
}

/** The export is searched through its own index, so it must not be one of DigUp's folders too (twice the work, and
 *  every chat found twice). Returns whether it had to be taken out. */
export function keepOutOfDigUpRoots(): boolean {
  const domain = "com.abdurrahim.DigUp";
  let roots: string[] = [];
  try {
    const plist = execFileSync("/usr/bin/defaults", ["export", domain, "-"], { encoding: "utf8" });
    roots = JSON.parse(
      execFileSync("/usr/bin/plutil", ["-extract", "roots", "json", "-o", "-", "-"], {
        input: plist,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }),
    );
  } catch {
    return false;
  }
  if (!roots.includes(EXPORT_ROOT)) return false;
  execFileSync("/usr/bin/defaults", [
    "write",
    domain,
    "roots",
    "-array",
    ...roots.filter((root) => root !== EXPORT_ROOT),
  ]);
  return true;
}

// MARK: Back to the app

/** The words of an excerpt with DigUp's «» marks and ellipses gone. */
function plain(excerpt: string): string {
  return excerpt.replace(/[«»]/g, "").replace(/…/g, " ").replace(/\s+/g, " ").trim();
}

/** The iMessage a search hit points at: one in the chat whose text holds the longest run of the excerpt's words. */
export function messageGuid(chat: ChatEntry, excerpt: string | undefined, month?: string): string | undefined {
  if (chat.source !== "imessage") return undefined;
  const text = plain(excerpt ?? "").replace(/^[^:]{1,60}, \d{1,2}:\d{2}\s?[AP]M: /, "");
  // The excerpt's longest stretch between line joins (" / "), as a LIKE pattern.
  const fragment = text
    .split(" / ")
    .sort((a, b) => b.length - a.length)[0]
    ?.slice(0, 60)
    .trim();
  if (fragment && fragment.length >= 8) {
    try {
      const pattern = fragment.replace(/[%_\\]/g, (c) => "\\" + c);
      const row = query<{ guid: string }>(
        CHAT_DB,
        `select m.guid from message m join chat_message_join cmj on cmj.message_id = m.ROWID
         where cmj.chat_id = ${Number(chat.id)} and m.text like ${quote("%" + pattern + "%")} escape '\\'
         order by m.date desc limit 1`,
      )[0];
      if (row) return row.guid;
    } catch {
      // no access to chat.db from here
    }
  }
  return month ? chat.guids?.[month] : undefined;
}

const MESSAGE_LINE = /^[^:\n]{1,80}, \d{1,2}:\d{2}\s?[AP]M: /;
const STOP_WORDS = new Set(["the", "and", "for", "that", "this", "with", "about", "what", "when", "where", "was", "were",
  "you", "your", "she", "her", "his", "him", "they", "them", "said", "say", "message", "messages", "text", "chat"]); // prettier-ignore

/** The message a hit on a month file points at, and its id: of the file's messages that are in the matched stretch
 *  (`passage`, the segment's text), the one sharing the most words with the search and the excerpt's marked words. */
export function messageAt(
  path: string,
  options: { passage?: string; query?: string; excerpt?: string },
): { ref: string; line: string } | undefined {
  let lines: string[];
  let refs: string[];
  try {
    lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => MESSAGE_LINE.test(line));
    refs = JSON.parse(readFileSync(refsFile(path), "utf8"));
  } catch {
    return undefined;
  }
  if (lines.length !== refs.length || lines.length === 0) return undefined;
  const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? [];
  const wanted = new Map<string, number>();
  for (const word of words(options.query ?? "")) if (!STOP_WORDS.has(word)) wanted.set(word, 1);
  for (const marked of (options.excerpt ?? "").match(/«([^»]+)»/g) ?? []) {
    for (const word of words(marked)) wanted.set(word, 2);
  }
  const passage = options.passage?.replace(/[«»]/g, "");
  let best = -1;
  let bestScore = -1;
  lines.forEach((line, index) => {
    const body = line.replace(MESSAGE_LINE, "");
    if (passage && !passage.includes(body.slice(0, 60))) return;
    const score = [...new Set(words(line))].reduce((sum, word) => sum + (wanted.get(word) ?? 0), 0);
    if (score > bestScore) [best, bestScore] = [index, score];
  });
  if (best < 0) return undefined;
  return refs[best] ? { ref: refs[best], line: lines[best] } : undefined;
}

/** "2026-10" from an export file name ("Mom · Oct 2026.md"). */
export function monthOfFile(path: string): string | undefined {
  const match = / · ([A-Z][a-z]{2}) (\d{4})\.md$/.exec(path);
  if (!match) return undefined;
  const index = MONTHS.indexOf(match[1]);
  return index < 0 ? undefined : `${match[2]}-${String(index + 1).padStart(2, "0")}`;
}

/** The text of the excerpt, for copying. */
export function excerptText(excerpt: string | undefined): string {
  return plain(excerpt ?? "");
}
