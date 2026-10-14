import { indexMessages, keepOutOfDigUpRoots, syncMessages } from "./messages";

// The LaunchAgent's entry point (scripts/install-sync-agent.sh): export what's new, index it, and log a JSON line.
const started = Date.now();
const report = syncMessages();
keepOutOfDigUpRoots();
const indexError = indexMessages({ attachments: true });
console.log(
  JSON.stringify({
    at: new Date().toISOString(),
    ...report,
    errors: indexError ? [...report.errors, indexError] : report.errors,
    seconds: (Date.now() - started) / 1000,
  }),
);
