import { describe, expect, it } from "vitest";
import { describeModelError } from "../src/modelErrors";
import { isAccountLimitError, normalizeAccountLimitMessage } from "../../pi-domain/src/model-errors.mjs";

const balanceError = '429: {"code":"1113","message":"余额不足或无可用资源包,请充值。"}';

describe("model account limits", () => {
  it("recognizes exhausted accounts without treating ordinary rate limits as billing errors", () => {
    for (const error of [balanceError, '429: {"code":1113}', '429 insufficient_quota', '402 insufficient balance', 'credit balance is too low']) {
      expect(isAccountLimitError(error)).toBe(true);
      expect(describeModelError(error)).toContain(error);
      expect(describeModelError(error)).toContain("已停止自动重试");
    }
    for (const error of ['429 Too many requests', '429: {"code":"11130","message":"请求过于频繁"}', '503 overloaded', undefined]) {
      expect(isAccountLimitError(error)).toBe(false);
      expect(describeModelError(error)).toBe(error);
    }
  });

  it("normalizes only failed assistant messages, keeping content and the original provider error", () => {
    const message = { role: "assistant", stopReason: "error", errorMessage: balanceError, content: [{ type: "text", text: "partial" }] };
    const normalized = normalizeAccountLimitMessage(message)!;
    expect(normalized).toEqual({ ...message, errorMessage: `insufficient_quota: ${balanceError}` });
    expect(message.errorMessage).toBe(balanceError);
    expect(normalizeAccountLimitMessage(normalized)).toBeUndefined();
    expect(normalizeAccountLimitMessage({ ...message, stopReason: "stop" })).toBeUndefined();
    expect(normalizeAccountLimitMessage({ ...message, role: "toolResult" })).toBeUndefined();
    expect(normalizeAccountLimitMessage({ ...message, errorMessage: "429 Too many requests" })).toBeUndefined();
  });
});
