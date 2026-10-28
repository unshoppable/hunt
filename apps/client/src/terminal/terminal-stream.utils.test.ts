import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createResizeSync,
  decodeBase64,
  describeExit,
  describeLocalExit,
  encodeBase64,
  encodeBinaryInput,
  encodeTextInput,
  parseClipboardWrite,
  type TerminalSize,
} from "./terminal-stream.utils";

describe("base64 chunks", () => {
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  it("round-trips every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });

  it("decodes the backend's standard base64", () => {
    expect(text(decodeBase64("G1szMW1yZWQbWzBt"))).toBe("\u001b[31mred\u001b[0m");
  });

  it("keeps output cut inside a UTF-8 sequence byte for byte, so xterm.js completes the character with the next chunk", () => {
    const output = new TextEncoder().encode("\u001b[31mgrün\u001b[0m");
    const cut = output.indexOf(0xc3) + 1;
    const [first, second] = [output.subarray(0, cut), output.subarray(cut)].map((chunk) => decodeBase64(encodeBase64(chunk)));
    expect(first[first.length - 1]).toBe(0xc3);
    expect(text(new Uint8Array([...first, ...second]))).toBe("\u001b[31mgrün\u001b[0m");
  });

  it("encodes pastes larger than one encoding slice", () => {
    const paste = "ä".repeat(70_000);
    expect(text(decodeBase64(encodeTextInput(paste)))).toBe(paste);
  });

  it("encodes typed text as UTF-8 and binary input byte by byte", () => {
    expect(encodeTextInput("é\r")).toBe(btoa("\u00c3\u00a9\r"));
    expect([...decodeBase64(encodeBinaryInput("\u001b[M \u00ff!"))]).toEqual([0x1b, 0x5b, 0x4d, 0x20, 0xff, 0x21]);
  });
});

describe("createResizeSync", () => {
  let sent: TerminalSize[];
  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
  });
  afterEach(() => vi.useRealTimers());

  it("sends only the last size of a burst, after the delay", () => {
    const sync = createResizeSync((size) => sent.push(size), 100);
    sync.push({ cols: 100, rows: 30 });
    vi.advanceTimersByTime(60);
    sync.push({ cols: 110, rows: 30 });
    vi.advanceTimersByTime(60);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(40);
    expect(sent).toEqual([{ cols: 110, rows: 30 }]);
  });

  it("skips the size the backend has and empty sizes", () => {
    const sync = createResizeSync((size) => sent.push(size), 100);
    sync.markSent({ cols: 80, rows: 24 });
    sync.push({ cols: 80, rows: 24 });
    sync.push({ cols: 0, rows: 24 });
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
    sync.push({ cols: 81, rows: 24 });
    vi.advanceTimersByTime(100);
    sync.push({ cols: 81, rows: 24 });
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([{ cols: 81, rows: 24 }]);
  });

  it("drops a waiting size on markSent and cancel", () => {
    const sync = createResizeSync((size) => sent.push(size), 100);
    sync.push({ cols: 90, rows: 20 });
    sync.markSent({ cols: 80, rows: 24 });
    sync.push({ cols: 70, rows: 20 });
    sync.cancel();
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([]);
  });
});

describe("describeExit", () => {
  it("tells a detach, an SSH failure, a signal and other exit codes apart", () => {
    expect(describeExit(0)).toMatch(/Detached/);
    expect(describeExit(255)).toMatch(/SSH/);
    expect(describeExit(null)).toMatch(/ended/);
    expect(describeExit(1)).toBe("The terminal ended with exit code 1.");
  });
});

describe("describeLocalExit", () => {
  it("names the exit code as WebStorm does", () => {
    expect(describeLocalExit(0)).toBe("Process finished with exit code 0.");
    expect(describeLocalExit(null)).toBe("Process was ended.");
  });
});

describe("parseClipboardWrite", () => {
  it("decodes the UTF-8 text of a clipboard write, whatever selections it names", () => {
    expect(parseClipboardWrite(`c;${encodeTextInput("npm run dev → ok")}`)).toBe("npm run dev → ok");
    expect(parseClipboardWrite(`;${encodeTextInput("plain")}`)).toBe("plain");
  });

  it("ignores queries, empty payloads and malformed data", () => {
    expect(parseClipboardWrite("c;?")).toBeNull();
    expect(parseClipboardWrite("c;")).toBeNull();
    expect(parseClipboardWrite("no separator")).toBeNull();
    expect(parseClipboardWrite("c;%%%")).toBeNull();
    expect(parseClipboardWrite(`c;${encodeBase64(Uint8Array.of(0xff, 0xfe))}`)).toBeNull();
  });
});
