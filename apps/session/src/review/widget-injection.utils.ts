/** How the review server (`review-server.service.ts`) adds the review widget to an HTML page of a preview. */

/** The tag that loads the widget, which the review server serves on every guarded port host. */
export const WIDGET_TAG = '<script src="/__hunt/review.js" defer></script>';
/** A response header with which a page opts out of the widget. */
export const OPT_OUT_HEADER = "x-hunt-review-widget";

/** The parts of an upstream response that decide whether the widget goes into it. */
export interface ResponseHead {
  method: string;
  statusCode: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * Whether the widget goes into the response: the HTML body of a GET, uncompressed (the review server asks for no
 * encoding, but a server may send one anyway), without content and redirects left out, and not opted out with
 * `x-hunt-review-widget: off`.
 */
export function wantsWidget({ method, statusCode, headers }: ResponseHead): boolean {
  if (method !== "GET" || statusCode < 200 || statusCode === 204 || statusCode === 304 || (statusCode >= 300 && statusCode < 400)) return false;
  const contentType = String(headers["content-type"] ?? "").toLowerCase();
  if (!/^text\/html\s*(;|$)/.test(contentType)) return false;
  const encoding = String(headers["content-encoding"] ?? "identity").toLowerCase();
  if (encoding !== "identity") return false;
  return String(headers[OPT_OUT_HEADER] ?? "").trim().toLowerCase() !== "off";
}

/**
 * `html` with WIDGET_TAG before `</head>`, else right after the opening `<body>` tag, else at the end. Works on the
 * bytes, so any ASCII-compatible charset passes unchanged; a page that loads the widget already is returned as it is.
 */
export function injectWidget(html: Buffer): Buffer {
  const text = html.toString("latin1");
  if (text.includes(WIDGET_TAG)) return html;
  const headEnd = text.search(/<\/head\s*>/i);
  const bodyStart = /<body(\s[^>]*)?>/i.exec(text);
  const offset = headEnd !== -1 ? headEnd : bodyStart ? bodyStart.index + bodyStart[0].length : html.length;
  return Buffer.concat([html.subarray(0, offset), Buffer.from(WIDGET_TAG, "latin1"), html.subarray(offset)]);
}
