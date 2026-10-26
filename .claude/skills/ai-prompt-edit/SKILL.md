---
name: ai-prompt-edit
description: Rules for editing or adding AI system prompts in Lift. Use when touching lift/prompts or lift/lib/ai.
user-invocable: false
---

# AI prompts

- System prompts live in `lift/prompts/*.md`, never inline in `lift/lib/ai/`. Edit wording in the `.md` file.
- Each feature file in `lift/lib/ai/` keeps its `SYSTEM_PROMPT` export, built with `loadPrompt("name", { ...limits })` from `lift/prompts/load.ts`.
- Limits are `{{placeholders}}` in the `.md`; pass their values through `loadPrompt`.
- A new prompt means a new `.md` file plus a `loadPrompt` call. Keep the `buildPrompt` and `parseResponse` functions pure and tested (see `lift-conventions`).
- Free text reaches a prompt only when the item needs it, with escaping and length caps.
- Every AI feature keeps a rule-based fallback and returns 503 when there is no key. Never read or print the real key in `lift/.env`.
