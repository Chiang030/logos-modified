export function isAccountLimitError(value: unknown): value is string;
export function normalizeAccountLimitMessage<T extends { role?: string; stopReason?: string; errorMessage?: string }>(message: T): T | undefined;
