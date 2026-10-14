import { Action, ActionPanel, Detail, Icon, open, Keyboard } from "@raycast/api";
import { useExec } from "@raycast/utils";
import { homedir } from "node:os";
import { APP_PATH, appSetting, helperPath } from "./digup";

export default function Command() {
  const index = appSetting<string>("indexDir");
  const args = ["status", ...(index ? ["--index", index.replace(/^~/, homedir())] : [])];
  const { data, error, isLoading, revalidate } = useExec(helperPath(), args);
  const body = error ? `DigUp couldn't read its index.\n\n\`\`\`\n${error.message}\n\`\`\`` : data;
  return (
    <Detail
      isLoading={isLoading}
      markdown={body ? `# DigUp index\n\n\`\`\`\n${body}\n\`\`\`` : ""}
      actions={
        <ActionPanel>
          <Action title="Open DigUp" icon={Icon.AppWindow} onAction={() => open(APP_PATH)} />
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={revalidate}
          />
        </ActionPanel>
      }
    />
  );
}
