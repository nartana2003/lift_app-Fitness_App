// Manual live check for POST /api/ai/evidence-picks. NOT part of the test
// suite and never run by agents: it makes one real, billed Claude call with
// web search.
//
// A human runs it against a local server that has ANTHROPIC_API_KEY set:
//   1. npm run dev            (in lift/, with the key in .env)
//   2. node scripts/live-check-evidence.mjs [http://localhost:3000]
//
// It sends a fixed request and prints the picks, the evidence levels and the
// numbered sources so the claims can be checked by hand. It never reads or
// prints the API key (the key stays on the server).

const base = process.argv[2] ?? "http://localhost:3000";

const body = {
  goals: { goalType: "build_muscle", experience: "intermediate", sessionsPerWeek: 4, focusMuscles: ["Glutes"] },
  muscles: ["Glutes", "Chest"],
  equipment: ["Barbell", "Dumbbell", "Machine/Cable", "Bodyweight"],
};

const started = Date.now();
const res = await fetch(`${base}/api/ai/evidence-picks`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`HTTP ${res.status} in ${seconds}s`);
const data = await res.json().catch(() => null);
if (!data || res.status !== 200) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(1);
}

console.log(`source: ${data.source}`);
console.log(`disclaimer: ${data.disclaimer}`);
console.log("evidence:", data.evidence);
console.log("\nPicks:");
for (const p of data.picks) console.log(`- [${p.muscle}] ${p.exercise_id}: ${p.claim} (sources ${p.source_ids.join(", ") || "none"})`);
console.log("\nSources:");
for (const s of data.sources) console.log(`[${s.id}] ${s.title} (${s.publisher}, ${s.kind})\n    ${s.url}\n    "${s.quote}"`);

// Quick self-checks a human can trust at a glance.
const ids = new Set(data.sources.map((s) => s.id));
const dangling = data.picks.flatMap((p) => [...p.claim.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))).filter((n) => !ids.has(n));
const nonHttps = data.sources.filter((s) => !s.url.startsWith("https://"));
console.log(`\nchecks: dangling markers ${dangling.length}, non-https sources ${nonHttps.length}`);
