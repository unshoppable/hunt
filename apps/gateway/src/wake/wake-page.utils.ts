/**
 * The page hunt-wake (`wake/wake.service.ts`) answers every request with, and whether a request loads a page in a browser tab; free of I/O. A
 * page that reloads does so every RELOAD_SECONDS.
 */
import type { IncomingHttpHeaders } from "node:http";

export const RELOAD_SECONDS = 5;

export interface Page {
  status: number;
  title: string;
  text: string;
  reloads: boolean;
}

/** Whether the request loads a page in a browser tab, as opposed to a script's request from a page already open. */
export function isPageLoad(method: string | undefined, headers: IncomingHttpHeaders): boolean {
  if (method !== "GET") return false;
  const mode = headers["sec-fetch-mode"];
  if (mode) return mode === "navigate";
  return (headers.accept ?? "").includes("text/html");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

export function renderPage(page: Page): string {
  const refresh = page.reloads ? `\n<meta http-equiv="refresh" content="${RELOAD_SECONDS}">` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">${refresh}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 system-ui, sans-serif; color: #1f2328; background: #f6f8fa; }
  main { max-width: 32rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { margin: 0; color: #59636e; }
  @media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } p { color: #9198a1; } }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(page.title)}</h1>
<p>${escapeHtml(page.text)}</p>
</main>
</body>
</html>
`;
}

export function waiting(text: string): Page {
  return { status: 503, title: "Starting the preview…", text, reloads: true };
}
