/** Billing exhaustion requires an account change, not a timed retry. */
export function isAccountLimitError(value) {
  return typeof value === "string" && /余额不足|无可用资源包|资源包已用尽|insufficient[_\s]+quota|insufficient[_\s]+(?:balance|credits?)|credit balance is too low|billing_hard_limit_reached|["'](?:code|error_code)["']\s*:\s*["']?1113["'}\s,]/i.test(value);
}

/** Use Pi's recognized terminal-quota classification while preserving the provider text. */
export function normalizeAccountLimitMessage(message) {
  if (message?.role !== "assistant" || message.stopReason !== "error" || !isAccountLimitError(message.errorMessage)) return;
  if (/insufficient_quota/i.test(message.errorMessage)) return;
  return { ...message, errorMessage: `insufficient_quota: ${message.errorMessage}` };
}
