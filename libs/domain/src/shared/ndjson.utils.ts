/** Newline-delimited JSON, the framing ACP uses on stdio and the relay uses on its socket: one message per line. */

export interface LineDecoder {
  /** Feeds the next chunk of the stream; calls `onLine` for every line the chunk completes. */
  push(chunk: string): void;
}

/** Splits a text stream into lines. Blank lines are skipped; a trailing `\r` stays, `JSON.parse` reads it as whitespace. */
export function createLineDecoder(onLine: (line: string) => void): LineDecoder {
  let pending = "";
  return {
    push(chunk) {
      let start = 0;
      let newline = chunk.indexOf("\n");
      while (newline !== -1) {
        const line = pending + chunk.slice(start, newline);
        pending = "";
        start = newline + 1;
        if (line.trim()) {
          onLine(line);
        }
        newline = chunk.indexOf("\n", start);
      }
      pending += chunk.slice(start);
    },
  };
}

/** One message as an NDJSON line; `JSON.stringify` escapes line breaks inside strings. */
export function encodeLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/** The JSON value of one line; undefined when the line is not JSON. */
export function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}
