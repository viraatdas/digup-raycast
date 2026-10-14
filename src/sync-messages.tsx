import { showHUD, showToast, Toast } from "@raycast/api";
import { indexMessages, keepOutOfDigUpRoots, syncMessages } from "./messages";

// Brings DigUp's copy of iMessage and Beeper up to date now (the LaunchAgent from scripts/install-sync-agent.sh
// does the same whenever either app's database changes).
export default async function Command() {
  const toast = await showToast({ style: Toast.Style.Animated, title: "Syncing messages…" });
  try {
    const report = syncMessages();
    keepOutOfDigUpRoots();
    toast.title = "Indexing new messages…";
    const indexError = indexMessages({ attachments: false });
    if (indexError) report.errors.push(indexError);
    if (report.errors.length) {
      toast.style = Toast.Style.Failure;
      toast.title = "Some messages couldn't be read";
      toast.message = report.errors.join("\n");
      return;
    }
    await toast.hide();
    const what =
      report.files || report.attachments
        ? `${report.files} chats-months, ${report.attachments} attachments updated`
        : "already up to date";
    await showHUD(`Messages ${what}`);
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = "Sync failed";
    toast.message = String(error);
  }
}
