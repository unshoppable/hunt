import { once } from "node:events";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startForward, type ForwardHandle, type ForwardOptions, type ForwardTarget } from "./forward.ts";

/** What a test opened, closed after it, newest first. */
const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** Listens on an ephemeral port of 127.0.0.1; after the test the server closes and its connections end. */
async function listen(server: Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  );
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

/** A service that echoes what it receives and answers a half-close with "bye" before it ends its side as well. */
async function echoService(): Promise<{ port: number; connections: Socket[] }> {
  const connections: Socket[] = [];
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    connections.push(socket);
    socket.on("error", () => {});
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("end", () => socket.end("bye"));
  });
  return { port: await listen(server), connections };
}

async function forwardTo(target: ForwardTarget, options: ForwardOptions = { listenPort: 0 }): Promise<ForwardHandle> {
  const forward = await startForward(target, options);
  cleanups.push(() => forward.close());
  return forward;
}

interface Client {
  socket: Socket;
  received(): string;
  /** Resolves once the text received so far contains `expected`. */
  waitFor(expected: string): Promise<void>;
  ended: Promise<void>;
  closed: Promise<void>;
}

async function connectClient(port: number): Promise<Client> {
  const socket = connect({ host: "127.0.0.1", port });
  cleanups.push(() => socket.destroy());
  socket.on("error", () => {});
  socket.setEncoding("utf8");
  let text = "";
  let onData = () => {};
  socket.on("data", (chunk: string) => {
    text += chunk;
    onData();
  });
  const ended = new Promise<void>((resolve) => socket.once("end", () => resolve()));
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await once(socket, "connect");
  return {
    socket,
    received: () => text,
    waitFor: (expected) =>
      new Promise((resolve) => {
        onData = () => {
          if (!text.includes(expected)) return;
          onData = () => {};
          resolve();
        };
        onData();
      }),
    ended,
    closed,
  };
}

describe("startForward", () => {
  it("relays data both ways, with a connection to the service per client connection", async () => {
    const service = await echoService();
    const forward = await forwardTo({ host: "127.0.0.1", port: service.port });
    const first = await connectClient(forward.port);
    const second = await connectClient(forward.port);

    first.socket.write("ping from the first client");
    second.socket.write("ping from the second client");
    await Promise.all([first.waitFor("ping from the first client"), second.waitFor("ping from the second client")]);
    first.socket.write(" and more");
    await first.waitFor("client and more");

    expect(forward.port).not.toBe(service.port);
    expect(first.received()).toBe("ping from the first client and more");
    expect(second.received()).toBe("ping from the second client");
    expect(service.connections).toHaveLength(2);
  });

  it("passes a client's half-close on to the service, whose answer still reaches the client before the end", async () => {
    const service = await echoService();
    const forward = await forwardTo({ host: "127.0.0.1", port: service.port });
    const client = await connectClient(forward.port);

    client.socket.end("last words");
    await client.ended;

    expect(client.received()).toBe("last wordsbye");
  });

  it("closes a client's connection when the service does not accept connections", async () => {
    const forward = await forwardTo({ host: "127.0.0.1", port: await closedPort() });
    const client = await connectClient(forward.port);

    await client.closed;

    expect(client.received()).toBe("");
  });

  it("ends the open connections on close and frees its port", async () => {
    const service = await echoService();
    const forward = await forwardTo({ host: "127.0.0.1", port: service.port });
    const client = await connectClient(forward.port);
    client.socket.write("hello");
    await client.waitFor("hello");

    await forward.close();
    await client.closed;
    const again = await forwardTo({ host: "127.0.0.1", port: service.port }, { listenPort: forward.port });
    const next = await connectClient(again.port);
    next.socket.write("hello again");
    await next.waitFor("hello again");

    expect(again.port).toBe(forward.port);
    expect(client.received()).toBe("hello");
  });

  it("rejects when its port is taken", async () => {
    const port = await listen(createServer());

    await expect(startForward({ host: "127.0.0.1", port: 6379 }, { listenPort: port })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
