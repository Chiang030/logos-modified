export interface MemberIdentity { id: string; name: string; }

export function validMemberName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length > 0 && name.trim().length <= 80 && !/[\u0000-\u001f\u007f]/.test(name);
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageSummary extends TokenUsage {
  member: MemberIdentity;
  sessions: number;
  responses: number;
  failed: number;
  unknownUsage: number;
}

export interface ModelUsageSummary extends UsageSummary { provider: string; model: string; }

export interface IdentityView {
  selected?: MemberIdentity;
  members: MemberIdentity[];
  summaries: UsageSummary[];
  models: ModelUsageSummary[];
  recordFile: string;
}
