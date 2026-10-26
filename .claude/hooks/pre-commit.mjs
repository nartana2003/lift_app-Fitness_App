// PreToolUse hook on Bash: before any `git commit`, run typecheck and lint in
// the app dir and reject emojis in the message and the changed lines. Tests are
// left to the tester agent. Exit 2 blocks the commit and shows Claude why.
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
const cmd = input.tool_input?.command ?? "";
const commit = /\bgit(?:\s+-C\s+("[^"]*"|\S+))?\s+commit\b/.exec(cmd);
if (!commit) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
const given = commit[1]?.replace(/^"|"$/g, "");
const app = given ? resolve(root, given) : join(root, "lift");
if (!existsSync(join(app, "package.json"))) process.exit(0);

const fail = (title, out) => {
  console.error(`Commit blocked: ${title}\n${out.trim().split("\n").slice(-40).join("\n")}`);
  process.exit(2);
};
const run = (cmdline) => spawnSync(cmdline, { cwd: app, shell: true, encoding: "utf8", timeout: 240000 });
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u;

if (EMOJI.test(cmd)) fail("emoji in the command or commit message (CLAUDE.md bans them).", "");

// Added lines in changed non-test files. HEAD covers staged and `commit -a` edits.
const diff = spawnSync("git", ["-C", app, "diff", "HEAD", "-U0"], { encoding: "utf8" }).stdout ?? "";
let current = "";
for (const line of diff.split("\n")) {
  if (line.startsWith("+++ ")) current = line.slice(6);
  else if (line.startsWith("+") && !/(__tests__|\.test\.|\.spec\.)/.test(current) && EMOJI.test(line)) {
    fail(`emoji added in ${current}`, line);
  }
}

const tsc = run("npx tsc --noEmit");
if (tsc.status !== 0) fail("typecheck failed (npx tsc --noEmit).", tsc.stdout + tsc.stderr);
const lint = run("npm run lint");
if (lint.status !== 0) fail("lint failed (npm run lint).", lint.stdout + lint.stderr);
