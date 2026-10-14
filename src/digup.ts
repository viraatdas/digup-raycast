import { getPreferenceValues } from "@raycast/api";
import { ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { MESSAGES_INDEX } from "./messages";

// DigUp's searcher, run as `digup search-service`: the same index, ranking and query encoder as DigUp's own panel,
// over JSON lines (Sources/digup/SearchService.swift in DigUp).

export const APP_PATH = "/Applications/DigUp.app";
export const BUNDLE_ID = "com.abdurrahim.DigUp";

export type Kind = "screenshot" | "image" | "pdf" | "doc" | "audio" | "video" | "code";
export type Segment =
  "name" | "image" | "ocr" | "page" | "page_image" | "chunk" | "audio" | "frame" | "lines" | "cells";

export interface Hit {
  path: string;
  kind: Kind;
  segment: Segment;
  segment_id: number;
  score: number;
  modified: number;
  size: number;
  info: Record<string, string>;
  /** Found in the messages' own index (its segment ids are its own). */
  fromMessages?: boolean;
  z?: number;
  cosine?: number;
  keyword_rank?: number;
  loc?: number;
  loc_end?: number;
  focus?: number;
  excerpt?: string;
}

export interface SearchReply {
  hits: Hit[];
  strong: number;
  meaning: boolean;
  warning?: string;
}

export interface Preferences {
  codeEditor?: string;
  digupPath?: string;
}

export function helperPath(): string {
  const chosen = getPreferenceValues<Preferences>().digupPath?.trim();
  return chosen ? chosen.replace(/^~/, homedir()) : join(APP_PATH, "Contents/Helpers/digup");
}

export function helperInstalled(): boolean {
  return existsSync(helperPath());
}

/** One of DigUp's saved settings, or undefined (read from the defaults DigUp's app writes). */
export function appSetting<T>(key: string): T | undefined {
  try {
    const plist = execFileSync("/usr/bin/defaults", ["export", BUNDLE_ID, "-"], { encoding: "utf8" });
    const json = execFileSync("/usr/bin/plutil", ["-extract", key, "json", "-o", "-", "-"], {
      input: plist,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

/** A list of folders as the app keeps them: an array, or paths joined with ":". */
function folders(key: string): string[] {
  const value = appSetting<string[] | string>(key);
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(":") : [];
  return list.filter((path) => path.length > 0);
}

/** The arguments that make the service search what DigUp's panel searches: the chosen folders, minus what's skipped. */
function serviceArguments(): string[] {
  const args = ["search-service", ...folders("roots")];
  for (const folder of folders("excludedFolders")) args.push("--exclude", folder);
  const types = appSetting<string[] | string>("excludedTypes");
  for (const type of Array.isArray(types) ? types : types ? [types] : []) args.push("--exclude-ext", type);
  for (const folder of folders("codeRoots")) args.push("--code-root", folder);
  for (const folder of folders("codeExcludedFolders")) args.push("--code-exclude", folder);
  const index = appSetting<string>("indexDir");
  if (index) args.push("--index", index.replace(/^~/, homedir()));
  // The encoder goes soon after Raycast's window closes anyway (the service ends with it); this covers a window left open.
  args.push("--encoder-idle", "120");
  return args;
}

type Pending = { resolve: (reply: Record<string, unknown>) => void; reject: (error: Error) => void };

/** One `digup search-service` process over one index. */
class ServiceProcess {
  private process: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextID = 1;
  private closed = false;
  private stderr = "";
  onEvent?: (event: Record<string, unknown>) => void;

  constructor(args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const models = appSetting<string>("modelsDir");
    if (models) env.DIGUP_MODELS = models.replace(/^~/, homedir());
    this.process = spawn(helperPath(), args, { env });
    createInterface({ input: this.process.stdout }).on("line", (line) => this.receive(line));
    this.process.stderr.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-2000);
    });
    const fail = (error: Error) => {
      this.closed = true;
      for (const waiting of this.pending.values()) waiting.reject(error);
      this.pending.clear();
    };
    this.process.on("error", fail);
    this.process.on("exit", (code) => fail(new Error(this.stderr.trim() || `digup search-service exited (${code})`)));
  }

  private receive(line: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const waiting = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.ok === false) waiting.reject(new Error(String(message.error ?? "digup failed")));
      else waiting.resolve(message);
    } else if (message.event) {
      this.onEvent?.(message);
    }
  }

  request<T = Record<string, unknown>>(op: string, fields: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error(this.stderr.trim() || "digup search-service isn't running"));
    const id = this.nextID++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (reply: Record<string, unknown>) => void, reject });
      this.process.stdin.write(JSON.stringify({ ...fields, op, id }) + "\n");
    });
  }

  search(q: string, options: { code: boolean; kinds?: Kind[]; meaning: boolean; limit?: number }) {
    return this.request<SearchReply>("search", {
      q,
      code: options.code,
      kinds: options.kinds,
      meaning: options.meaning,
      prefix_last: !options.meaning,
      limit: options.limit ?? 40,
    });
  }

  embedAhead(q: string, code: boolean) {
    return this.request("embed_ahead", { q, code }).catch(() => undefined);
  }

  async text(segment: number, code: boolean): Promise<string | undefined> {
    const reply = await this.request<{ text: string | null }>("text", { segment, code });
    return reply.text ?? undefined;
  }

  async render(path: string, kind: "pdf" | "video" | "image", loc?: number): Promise<string> {
    const reply = await this.request<{ image: string }>("render", { path, kind, loc, pixels: 1024 });
    return reply.image;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.process.stdin.write(JSON.stringify({ op: "quit", id: 0 }) + "\n");
    this.process.stdin.end();
    setTimeout(() => this.process.kill(), 2000).unref();
  }
}

export type Scope = "everything" | "messages" | "files";

/** DigUp's index and the messages' own, searched as one: results merged by score, strong matches first. */
export class SearchService {
  private main: ServiceProcess;
  private messages?: ServiceProcess;

  constructor() {
    this.main = new ServiceProcess(serviceArguments());
    if (existsSync(join(MESSAGES_INDEX, "index.sqlite"))) {
      this.messages = new ServiceProcess(["search-service", "--index", MESSAGES_INDEX, "--encoder-idle", "120"]);
    }
  }

  set onEvent(handler: ((event: Record<string, unknown>) => void) | undefined) {
    this.main.onEvent = handler;
  }

  request<T = Record<string, unknown>>(op: string, fields: Record<string, unknown> = {}): Promise<T> {
    this.messages?.request(op, fields).catch(() => undefined);
    return this.main.request<T>(op, fields);
  }

  async search(
    q: string,
    options: { code: boolean; kinds?: Kind[]; meaning: boolean; limit?: number; scope?: Scope },
  ): Promise<SearchReply> {
    const scope = options.code ? "files" : (options.scope ?? "everything");
    const replies = await Promise.all([
      scope !== "messages" ? this.main.search(q, options) : undefined,
      scope !== "files" && this.messages
        ? this.messages
            .search(q, { ...options, code: false })
            .then((reply) => ({ ...reply, hits: reply.hits.map((hit) => ({ ...hit, fromMessages: true })) }))
            .catch(() => undefined)
        : undefined,
    ]);
    const present = replies.filter((reply): reply is SearchReply => reply !== undefined);
    const byScore = (a: Hit, b: Hit) => b.score - a.score;
    const strong = present.flatMap((reply) => reply.hits.slice(0, reply.meaning ? reply.strong : reply.hits.length));
    const weaker = present.flatMap((reply) => reply.hits.slice(reply.meaning ? reply.strong : reply.hits.length));
    return {
      hits: [...strong.sort(byScore), ...weaker.sort(byScore)].slice(0, options.limit ?? 40),
      strong: strong.length,
      meaning: present.some((reply) => reply.meaning),
      warning: present.find((reply) => reply.warning)?.warning,
    };
  }

  embedAhead(q: string, code: boolean) {
    if (!code) this.messages?.embedAhead(q, false);
    return this.main.embedAhead(q, code);
  }

  text(hit: Hit, code: boolean): Promise<string | undefined> {
    return (hit.fromMessages && this.messages ? this.messages : this.main).text(hit.segment_id, code);
  }

  render(path: string, kind: "pdf" | "video" | "image", loc?: number): Promise<string> {
    return this.main.render(path, kind, loc);
  }

  close() {
    this.main.close();
    this.messages?.close();
  }
}

/** "code: retry with backoff" → the words to search the code index for, or undefined when it isn't a code search. */
export function codeQuery(text: string): string | undefined {
  const match = /^\s*code\s*:\s*/i.exec(text);
  return match ? text.slice(match[0].length) : undefined;
}

export function clock(seconds: number): string {
  const total = Math.floor(seconds);
  const pad = (value: number) => String(value).padStart(2, "0");
  return total >= 3600
    ? `${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`
    : `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

/** Where in the file the match is, as DigUp's CLI says it: "p. 3", "at 1:04", "lines 10–42". */
export function place(hit: Hit): string | undefined {
  const { loc, loc_end: end } = hit;
  switch (hit.segment) {
    case "page":
    case "page_image":
      return loc !== undefined ? `p. ${Math.floor(loc)}` : undefined;
    case "audio":
    case "frame":
      return loc !== undefined ? `at ${clock(loc)}` + (hit.segment === "audio" ? " (sound)" : "") : undefined;
    case "chunk":
      return loc !== undefined ? `part ${Math.floor(loc)}` : undefined;
    case "lines":
      return loc !== undefined ? `lines ${Math.floor(loc)}–${Math.floor(end ?? loc)}` : undefined;
    case "cells":
      return loc !== undefined ? (loc === end ? `cell ${loc}` : `cells ${loc}–${end ?? loc}`) : undefined;
    case "ocr":
      return "text in image";
    default:
      return undefined;
  }
}

/** Seconds into a recording where the match starts. */
export function moment(hit: Hit): number | undefined {
  return (hit.kind === "video" || hit.kind === "audio") && (hit.segment === "frame" || hit.segment === "audio")
    ? hit.loc
    : undefined;
}

/** The PDF page that matched (1-based). */
export function page(hit: Hit): number | undefined {
  return hit.kind === "pdf" && (hit.segment === "page" || hit.segment === "page_image") && hit.loc !== undefined
    ? Math.floor(hit.loc)
    : undefined;
}

/** The line a code result opens at: where the name or words are, else where its stretch starts. */
export function codeLine(hit: Hit): number {
  return hit.segment === "lines" ? Math.max(1, Math.floor(hit.focus ?? hit.loc ?? 1)) : 1;
}
