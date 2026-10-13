import { once } from "node:events";
import { createServer as createHttpServer, Server as HttpServer } from "node:http";
import { createServer, type AddressInfo, type Server } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { checkReadiness, previewAddress, type Readiness } from "./probe.ts";

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

describe("checkReadiness", () => {
  it("waits while nothing listens on the port", async () => {
    const port = await closedPort();

    expect(await checkReadiness({ port, protocol: "http", ready: null })).toBe("waiting");
    expect(await checkReadiness({ port, protocol: "http", ready: "/health" })).toBe("waiting");
  });

  it("is ready once the port accepts connections when there is no ready path, and waits when the ready path gets no answer", async () => {
    const port = await listen(createServer((socket) => socket.destroy()));

    expect(await checkReadiness({ port, protocol: "http", ready: null })).toBe("ready");
    expect(await checkReadiness({ port, protocol: "http", ready: "/health" })).toBe("waiting");
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

    const answers: [number, Readiness][] = [];
    for (const status of [200, 302, 404, 500, 503]) {
      answers.push([status, await checkReadiness({ port, protocol: "http", ready: `/${status}` })]);
    }

    expect(answers).toEqual([
      [200, "ready"],
      [302, "ready"],
      [404, "ready"],
      [500, "waiting"],
      [503, "waiting"],
    ]);
    expect(requests[0]).toBe("GET /200 hunt-preview");
  });

  it("takes the status of a large answer without reading its body", async () => {
    const port = await listen(createHttpServer((_request, response) => response.end(Buffer.alloc(8 * 1024 * 1024, "x"))));

    expect(await checkReadiness({ port, protocol: "http", ready: "/" })).toBe("ready");
    expect(await checkReadiness({ port, protocol: "http", ready: "/" })).toBe("ready");
  });

  it("counts a process without a port as ready", async () => {
    expect(await checkReadiness({ port: null, protocol: "http", ready: null })).toBe("ready");
  });

  it.skipIf(previewAddress() === "127.0.0.1")("tells a port open on 127.0.0.1 only from a closed one at the container's address", async () => {
    const port = await listen(createServer((socket) => socket.destroy()));

    expect(await checkReadiness({ port, protocol: "http", ready: null }, previewAddress())).toBe("loopback-only");
    expect(await checkReadiness({ port: await closedPort(), protocol: "http", ready: null }, previewAddress())).toBe("waiting");
  });
});

describe("previewAddress", () => {
  it("takes the first IPv4 address outside the loopback and falls back to 127.0.0.1", () => {
    const entry = (address: string, internal: boolean): NetworkInterfaceInfo =>
      address.includes(":")
        ? { address, family: "IPv6", internal, netmask: "", mac: "", cidr: null, scopeid: 0 }
        : { address, family: "IPv4", internal, netmask: "", mac: "", cidr: null };

    expect(
      previewAddress({
        lo: [entry("127.0.0.1", true)],
        eth0: [entry("fe80::1", false), entry("172.18.0.2", false)],
      }),
    ).toBe("172.18.0.2");
    expect(previewAddress({ lo: [entry("127.0.0.1", true)] })).toBe("127.0.0.1");
  });
});
