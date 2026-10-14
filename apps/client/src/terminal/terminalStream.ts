/** Size of a terminal in character cells. */
export type TerminalSize = { cols: number; rows: number };

/** Bytes per `String.fromCharCode` call; spreading a large paste in one call would overflow the call stack. */
const ENCODE_SLICE = 0x8000;

/** The bytes of `data`, base64 as the backend sends terminal output. */
export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** base64 of `bytes`, as the backend takes terminal input. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += ENCODE_SLICE) {
    binary += String.fromCharCode(...bytes.subarray(start, start + ENCODE_SLICE));
  }
  return btoa(binary);
}

/** Input xterm.js reports through `onData` (typed or pasted text) as base64 of its UTF-8 bytes. */
export function encodeTextInput(text: string): string {
  return encodeBase64(new TextEncoder().encode(text));
}

/** Input xterm.js reports through `onBinary` (one byte per character, e.g. legacy mouse reports) as base64. */
export function encodeBinaryInput(binary: string): string {
  return encodeBase64(Uint8Array.from(binary, (character) => character.charCodeAt(0) & 0xff));
}

/** Passes the sizes a terminal view reports on to the backend. */
export type ResizeSync = {
  /** Sends `size` once no other size followed for the delay, unless the backend has it already. */
  push: (size: TerminalSize) => void;
  /** Records `size` as the backend's, e.g. the size a terminal opened with, and drops a size waiting to be sent. */
  markSent: (size: TerminalSize) => void;
  cancel: () => void;
};

/**
 * A `ResizeSync` that sends through `send`: a burst of sizes (a dragged pane edge) sends only its last one, `delayMs`
 * after it, so the remote programs redraw once; empty sizes are ignored.
 */
export function createResizeSync(send: (size: TerminalSize) => void, delayMs: number): ResizeSync {
  let sent: TerminalSize | null = null;
  let pending: TerminalSize | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = null;
  };

  const flush = () => {
    const size = pending;
    stop();
    if (!size || (sent && sent.cols === size.cols && sent.rows === size.rows)) return;
    sent = size;
    send(size);
  };

  return {
    push: (size) => {
      if (size.cols < 1 || size.rows < 1) return;
      clearTimeout(timer);
      pending = size;
      timer = setTimeout(flush, delayMs);
    },
    markSent: (size) => {
      stop();
      sent = size;
    },
    cancel: stop,
  };
}

/** Why a terminal ended, from its program's exit code: ssh's own 255, or the remote command's code (`null`: a signal). */
export function describeExit(code: number | null): string {
  if (code === 0) return "Detached from tmux, or its session ended.";
  if (code === 255) return "The SSH connection failed or broke off.";
  if (code === null) return "The connection was ended.";
  return `The terminal ended with exit code ${code}.`;
}
