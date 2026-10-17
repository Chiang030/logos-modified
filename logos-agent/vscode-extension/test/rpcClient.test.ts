import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { JsonlDecoder, RpcClient, type RpcRecord } from "../src/rpcClient";

describe("JsonlDecoder", () => {
  it("splits only on LF and preserves Unicode separators in strings", () => {
    const decoder = new JsonlDecoder();
    const first = decoder.push(Buffer.from('{"type":"event","text":"a\\u2028b"}\r\n{"type":"next"}'));
    expect(first).toEqual([{ type: "event", text: "a\u2028b" }]);
    expect(decoder.finish()).toEqual([{ type: "next" }]);
  });

  it("rejects non-object records", () => {
    const decoder = new JsonlDecoder();
    expect(() => decoder.push("[]\n")).toThrow("RPC record must be a JSON object");
  });
});

describe("RpcClient", () => {
  it("correlates responses and forwards session events", async () => {
    const script = `
      let buffer = "";
      process.stdin.on("data", chunk => {
        buffer += chunk;
        while (buffer.includes("\\n")) {
          const index = buffer.indexOf("\\n");
          const command = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (command.type === "get_state") {
            process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: "get_state", success: true, data: { sessionId: "test", isStreaming: false } }) + "\\n");
          }
          if (command.type === "prompt") {
            process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } }) + "\\n");
            process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
          }
        }
      });
    `;
    const child = spawn(process.execPath, ["-e", script], { stdio: "pipe" });
    const client = new RpcClient(child);
    const events: RpcRecord[] = [];
    client.onRecord((record) => events.push(record));

    await expect(client.getState()).resolves.toEqual({ sessionId: "test", isStreaming: false });
    await expect(client.prompt("hello")).resolves.toEqual({ disposition: "started" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toContainEqual({ type: "agent_start" });
    await client.dispose();
  });

  it("cancels timed out requests so the child stays usable", async () => {
    const script = `
      let buffer = "";
      const commands = [];
      process.stdin.on("data", chunk => {
        buffer += chunk;
        while (buffer.includes("\\n")) {
          const index = buffer.indexOf("\\n");
          const command = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          commands.push(command.type);
          if (command.type === "inspect") {
            process.stdout.write(JSON.stringify({ id: command.id, type: "response", success: true, data: commands }) + "\\n");
          }
        }
      });
    `;
    const child = spawn(process.execPath, ["-e", script], { stdio: "pipe" });
    const client = new RpcClient(child);
    await expect(client.requestWithTimeout({ type: "new_session" }, 20)).rejects.toThrow("new_session timed out");
    await expect(client.request<string[]>({ type: "inspect" })).resolves.toEqual(["new_session", "inspect"]);
    await client.dispose();
  });
});
