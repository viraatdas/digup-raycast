import { indexMessages, keepOutOfDigUpRoots, syncMessages } from "./messages";

// The LaunchAgent's entry point (scripts/install-sync-agent.sh): export what's new, then index it. Each step logs a JSON
// line to sync.log as it finishes (the export's first, so a missing permission shows before indexing ends).
const started = Date.now();
const report = syncMessages();
keepOutOfDigUpRoots();
const seconds = () => (Date.now() - started) / 1000;
console.log(JSON.stringify({ at: new Date().toISOString(), step: "export", ...report, seconds: seconds() }));
const indexError = indexMessages({ attachments: true });
console.log(
  JSON.stringify({
    at: new Date().toISOString(),
    step: "index",
    errors: indexError ? [indexError] : [],
    seconds: seconds(),
  }),
);
