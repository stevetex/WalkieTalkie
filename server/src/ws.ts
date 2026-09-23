// Minimal RFC 6455 WebSocket server side, so the spike server has no npm dependencies.
// Supports text/binary messages, fragmentation, ping/pong and close. No extensions.

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 1 << 20;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export function acceptUpgrade(req: IncomingMessage, socket: Duplex): WebSocketConnection | null {
  const key = req.headers["sec-websocket-key"];
  if (req.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return null;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new WebSocketConnection(socket);
}

export function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
}

// Events: "text" (string), "binary" (Buffer), "close" (code: number)
export class WebSocketConnection extends EventEmitter {
  private socket: Duplex;
  private pending: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private closed = false;
  private pingTimer: NodeJS.Timeout;
  private lastSeen = Date.now();

  constructor(socket: Duplex) {
    super();
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("close", () => this.finish(1006));
    socket.on("error", () => this.finish(1006));
    // Keepalive: carrier NATs drop idle TCP flows quickly.
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastSeen > 45_000) {
        this.socket.destroy();
        return;
      }
      this.writeFrame(OP_PING, Buffer.alloc(0));
    }, 15_000);
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  sendText(text: string): void {
    this.writeFrame(OP_TEXT, Buffer.from(text, "utf8"));
  }

  sendJSON(value: unknown): void {
    this.sendText(JSON.stringify(value));
  }

  sendBinary(data: Buffer): void {
    this.writeFrame(OP_BINARY, data);
  }

  close(code = 1000): void {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.writeFrame(OP_CLOSE, payload);
    this.socket.end();
    this.finish(code);
  }

  private finish(code: number): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    this.emit("close", code);
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  private onData(chunk: Buffer): void {
    this.lastSeen = Date.now();
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.parseFrame()) {
      // keep parsing
    }
  }

  // Returns true if a frame was consumed.
  private parseFrame(): boolean {
    const buf = this.pending;
    if (buf.length < 2) return false;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return false;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return false;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE_BYTES)) {
        this.close(1009);
        return false;
      }
      len = Number(big);
      offset = 10;
    }
    if (!masked) {
      // Clients must mask (RFC 6455 5.1).
      this.close(1002);
      return false;
    }
    if (buf.length < offset + 4 + len) return false;
    const mask = buf.subarray(offset, offset + 4);
    const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.pending = buf.subarray(offset + 4 + len);

    switch (opcode) {
      case OP_PING:
        this.writeFrame(OP_PONG, payload);
        break;
      case OP_PONG:
        break;
      case OP_CLOSE:
        this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000);
        break;
      case OP_TEXT:
      case OP_BINARY:
      case OP_CONT: {
        if (opcode !== OP_CONT) {
          this.fragments = [];
          this.fragmentOpcode = opcode;
        }
        this.fragments.push(payload);
        if (this.fragments.reduce((n, b) => n + b.length, 0) > MAX_MESSAGE_BYTES) {
          this.close(1009);
          return false;
        }
        if (fin) {
          const message = Buffer.concat(this.fragments);
          this.fragments = [];
          if (this.fragmentOpcode === OP_TEXT) this.emit("text", message.toString("utf8"));
          else this.emit("binary", message);
        }
        break;
      }
      default:
        this.close(1002);
        return false;
    }
    return true;
  }
}
