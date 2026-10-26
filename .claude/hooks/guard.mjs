// PreToolUse guard for Read, Edit, Write and Bash. Exit 2 blocks the call and
// feeds stderr back to Claude. Blocks: .env access, PLAN.md and lockfile edits,
// edits to existing Supabase migrations, and emoji in new source text.
import { readFileSync, existsSync } from "node:fs";

const { tool_name: tool, tool_input: ti = {} } = JSON.parse(readFileSync(0, "utf8"));
const block = (msg) => {
  console.error(msg);
  process.exit(2);
};

const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u;
// A .env, .env.local, ... token. .env.example is safe to read and edit.
const touchesEnv = (s) =>
  [...s.matchAll(/(?:^|[\\/\s"'=])(\.env(?:\.[\w.-]+)?)(?=$|[\s"'|;&)])/g)].some((m) => m[1] !== ".env.example");

if (tool === "Bash") {
  if (touchesEnv(ti.command ?? "")) block("Blocked: command touches a .env file (holds a real AI key). Use .env.example.");
  process.exit(0);
}

const file = (ti.file_path ?? "").replace(/\\/g, "/");
if (touchesEnv(file)) block("Blocked: .env files hold a real AI key. Use .env.example.");
if (tool === "Read") process.exit(0);

if (/(^|\/)PLAN\.md$/.test(file)) block("Blocked: never edit PLAN.md (CLAUDE.md rule 1).");
if (/(^|\/)package-lock\.json$/.test(file)) block("Blocked: do not hand-edit package-lock.json. Use npm.");
if (/\/supabase\/migrations\/[^/]+\.sql$/.test(file) && existsSync(ti.file_path)) {
  block("Blocked: existing migrations are immutable. Add a new numbered migration (see the gen-migration skill).");
}

const isTest = /(__tests__|\.test\.|\.spec\.)/.test(file) || /\.claude\/state\//.test(file);
if (/\.(ts|tsx|js|mjs|css|md|json)$/.test(file) && !isTest && EMOJI.test(ti.new_string ?? ti.content ?? "")) {
  block("Blocked: no emojis anywhere (CLAUDE.md). Use inline SVG or the existing icon components.");
}
