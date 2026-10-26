// Refreshes the generated status block at the end of PLAN.md.
// Run from the project root: node .claude/skills/plan-status/update.js
// Only the text between the two marker lines is ever written; everything else in PLAN.md is kept byte for byte.
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const yaml = require(path.join(root, "lift", "node_modules", "js-yaml"));
const planPath = path.join(root, "PLAN.md");
const START = "<!-- loop-status:start -->";
const END = "<!-- loop-status:end -->";

const items = yaml.load(fs.readFileSync(path.join(root, ".claude/state/backlog.yml"), "utf8"));
const sha = {};
for (const line of fs.readFileSync(path.join(root, ".claude/state/CYCLES.md"), "utf8").split(/\r?\n/)) {
  const p = line.split("|").map((s) => s.trim());
  if (p.length >= 5 && /^\d{4}-\d{2}-\d{2}$/.test(p[0])) sha[p[1]] = (p[4].match(/^[0-9a-f]{7,}/) || [""])[0];
}

const by = (...s) => items.filter((i) => s.includes(i.status));
const done = by("done", "done-mocked");
const queued = by("todo", "needs-rework");
const blocked = by("blocked");
const human = by("needs-human");
const parked = by("parked");
const need = { vercel: "needs your Vercel account", supabase: "needs your Supabase project", "anthropic-key": "needs your Anthropic API key" };
const today = new Date().toISOString().slice(0, 10);

const L = [];
L.push(`## Loop build status (auto-updated, ${today})`);
L.push(
  `${by("done").length} done, ${by("done-mocked").length} done-mocked, ${queued.length} queued, ` +
    `${blocked.length} blocked, ${human.length} need a human, ${parked.length} parked`,
);
L.push("", "### Done by the build loop");
for (const i of done) {
  const s = sha[i.id] ? ` (commit ${sha[i.id]})` : "";
  const m = i.status === "done-mocked" ? " - mocked only: not confirmed against the real Claude API until a key exists" : "";
  L.push(`- ${i.id}: ${i.title}${s}${m}`);
}
L.push("", "### Queued (the loop will build these, in order)");
for (const i of queued) L.push(`- ${i.id}: ${i.title} (${i.plan_ref})`);
if (!queued.length) L.push("- nothing queued");
L.push("", "### Needs you");
for (const i of blocked) L.push(`- ${i.id}: ${i.title} - ${need[i.blocked_by] || "blocked"}`);
for (const i of human) L.push(`- ${i.id}: ${i.title} - the loop gave up after repeated rework; see .claude/state/feedback/${i.id}.md`);
for (const i of parked) L.push(`- ${i.id}: ${i.title} - parked; will not run until promoted to todo in backlog.yml`);
if (!blocked.length && !human.length && !parked.length) L.push("- nothing");
L.push("", "Generated from .claude/state/backlog.yml. Hand-written sections above are unchanged.");

let plan = fs.readFileSync(planPath, "utf8");
const nl = plan.includes("\r\n") ? "\r\n" : "\n";
const block = START + nl + L.join(nl) + nl + END;
const a = plan.indexOf(START);
const b = plan.indexOf(END);
let out;
if (a !== -1 && b > a) {
  out = plan.slice(0, a) + block + plan.slice(b + END.length);
} else {
  out = plan.replace(/\s*$/, "") + nl + nl + block + nl;
}
fs.writeFileSync(planPath, out);
console.log(`PLAN.md status block written: ${done.length} done, ${queued.length} queued, ${blocked.length} blocked, ${parked.length} parked`);
