import { Action, ActionPanel, Grid, Icon, Keyboard } from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import { basename, extname } from "node:path";
import { Hit, Kind, place, SearchService } from "./digup";
import { chatOf, readManifest } from "./messages";
import { chatApp, openChat, openHit } from "./open";
import { Scope, useSearch, useService } from "./use-search";
import type { Mode } from "./search-view";

// ⌘O: the same search as a picture grid, as DigUp's bigger window shows it, with its kind filters.

const SHOWN_AS_IS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

const FILTERS: { value: string; title: string; kinds: Kind[] }[] = [
  { value: "visual", title: "Pictures, Screenshots and Video", kinds: ["image", "screenshot", "video"] },
  { value: "image", title: "Images", kinds: ["image"] },
  { value: "screenshot", title: "Screenshots", kinds: ["screenshot"] },
  { value: "video", title: "Video", kinds: ["video"] },
];

export default function GridView(props: { initialText?: string; mode?: Mode }) {
  const { service, failure, setFailure } = useService();
  const [text, setText] = useState(props.initialText ?? "");
  const [filter, setFilter] = useState("visual");
  const manifest = useMemo(() => readManifest(), []);
  const scope: Scope = props.mode === "messages" ? "messages" : "everything";
  const kinds = (FILTERS.find((item) => item.value === filter) ?? FILTERS[0]).kinds;
  const { hits, loading } = useSearch(service, { words: text, code: false, kinds, limit: 80, scope }, setFailure);

  return (
    <Grid
      columns={5}
      aspectRatio="4/3"
      fit={Grid.Fit.Fill}
      filtering={false}
      isLoading={loading}
      searchText={text}
      onSearchTextChange={setText}
      searchBarPlaceholder="Describe the picture or the moment…"
      searchBarAccessory={
        <Grid.Dropdown tooltip="Kind" value={filter} onChange={setFilter}>
          {FILTERS.map((item) => (
            <Grid.Dropdown.Item key={item.value} value={item.value} title={item.title} />
          ))}
        </Grid.Dropdown>
      }
    >
      {failure ? (
        <Grid.EmptyView icon={Icon.ExclamationMark} title="DigUp couldn't search" description={failure.slice(0, 300)} />
      ) : hits.length === 0 ? (
        <Grid.EmptyView
          icon={{ source: "icon.png" }}
          title={text.trim() ? "No good matches" : "Describe it. Dig it up."}
        />
      ) : (
        hits.map((hit) => (
          <Tile key={`${hit.segment_id}:${hit.path}`} hit={hit} service={service.current} manifest={manifest} />
        ))
      )}
    </Grid>
  );
}

function Tile(props: { hit: Hit; service: SearchService | null; manifest: ReturnType<typeof readManifest> }) {
  const { hit, service } = props;
  const chat = chatOf(hit.path, props.manifest);
  const ext = extname(hit.path).toLowerCase();
  const direct = (hit.kind === "image" || hit.kind === "screenshot") && SHOWN_AS_IS.has(ext);
  const [image, setImage] = useState<string | undefined>(direct ? hit.path : undefined);

  useEffect(() => {
    if (direct || !service) return;
    let live = true;
    const kind = hit.kind === "video" ? "video" : "image";
    service
      .render(hit.path, kind, hit.kind === "video" ? (hit.loc ?? 0) : undefined)
      .then((path) => live && setImage(path))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [hit.path, hit.loc]);

  const where = place(hit);
  return (
    <Grid.Item
      content={image ? { source: image } : { fileIcon: hit.path }}
      title={chat ? chat.title : basename(hit.path)}
      subtitle={where ?? (chat ? chat.network : undefined)}
      quickLook={{ path: hit.path, name: basename(hit.path) }}
      actions={
        <ActionPanel>
          <Action title="Open" icon={Icon.ArrowRight} onAction={() => openHit(hit)} />
          <Action.ShowInFinder path={hit.path} />
          <Action.ToggleQuickLook shortcut={Keyboard.Shortcut.Common.ToggleQuickLook} />
          <Action.CopyToClipboard
            title="Copy File"
            content={{ file: hit.path }}
            shortcut={{ modifiers: ["cmd"], key: "c" }}
          />
          {chat ? (
            <Action
              title={`Open Chat in ${chat.source === "imessage" ? "Messages" : "Beeper"}`}
              icon={{ fileIcon: chatApp(chat) }}
              onAction={() => openChat(chat)}
            />
          ) : null}
        </ActionPanel>
      }
    />
  );
}
