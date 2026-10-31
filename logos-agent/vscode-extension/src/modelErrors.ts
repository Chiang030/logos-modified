import { isAccountLimitError } from "../../pi-domain/src/model-errors.mjs";

export function describeModelError(value: unknown): unknown {
  return isAccountLimitError(value)
    ? `模型服务余额或可用额度不足，已停止自动重试。请充值、启用可用资源包，或在设置中切换模型服务后重新发送。\n\n原始错误：${value}`
    : value;
}
