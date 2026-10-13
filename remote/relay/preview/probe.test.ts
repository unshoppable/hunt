import { once } from "node:events";
import { createServer as createHttpServer, Server as HttpServer } from "node:http";
import { createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { probeReady } from "./probe.ts";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server instanceof HttpServer) {
      server.closeAllConnections();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** Listens on an ephemeral port of 127.0.0.1 until the test ends. */
async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

/** A port nothing listens on: bound once and released again. */
async function closedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("probeReady", () => {
  it("is false while nothing listens on the port", async () => {
    const port = await closedPort();

    expect(await probeReady({ port, protocol: "http", ready: null })).toBe(false);
    expect(await probeReady({ port, protocol: "http", ready: "/health" })).toBe(false);
  });

  it("is true once the port accepts connections when there is no ready path, and false when the ready path gets no answer", async () => {
    const port = await listen(createServer((socket) => socket.destroy()));

    expect(await probeReady({ port, protocol: "http", ready: null })).toBe(true);
    expect(await probeReady({ port, protocol: "http", ready: "/health" })).toBe(false);
  });

  it("gets the ready path and takes every answer below 500", async () => {
    const requests: string[] = [];
    const port = await listen(
      createHttpServer((request, response) => {
        requests.push(`${request.method} ${request.url} ${request.headers["user-agent"]}`);
        const status = Number(request.url?.slice(1));
        response.writeHead(status, status === 302 ? { location: "/" } : {});
        response.end("body");
      }),
    );

    const answers: [number, boolean][] = [];
    for (const status of [200, 302, 404, 500, 503]) {
      answers.push([status, await probeReady({ port, protocol: "http", ready: `/${status}` })]);
    }

    expect(answers).toEqual([
      [200, true],
      [302, true],
      [404, true],
      [500, false],
      [503, false],
    ]);
    expect(requests[0]).toBe("GET /200 hunt-preview");
  });

  it("takes the status of a large answer without reading its body", async () => {
    const port = await listen(createHttpServer((_request, response) => response.end(Buffer.alloc(8 * 1024 * 1024, "x"))));

    expect(await probeReady({ port, protocol: "http", ready: "/" })).toBe(true);
    expect(await probeReady({ port, protocol: "http", ready: "/" })).toBe(true);
  });

  it("counts a process without a port as ready", async () => {
    expect(await probeReady({ port: null, protocol: "http", ready: null })).toBe(true);
  });
});
