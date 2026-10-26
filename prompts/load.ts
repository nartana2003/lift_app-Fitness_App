import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Loads a system prompt from lift/prompts/<name>.md (server only). `{{key}}`
 * placeholders are filled from `vars`; a missing variable or a leftover
 * placeholder throws, so a typo cannot reach the model.
 */
export function loadPrompt(name: string, vars: Record<string, string | number> = {}): string {
  const raw = readFileSync(path.join(process.cwd(), "prompts", `${name}.md`), "utf8").replace(/\r\n/g, "\n");
  return raw
    .replace(/\n$/, "")
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      if (!(key in vars)) throw new Error(`Prompt "${name}" needs variable "${key}"`);
      return String(vars[key]);
    });
}
