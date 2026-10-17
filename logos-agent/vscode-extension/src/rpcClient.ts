import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface RpcRecord {
  type?: string;
  id?: string;
  [key: string]: unknown;
}

export class JsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  push(chunk: string | Uint8Array): RpcRecord[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    return this.drainLines();
  }

  finish(): RpcRecord[] {
    this.buffer += this.decoder.end();
    return this.drainLines(true);
  }

  private drainLines(includeRemainder = false): RpcRecord[] {
    const records: RpcRecord[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      records.push(parseRecord(line));
    }
    if (includeRemainder && this.buffer.length > 0) {
      const remainder = this.buffer.replace(/\r$/, "");
      this.buffer = "";
      records.push(parseRecord(remainder));
    }
    return records;
  }
}

export class RpcProtocolError extends Error {
  constructor(message: string, readonly line?: string) {
    super(message);
    this.name = "RpcProtocolError";
  }
}

export interface RpcExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  command: string;
}

export class RpcClient {
  private readonly decoder = new JsonlDecoder();
  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private readonly recordListeners = new Set<(record: RpcRecord) => void>();
  private readonly stderrListeners = new Set<(text: string) => void>();
  private readonly protocolErrorListeners = new Set<(error: RpcProtocolError) => void>();
  private readonly exitListeners = new Set<(exit: RpcExit) => void>();
  private sequence = 0;
  private disposed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    child.stdout.on("end", () => this.handleEnd());
    child.stderr.on("data", (chunk: Buffer) => this.emit(this.stderrListeners, chunk.toString("utf8")));
    child.on("error", (error) => this.rejectAll(error));
    child.on("exit", (code, signal) => {
      this.rejectAll(new Error(`LOGOS exited before completing a request (${code ?? signal ?? "unknown"})`));
      this.emit(this.exitListeners, { code, signal });
    });
  }

  get isRunning(): boolean {
    return !this.disposed && this.child.exitCode === null && !this.child.killed;
  }

  onRecord(listener: (record: RpcRecord) => void): () => void {
    this.recordListeners.add(listener);
    return () => this.recordListeners.delete(listener);
  }

  onStderr(listener: (text: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  onProtocolError(listener: (error: RpcProtocolError) => void): () => void {
    this.protocolErrorListeners.add(listener);
    return () => this.protocolErrorListeners.delete(listener);
  }

  onExit(listener: (exit: RpcExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async request<T>(command: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (!this.isRunning) throw new Error("LOGOS RPC process is not running");
    if (signal?.aborted) throw new Error("RPC request aborted");
    const id = `logos-${++this.sequence}`;
    const type = typeof command.type === "string" ? command.type : "unknown";
    const request = { ...command, id };
    let rejectRequest: (error: Error) => void = () => undefined;
    const promise = new Promise<T>((resolve, reject) => {
      rejectRequest = reject;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, command: type });
    });
    const abort = () => {
      this.pending.delete(id);
      rejectRequest(new Error("RPC request aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.write(request);
      return await promise;
    } catch (error) {
      this.pending.delete(id);
      rejectRequest(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<unknown> {
    return this.request({ type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) });
  }

  abort(): Promise<unknown> {
    return this.request({ type: "abort" });
  }

  newSession(): Promise<unknown> {
    return this.requestWithTimeout({ type: "new_session" });
  }

  async requestWithTimeout<T>(command: Record<string, unknown>, timeoutMs = 3000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      return await Promise.race([
        this.request<T>(command, controller.signal),
        new Promise<T>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`${String(command.type)} timed out`)); }, timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  getState<T>(): Promise<T> {
    return this.requestWithTimeout<T>({ type: "get_state" }, 10_000);
  }

  getMessages<T>(): Promise<T> {
    return this.requestWithTimeout<T>({ type: "get_messages" }, 10_000);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new Error("LOGOS RPC client disposed"));
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill();
        resolve();
      }, 1_000);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private async write(record: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    if (!this.child.stdin.writable) throw new Error("LOGOS RPC stdin is closed");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.child.stdin.off("drain", onDrain);
        reject(error);
      };
      const onDrain = () => {
        this.child.stdin.off("error", onError);
        resolve();
      };
      this.child.stdin.once("error", onError);
      const accepted = this.child.stdin.write(line, "utf8", () => {
        this.child.stdin.off("error", onError);
        if (accepted) resolve();
      });
      if (!accepted) this.child.stdin.once("drain", onDrain);
    });
  }

  private handleChunk(chunk: Buffer): void {
    try {
      for (const record of this.decoder.push(chunk)) this.handleRecord(record);
    } catch (error) {
      this.handleProtocolError(error);
    }
  }

  private handleEnd(): void {
    try {
      for (const record of this.decoder.finish()) this.handleRecord(record);
    } catch (error) {
      this.handleProtocolError(error);
    }
  }

  private handleRecord(record: RpcRecord): void {
    if (record.type === "response" && typeof record.id === "string") {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      if (record.success === false) {
        pending.reject(new Error(typeof record.error === "string" ? record.error : `${pending.command} failed`));
      } else {
        pending.resolve(record.data);
      }
      return;
    }
    this.emit(this.recordListeners, record);
  }

  private handleProtocolError(error: unknown): void {
    const protocolError = error instanceof RpcProtocolError ? error : new RpcProtocolError(String(error));
    this.emit(this.protocolErrorListeners, protocolError);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private emit<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of listeners) listener(value);
  }
}

function parseRecord(line: string): RpcRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new RpcProtocolError(`Invalid JSONL record: ${error instanceof Error ? error.message : String(error)}`, line);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RpcProtocolError("RPC record must be a JSON object", line);
  }
  return parsed as RpcRecord;
}
