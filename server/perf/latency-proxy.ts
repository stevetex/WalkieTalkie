// A TCP proxy that makes a local relay look like one across a network: every chunk waits
// `delayMs` each way, a new connection costs a round trip before its first byte goes through
// (the TCP handshake; TLS isn't simulated), and `kbps`, if set, limits each direction's rate.
// It also counts the bytes each way, which the scenarios report.
//
// Order is kept: each direction is a queue with one timer, so a chunk never overtakes the one
// before it.

import { createServer, connect, type Server, type Socket } from "node:net";

export interface ProxyOptions {
  target: number; // the relay's port on localhost
  delayMs: number; // one way
  kbps?: number;
}

export interface ProxyCounters {
  bytesUp: number; // client → relay
  bytesDown: number; // relay → client
  connections: number;
}

export class LatencyProxy {
  readonly counters: ProxyCounters = { bytesUp: 0, bytesDown: 0, connections: 0 };
  port = 0;
  private options: ProxyOptions;
  private server: Server;
  private sockets = new Set<Socket>();

  constructor(options: ProxyOptions) {
    this.options = options;
    this.server = createServer((client) => this.accept(client));
  }

  static async start(options: ProxyOptions): Promise<LatencyProxy> {
    const proxy = new LatencyProxy(options);
    await new Promise<void>((resolve) => proxy.server.listen(0, "127.0.0.1", resolve));
    const address = proxy.server.address();
    proxy.port = typeof address === "object" && address ? address.port : 0;
    return proxy;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  resetCounters(): void {
    this.counters.bytesUp = 0;
    this.counters.bytesDown = 0;
    this.counters.connections = 0;
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private accept(client: Socket): void {
    this.counters.connections++;
    const upstream = connect(this.options.target, "127.0.0.1");
    this.sockets.add(client);
    this.sockets.add(upstream);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    // The handshake: nothing reaches the relay until a round trip after the connection opens.
    const openAt = performance.now() + 2 * this.options.delayMs;
    const up = new DelayedPipe(upstream, this.options, openAt, (n) => (this.counters.bytesUp += n));
    const down = new DelayedPipe(client, this.options, 0, (n) => (this.counters.bytesDown += n));
    client.on("data", (chunk) => up.push(chunk));
    upstream.on("data", (chunk) => down.push(chunk));
    client.on("end", () => up.end());
    upstream.on("end", () => down.end());
    const close = (): void => {
      client.destroy();
      upstream.destroy();
      this.sockets.delete(client);
      this.sockets.delete(upstream);
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", () => up.end());
    upstream.on("close", () => down.end());
  }
}

class DelayedPipe {
  private queue: Array<{ due: number; chunk: Buffer | null }> = [];
  private timer: NodeJS.Timeout | null = null;
  // When the link is free again, for the rate limit.
  private freeAt = 0;
  private lastDue = 0;
  private out: Socket;
  private options: ProxyOptions;
  private openAt: number;
  private count: (bytes: number) => void;

  constructor(out: Socket, options: ProxyOptions, openAt: number, count: (bytes: number) => void) {
    this.out = out;
    this.options = options;
    this.openAt = openAt;
    this.count = count;
  }

  push(chunk: Buffer): void {
    this.count(chunk.length);
    const now = performance.now();
    let sent = Math.max(now, this.openAt);
    if (this.options.kbps) {
      sent = Math.max(sent, this.freeAt) + (chunk.length * 8) / this.options.kbps;
      this.freeAt = sent;
    }
    this.enqueue(sent + this.options.delayMs, chunk);
  }

  end(): void {
    this.enqueue(Math.max(performance.now(), this.openAt) + this.options.delayMs, null);
  }

  private enqueue(due: number, chunk: Buffer | null): void {
    due = Math.max(due, this.lastDue);
    this.lastDue = due;
    this.queue.push({ due, chunk });
    if (!this.timer) this.schedule();
  }

  private schedule(): void {
    const next = this.queue[0];
    if (!next) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = performance.now();
      while (this.queue.length && this.queue[0].due <= now + 0.5) {
        const { chunk } = this.queue.shift()!;
        if (this.out.destroyed) continue;
        if (chunk) this.out.write(chunk);
        else this.out.end();
      }
      this.schedule();
    }, Math.max(0, next.due - performance.now()));
  }
}
