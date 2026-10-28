import { describe, expect, it } from "vitest";
import { McpServer } from "./mcp-server.value-object.ts";

const PLAYWRIGHT = { name: "playwright", command: "/opt/hunt/node/bin/node", args: ["cli.js"], env: [{ name: "A", value: "1" }] };

describe("McpServer", () => {
  it("fills in empty args and env", () => {
    expect(new McpServer({ name: "other", command: "/usr/bin/other" })).toEqual({ name: "other", command: "/usr/bin/other", args: [], env: [] });
  });

  it("serializes as ACP's stdio entry without the fields ACP's entry does not have", () => {
    const server = McpServer.fromEntry({ type: "stdio", ...PLAYWRIGHT, env: [{ name: "A", value: "1", secret: true }] }, "[0]");

    expect(JSON.stringify(server)).toBe(JSON.stringify(PLAYWRIGHT));
  });

  it("rejects an entry that is no object", () => {
    expect(() => McpServer.fromEntry(["playwright"], "[2]")).toThrow(/^\[2\] must be an object$/);
  });

  it("rejects an empty name", () => {
    expect(() => McpServer.fromEntry({ ...PLAYWRIGHT, name: "" }, "[0]")).toThrow(/^\[0\]\.name must be a non-empty string$/);
  });

  it("rejects a command that is no absolute path", () => {
    expect(() => McpServer.fromEntry({ ...PLAYWRIGHT, command: "node" }, "[0]")).toThrow(/^\[0\]\.command must be an absolute path$/);
  });

  it("rejects args that are no strings", () => {
    expect(() => McpServer.fromEntry({ ...PLAYWRIGHT, args: "cli.js" }, "[0]")).toThrow(/^\[0\]\.args must be an array of strings$/);
  });

  it("rejects env entries that are no {name, value} strings", () => {
    expect(() => McpServer.fromEntry({ ...PLAYWRIGHT, env: [{ name: "A" }] }, "[0]")).toThrow(/^\[0\]\.env must be an array of \{name, value\} strings$/);
  });

  it("rejects an invalid construction", () => {
    expect(() => new McpServer({ name: "playwright", command: "node" })).toThrow(/must be an absolute path/);
  });

  it("is equal to a server with the same entry", () => {
    expect(new McpServer(PLAYWRIGHT).isEqualTo(McpServer.fromEntry(PLAYWRIGHT, "[0]"))).toBe(true);
    expect(new McpServer(PLAYWRIGHT).isEqualTo(new McpServer({ ...PLAYWRIGHT, args: [] }))).toBe(false);
  });
});
