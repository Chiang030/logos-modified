import { describe, expect, it } from "vitest";
import { appendMessage, appendTool, restoreTimeline, settleTimeline, updateMessage, updateTool } from "../webview-ui/src/timeline";

describe("timeline", () => {
  it("closes pending tools on interruption and distinguishes user cancellation", () => {
    const items = appendTool(appendMessage([], { id: "m", role: "assistant", text: "partial", status: "streaming" }, 1), { id: "t", name: "solver", status: "running" }, 2);
    expect(settleTimeline(items, "aborted").map((item) => item.value.status)).toEqual(["aborted", "aborted"]);
    expect(settleTimeline(items, "interrupted").map((item) => item.value.status)).toEqual(["interrupted", "interrupted"]);
  });
  it("keeps live messages and tools in arrival order", () => {
    let items = appendMessage([], { id: "user-1", role: "user", text: "go", status: "complete" }, 1);
    items = appendMessage(items, { id: "assistant-1", role: "assistant", text: "", status: "streaming" }, 2);
    items = appendTool(items, { id: "tool-1", name: "mesh", status: "running" }, 3);
    items = updateTool(items, { id: "tool-1", name: "mesh", status: "completed", output: "ok" }, 4);
    items = updateMessage(items, "assistant-1", (message) => ({ ...message, text: "done", status: "complete" }), 5);

    expect(items.map((item) => `${item.kind}:${item.value.id}`)).toEqual([
      "message:user-1", "message:assistant-1", "tool:tool-1",
    ]);
    expect(items[1].kind === "message" && items[1].value.text).toBe("done");
    expect(items[2].kind === "tool" && items[2].value.output).toBe("ok");
    expect(items[2].order).toBe(3);
  });

  it("keeps empty streaming messages and error tool output", () => {
    let items = updateMessage([], "assistant-1", (message) => message, 1);
    items = updateTool(items, { id: "tool-1", name: "mesh", status: "error", output: "" }, 2);
    items = updateMessage(items, "assistant-1", (message) => ({ ...message, status: "error" }), 3);

    expect(items).toHaveLength(2);
    expect(items[0].kind === "message" && items[0].value.status).toBe("error");
    expect(items[1].kind === "tool" && items[1].value.output).toBe("");
  });

  it("restores messages and tools by persisted position", () => {
    const items = restoreTimeline(
      [{ id: "m-2", role: "assistant", text: "second", position: 3 }, { id: "m-1", role: "user", text: "first", position: 1 }],
      [{ id: "t-1", name: "run", status: "completed", position: 2 }],
    );
    expect(items.map((item) => item.value.id)).toEqual(["m-1", "t-1", "m-2"]);
  });
  it("keeps the historical user name when restoring and updating messages", () => {
    const items = restoreTimeline([{ id: "user", role: "user", text: "hello", userName: "Original member" }], []);
    const updated = updateMessage(items, "user", (message) => ({ ...message, text: "hello again" }), 1);
    expect(updated[0].kind === "message" && updated[0].value.userName).toBe("Original member");
  });
});
