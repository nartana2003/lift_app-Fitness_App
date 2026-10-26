// PostToolUse hook on Edit and Write: after a sync-sensitive file changes,
// remind Claude to run the offline-sync-reviewer agent before finishing.
import { readFileSync } from "node:fs";

const { tool_input: ti = {} } = JSON.parse(readFileSync(0, "utf8"));
const file = (ti.file_path ?? "").replace(/\\/g, "/");

if (/\/lib\/offline\/(?!__tests__)|\/supabase\/migrations\//.test(file)) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          "Sync-sensitive file changed. Before finishing, run the offline-sync-reviewer agent on this change.",
      },
    }),
  );
}
