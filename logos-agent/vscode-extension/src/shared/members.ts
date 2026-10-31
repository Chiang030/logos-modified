/** Stable IDs keep historical attribution independent of display names. */
export const MEMBERS = [
  { id: "murphy", name: "马凡/Murphy" },
  { id: "linchen", name: "林晨/LinChen" },
  { id: "peyman", name: "Peyman" },
  { id: "xu-yaxiong", name: "许亚雄" },
  { id: "qian-yingtao", name: "钱营涛" },
  { id: "jiang-jincheng", name: "蒋金成" },
  { id: "lu-junqian", name: "陆俊谦" },
  { id: "wu-kaiyang", name: "吴锴扬" },
  { id: "shen-guanbin", name: "沈冠斌" },
  { id: "hu-junwei", name: "胡峻玮" },
  { id: "xie-yuan", name: "谢元" },
] as const;

export interface MemberIdentity { id: string; name: string; }

export function memberById(id: unknown): MemberIdentity | undefined {
  return MEMBERS.find((member) => member.id === id);
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
  summaries: UsageSummary[];
  models: ModelUsageSummary[];
  recordFile: string;
}
