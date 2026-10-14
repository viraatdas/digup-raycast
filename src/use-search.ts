import { showToast, Toast } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { execFile } from "node:child_process";
import { APP_PATH, helperInstalled, Hit, Kind, Scope, SearchService } from "./digup";
import { EXPORT_ROOT } from "./messages";

// One search, as DigUp's panel runs it: words found as you type (keyword search, instant), then meaning once you
// pause (the query encoder, kept warm by `digup search-service`).

const PAUSE_MS = 300;

/** The search service for as long as the command is open. */
export function useService() {
  const service = useRef<SearchService | null>(null);
  const [encoder, setEncoder] = useState("starting");
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    if (!helperInstalled()) {
      setFailure("DigUp isn't installed");
      return;
    }
    ensureIndexerRunning();
    const started = new SearchService();
    started.onEvent = (event) => {
      if (event.event === "encoder") setEncoder(String(event.state));
    };
    service.current = started;
    started
      .request<{ encoder: string }>("prewarm")
      .then((reply) => setEncoder(reply.encoder))
      .catch((error: Error) => setFailure(error.message));
    return () => started.close();
  }, []);
  return { service, encoder, failure, setFailure };
}

export function useSearch(
  service: React.MutableRefObject<SearchService | null>,
  options: { words: string; code: boolean; kinds?: Kind[]; limit?: number; scope?: Scope },
  onFailure: (message: string) => void,
) {
  const [hits, setHits] = useState<Hit[]>([]);
  const [strong, setStrong] = useState(0);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const { words, code, kinds, limit, scope = "everything" } = options;
  const kindsKey = kinds?.join(",") ?? "";

  useEffect(() => {
    const searcher = service.current;
    const current = ++generation.current;
    if (!searcher || !words.trim()) {
      setHits([]);
      setStrong(0);
      setLoading(false);
      return;
    }
    const show = (meaning: boolean) =>
      searcher
        .search(words, { code, kinds, meaning, limit, scope })
        .then((reply) => {
          if (current !== generation.current) return;
          const strongPaths = new Set(reply.hits.slice(0, reply.meaning ? reply.strong : reply.hits.length));
          const kept = reply.hits.filter((hit) => inScope(hit, scope));
          setHits(kept);
          setStrong(kept.filter((hit) => strongPaths.has(hit)).length);
          if (reply.warning) {
            showToast({ style: Toast.Style.Failure, title: "Meaning search is off", message: reply.warning });
          }
        })
        .catch((error: Error) => {
          if (current === generation.current) onFailure(error.message);
        });
    setLoading(true);
    show(false);
    searcher.embedAhead(words, code);
    const pause = setTimeout(() => {
      show(true).finally(() => {
        if (current === generation.current) setLoading(false);
      });
    }, PAUSE_MS);
    return () => clearTimeout(pause);
  }, [words, code, kindsKey, limit, scope, service.current]);

  return { hits, strong, loading };
}

/** "messages": what's in the exported chats (their text and attachments); "files": everything else. */
export type { Scope };

export function isMessageExport(path: string): boolean {
  return path.startsWith(EXPORT_ROOT + "/");
}

/** A month of a chat's text (not one of its attachments). */
export function isChatText(hit: Hit): boolean {
  return isMessageExport(hit.path) && hit.kind === "doc" && !hit.path.includes("/Attachments/");
}

function inScope(hit: Hit, scope: Scope): boolean {
  if (scope === "everything") return true;
  return (scope === "messages") === isMessageExport(hit.path);
}

/** DigUp has to run for new files to be indexed; started hidden (no search window) when it isn't. */
function ensureIndexerRunning() {
  execFile("/usr/bin/pgrep", ["-x", "DigUp"], (error) => {
    if (!error) return;
    execFile("/usr/bin/open", ["-g", "-a", APP_PATH, "--args", "-debugWaitForIndex", "NO"], () => undefined);
  });
}
