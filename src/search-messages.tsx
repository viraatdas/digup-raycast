import { LaunchProps } from "@raycast/api";
import SearchView from "./search-view";

// fallbackText: what was typed in Raycast's root search when this runs as a fallback command ("Use … with").
export default function Command(props: LaunchProps) {
  return <SearchView mode="messages" initialText={props.fallbackText} />;
}
