import { Action, ActionPanel, Color, Icon, Keyboard, List, open, useNavigation } from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import { basename, dirname, extname } from "node:path";
import { homedir } from "node:os";
import { APP_PATH, codeQuery, Hit, Kind, place, SearchService } from "./digup";
import { ChatEntry, chatOf, excerptText, readManifest } from "./messages";
import { chatApp, openChat, openHit, openTitle } from "./open";
import GridView from "./grid-view";
import { isChatText, isMessageExport, Scope, useSearch, useService } from "./use-search";

export type Mode = "files" | "code" | "messages";

// Results in DigUp's groups (Results.swift in DigUp: screenshots, images, documents, video, audio, code), plus the
// chats from iMessage and Beeper, each group where its best match ranks.

type Group = "Messages" | "Screenshots" | "Images" | "Documents" | "Video" | "Audio" | "Code";

function groupOf(hit: Hit): Group {
  if (isChatText(hit)) return "Messages";
  switch (hit.kind) {
    case "screenshot":
      return "Screenshots";
    case "image":
      return "Images";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "code":
      return "Code";
    default:
      return "Documents";
  }
}

const FILTERS: { value: string; title: string; icon: Icon; kinds?: Kind[]; scope?: Scope }[] = [
  { value: "all", title: "Everything", icon: Icon.MagnifyingGlass },
  { value: "messages", title: "Messages", icon: Icon.Message, scope: "messages" },
  { value: "screenshot", title: "Screenshots", icon: Icon.Desktop, kinds: ["screenshot"] },
  { value: "image", title: "Images", icon: Icon.Image, kinds: ["image"] },
  { value: "documents", title: "Documents", icon: Icon.Document, kinds: ["pdf", "doc"], scope: "files" },
  { value: "video", title: "Video", icon: Icon.Video, kinds: ["video"] },
  { value: "audio", title: "Audio", icon: Icon.Microphone, kinds: ["audio"] },
];

const KIND_ICONS: Record<Kind, Icon> = {
  image: Icon.Image,
  screenshot: Icon.Desktop,
  pdf: Icon.Document,
  doc: Icon.Text,
  audio: Icon.Microphone,
  video: Icon.Video,
  code: Icon.Code,
};

/** Pictures a web view shows as they are; the rest (HEIC, RAW, TIFF…) DigUp renders to JPEG. */
const SHOWN_AS_IS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

export default function SearchView(props: { mode: Mode; initialText?: string }) {
  const { service, encoder, failure, setFailure } = useService();
  const [text, setText] = useState(props.initialText ?? "");
  const [filter, setFilter] = useState(props.mode === "messages" ? "messages" : "all");
  const [selected, setSelected] = useState<string | null>(null);
  const [showingDetail, setShowingDetail] = useState(true);
  const manifest = useMemo(() => readManifest(), []);

  const typedCode = props.mode === "files" ? codeQuery(text) : undefined;
  const code = props.mode === "code" || typedCode !== undefined;
  const chosen = FILTERS.find((item) => item.value === filter) ?? FILTERS[0];
  const scope: Scope = props.mode === "messages" ? "messages" : code ? "everything" : (chosen.scope ?? "everything");
  const { hits, strong, loading } = useSearch(
    service,
    {
      words: typedCode ?? text,
      code,
      kinds: code ? undefined : chosen.kinds,
      limit: scope === "messages" ? 120 : 60,
      scope,
    },
    setFailure,
  );

  if (failure) return <Failure message={failure} />;

  // DigUp's groups, in the order their best matches rank; the weaker matches after them.
  const groups = new Map<Group, Hit[]>();
  for (const hit of hits.slice(0, strong)) groups.set(groupOf(hit), [...(groups.get(groupOf(hit)) ?? []), hit]);
  const weaker = hits.slice(strong);
  const item = (hit: Hit) => (
    <HitItem
      key={key(hit)}
      hit={hit}
      chat={isMessageExport(hit.path) ? chatOf(hit.path, manifest) : undefined}
      query={text}
      mode={props.mode}
      service={service.current}
      selected={selected === key(hit)}
      showingDetail={showingDetail}
      onToggleDetail={() => setShowingDetail((value) => !value)}
    />
  );

  return (
    <List
      filtering={false}
      isLoading={loading || encoder === "starting"}
      isShowingDetail={showingDetail && hits.length > 0}
      searchText={text}
      onSearchTextChange={setText}
      onSelectionChange={setSelected}
      searchBarPlaceholder={
        props.mode === "code"
          ? "Say what the code does, or a name in it…"
          : props.mode === "messages"
            ? "What was said, or what was sent…"
            : 'Describe what you\'re looking for… ("code:" for code)'
      }
      searchBarAccessory={
        props.mode !== "files" || code ? undefined : (
          <List.Dropdown tooltip="Kind" value={filter} onChange={setFilter}>
            {FILTERS.map((item) => (
              <List.Dropdown.Item key={item.value} value={item.value} title={item.title} icon={item.icon} />
            ))}
          </List.Dropdown>
        )
      }
    >
      {hits.length === 0 ? (
        <List.EmptyView
          icon={{ source: "icon.png" }}
          title={text.trim() ? (loading ? "Digging…" : "No good matches") : "Describe it. Dig it up."}
          description={text.trim() ? undefined : hint(props.mode, encoder)}
          actions={
            <ActionPanel>
              <Action title="Open DigUp Settings" icon={Icon.Gear} onAction={() => open(APP_PATH)} />
            </ActionPanel>
          }
        />
      ) : (
        <>
          {[...groups].map(([group, members]) => (
            <List.Section key={group} title={group} subtitle={String(members.length)}>
              {members.map(item)}
            </List.Section>
          ))}
          <List.Section title="Weaker matches">{weaker.map(item)}</List.Section>
        </>
      )}
    </List>
  );
}

function hint(mode: Mode, encoder: string): string {
  if (encoder === "unavailable") return "The model isn't ready, so only exact words match. Open DigUp to set it up.";
  if (mode === "code") return '"retry a failed call with backoff", "refreshAccessToken"';
  if (mode === "messages") return '"when mom talked about the trip", "the photo of the dog Abhi sent", "wifi password"';
  return '"a dog on the beach", "the clause about pets in the lease", "code: parse a date"';
}

function Failure(props: { message: string }) {
  const missing = props.message === "DigUp isn't installed";
  return (
    <List>
      <List.EmptyView
        icon={Icon.ExclamationMark}
        title={missing ? props.message : "DigUp couldn't search"}
        description={missing ? "Install it with: brew install --cask arahim3/tap/digup" : props.message.slice(0, 400)}
        actions={
          <ActionPanel>
            <Action.OpenInBrowser title="Get DigUp" url="https://github.com/ARahim3/DigUp/releases/latest" />
          </ActionPanel>
        }
      />
    </List>
  );
}

function key(hit: Hit): string {
  return `${hit.segment_id}:${hit.path}`;
}

export function tilde(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

/** "Oct 2026" from "Mom · Oct 2026.md". */
function monthLabel(path: string): string {
  return / · ([A-Z][a-z]{2} \d{4})\.md$/.exec(path)?.[1] ?? "";
}

function HitItem(props: {
  hit: Hit;
  chat?: ChatEntry;
  query: string;
  mode: Mode;
  service: SearchService | null;
  selected: boolean;
  showingDetail: boolean;
  onToggleDetail: () => void;
}) {
  const { hit, chat } = props;
  const { push } = useNavigation();
  const chatText = chat !== undefined && isChatText(hit);
  const where = chatText ? monthLabel(hit.path) : place(hit);
  const [title, setTitle] = useState("Open");
  useEffect(() => {
    if (!chatText) openTitle(hit).then(setTitle);
  }, [hit.path, hit.loc]);

  const name = chatText ? chat!.title : chat ? `${basename(hit.path)}` : basename(hit.path);
  const subtitle = chatText
    ? excerptText(hit.excerpt).slice(0, 90)
    : chat
      ? `from ${chat.title} · ${chat.network}`
      : tilde(dirname(hit.path));
  const openChatAction = chat ? (
    <Action
      title={`Open Chat in ${chat.source === "imessage" ? "Messages" : "Beeper"}`}
      icon={{ fileIcon: chatApp(chat) }}
      onAction={async () => {
        const passage = await props.service?.text(hit, false).catch(() => undefined);
        await openChat(chat, hit, { query: props.query, passage });
      }}
    />
  ) : null;

  return (
    <List.Item
      id={key(hit)}
      icon={chatText ? { fileIcon: chatApp(chat!) } : thumbnail(hit)}
      title={name}
      subtitle={props.showingDetail && !chatText ? undefined : subtitle}
      accessories={[
        ...(where && !props.showingDetail ? [{ tag: where }] : []),
        ...(chatText
          ? [{ text: chat!.network }]
          : [{ icon: { source: KIND_ICONS[hit.kind], tintColor: Color.SecondaryText }, tooltip: hit.kind }]),
      ]}
      quickLook={{ path: hit.path, name: basename(hit.path) }}
      detail={props.selected ? <HitDetail hit={hit} chat={chat} service={props.service} /> : undefined}
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            {chatText ? openChatAction : <Action title={title} icon={Icon.ArrowRight} onAction={() => openHit(hit)} />}
            <Action.ShowInFinder path={hit.path} />
            <Action.ToggleQuickLook shortcut={Keyboard.Shortcut.Common.ToggleQuickLook} />
            {chatText ? (
              <Action.CopyToClipboard
                title="Copy Message"
                content={excerptText(hit.excerpt)}
                shortcut={{ modifiers: ["cmd"], key: "c" }}
              />
            ) : (
              <Action.CopyToClipboard
                title="Copy File"
                content={{ file: hit.path }}
                shortcut={{ modifiers: ["cmd"], key: "c" }}
              />
            )}
            {props.mode !== "code" ? (
              <Action
                title="Show as Picture Grid"
                icon={Icon.AppWindowGrid3x3}
                shortcut={Keyboard.Shortcut.Common.Open}
                onAction={() => push(<GridView initialText={props.query} mode={props.mode} />)}
              />
            ) : null}
          </ActionPanel.Section>
          <ActionPanel.Section>
            {chatText ? null : openChatAction}
            <Action.CopyToClipboard title="Copy Path" content={hit.path} shortcut={Keyboard.Shortcut.Common.Copy} />
            <Action.OpenWith path={hit.path} shortcut={Keyboard.Shortcut.Common.OpenWith} />
            <Action
              title={props.showingDetail ? "Hide Preview" : "Show Preview"}
              icon={Icon.Sidebar}
              shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
              onAction={props.onToggleDetail}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

/** A picture's own thumbnail, else the file's icon. */
function thumbnail(hit: Hit) {
  const ext = extname(hit.path).toLowerCase();
  return (hit.kind === "image" || hit.kind === "screenshot") && SHOWN_AS_IS.has(ext)
    ? { source: hit.path }
    : { fileIcon: hit.path };
}

/** The page or moment that matched: a picture, a rendered page or frame, or the passage of text. */
export function usePreview(hit: Hit, service: SearchService | null) {
  const [image, setImage] = useState<string>();
  const [passage, setPassage] = useState<string>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    const done = () => live && setLoading(false);
    const ext = extname(hit.path).toLowerCase();
    if (hit.kind === "image" || hit.kind === "screenshot") {
      if (SHOWN_AS_IS.has(ext)) {
        setImage(hit.path);
        done();
      } else {
        service
          ?.render(hit.path, "image")
          .then((path) => live && setImage(path))
          .catch(() => undefined)
          .finally(done);
      }
    } else if (hit.kind === "pdf" || hit.kind === "video") {
      Promise.all([
        service?.render(hit.path, hit.kind, hit.loc ?? (hit.kind === "pdf" ? 1 : 0)),
        hit.kind === "pdf" ? service?.text(hit, false) : undefined,
      ])
        .then(([path, text]) => {
          if (!live) return;
          setImage(path);
          setPassage(text);
        })
        .catch(() => undefined)
        .finally(done);
    } else if (hit.kind === "doc" || hit.kind === "code") {
      service
        ?.text(hit, hit.kind === "code")
        .then((text) => live && setPassage(text))
        .catch(() => undefined)
        .finally(done);
    } else {
      done();
    }
    return () => {
      live = false;
    };
  }, [hit.segment_id, hit.path]);

  return { image, passage, loading };
}

function HitDetail(props: { hit: Hit; chat?: ChatEntry; service: SearchService | null }) {
  const { hit, chat, service } = props;
  const { image, passage, loading } = usePreview(hit, service);

  const parts: string[] = [];
  if (image) parts.push(`![](${encodeURI("file://" + image)}?raycast-height=240)`);
  const text = passage ?? hit.excerpt;
  if (text) {
    const trimmed = text.length > 2500 ? text.slice(0, 2500) + "…" : text;
    if (hit.kind === "code") {
      parts.push("```" + extname(hit.path).slice(1) + "\n" + trimmed.replace(/[«»]/g, "") + "\n```");
    } else if (chat && isChatText(hit)) {
      parts.push(chatMarkdown(trimmed, hit.excerpt));
    } else {
      parts.push(quote(trimmed));
    }
  }
  if (!image && !text && hit.kind === "audio") parts.push(`🎧 ${place(hit) ?? "a recording"}`);

  const where = chat && isChatText(hit) ? monthLabel(hit.path) : place(hit);
  return (
    <List.Item.Detail
      isLoading={loading}
      markdown={parts.join("\n\n")}
      metadata={
        <List.Item.Detail.Metadata>
          {chat ? (
            <>
              <List.Item.Detail.Metadata.Label title="Chat" text={chat.title} icon={{ fileIcon: chatApp(chat) }} />
              <List.Item.Detail.Metadata.Label title="Network" text={chat.network} />
              {where ? <List.Item.Detail.Metadata.Label title="When" text={where} /> : null}
            </>
          ) : (
            <>
              <List.Item.Detail.Metadata.Label title="File" text={basename(hit.path)} />
              {where ? <List.Item.Detail.Metadata.Label title="Match" text={where} /> : null}
              <List.Item.Detail.Metadata.Label title="Folder" text={tilde(dirname(hit.path))} />
            </>
          )}
          {chat && isChatText(hit) ? null : <List.Item.Detail.Metadata.Label title="Size" text={size(hit.size)} />}
          <List.Item.Detail.Metadata.Label title="Modified" text={new Date(hit.modified * 1000).toLocaleString()} />
        </List.Item.Detail.Metadata>
      }
    />
  );
}

/** A stretch of a chat: the day headings kept, each message on its own line, the matched one in bold. */
function chatMarkdown(text: string, excerpt?: string): string {
  const matched = excerptText(excerpt).slice(0, 40);
  const lines = text
    .replace(/^# .*$/m, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (line.startsWith("## ")) return `#### ${escape(line.slice(3))}`;
      const split = /^([^:]{1,60}, \d{1,2}:\d{2}\s?[AP]M): (.*)$/.exec(line);
      const body = split ? `**${escape(split[1])}**  ${escape(split[2])}` : escape(line);
      return matched && line.replace(/[«»]/g, "").includes(matched) ? `> ${body}` : body;
    });
  return lines.join("\n\n").replace(/[«»]/g, "");
}

function escape(text: string): string {
  return text.replace(/([\\`*_[\]#<>])/g, "\\$1");
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => "> " + escape(line).replace(/[«»]/g, "**"))
    .join("\n");
}

function size(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
