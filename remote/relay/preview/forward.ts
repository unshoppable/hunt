/**
 * TCP forwards for the preview's services: `127.0.0.1:<port>` in the session container to `<host>:<port>`, a service
 * container on the session's network, so a repository whose `.env` points at 127.0.0.1 works unchanged. Every
 * connection opens one to the service; a half-close passes through, an error on either side ends both.
 */
import { connect, createServer, type Server, type Socket } from "node:net";

export interface ForwardTarget {
  port: number;
  host: string;
}

export interface ForwardHandle {
  /** The port the forward listens on. */
  readonly port: number;
  /** Stops listening and ends the open connections. */
  close(): Promise<void>;
}

export interface ForwardOptions {
  /** Where to listen; 127.0.0.1 and the target's port by default. */
  listenHost?: string;
  listenPort?: number;
}

/** Listens and forwards; rejects when the port cannot be bound. */
export function startForward(target: ForwardTarget, options: ForwardOptions = {}): Promise<ForwardHandle> {
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = connect({ host: target.host, port: target.port, allowHalfOpen: true });
    bridge(client, upstream, sockets);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.listenPort ?? target.port, options.listenHost ?? "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : target.port;
      resolve({ port, close: () => closeServer(server, sockets) });
    });
  });
}

function bridge(client: Socket, upstream: Socket, sockets: Set<Socket>): void {
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on("error", () => {
      client.destroy();
      upstream.destroy();
    });
    socket.on("close", () => sockets.delete(socket));
  }
  client.pipe(upstream);
  upstream.pipe(client);
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    for (const socket of sockets) {
      socket.destroy();
    }
  });
}
