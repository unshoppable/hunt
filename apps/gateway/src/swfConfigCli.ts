/**
 * Validates a configuration of hunt-swf (`swfConfig.ts`) for `hunt-ctl swf-config`, which runs
 *
 *   node /srv/hunt/current/gateway/swfConfig.mjs --validate
 *
 * with the JSON object on stdin: it prints the normalized configuration as one line of JSON and exits 0, or prints
 * `{"ok": false, "problems": […]}` and exits 1.
 */
import { readFileSync } from "node:fs";
import { parseSwfConfig } from "./swfConfig.ts";

function validateStdin(): void {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(0, "utf8"));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, problems: [`stdin holds no JSON: ${(error as Error).message}`] })}\n`);
    process.exit(1);
  }
  const parsed = parseSwfConfig(value);
  if (parsed.problems) {
    process.stdout.write(`${JSON.stringify({ ok: false, problems: parsed.problems })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(parsed.config)}\n`);
}

if (process.argv[2] !== "--validate" || process.argv.length !== 3) {
  process.stderr.write("usage: swfConfig.mjs --validate < config.json\n");
  process.exit(2);
}
validateStdin();
