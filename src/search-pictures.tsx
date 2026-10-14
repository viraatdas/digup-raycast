import { LaunchProps } from "@raycast/api";
import GridView from "./grid-view";

export default function Command(props: LaunchProps) {
  return <GridView initialText={props.fallbackText} />;
}
