const valid = (v) => Number.isFinite(v) && v >= 0;

/** Pi final usage is disjoint for input/cache; reasoning and 1h writes are subsets. */
export function normalizeUsage(usage, model) {
  if (!usage) return { metadata: { usageStatus: "missing", costStatus: "unknown" } };
  const { input: i, output: o, cacheRead: r, cacheWrite: w, cacheWrite1h: h, reasoning: q } = usage;
  const good = [i, o, r, w].every(valid) && (h === undefined || valid(h) && h <= w)
    && (q === undefined || valid(q) && q <= o);
  if (!good) return { metadata: { usageStatus: "invalid", costStatus: "unknown" } };
  const total = i + o + r + w;
  const metadata = {
    usageStatus: total === 0 ? "unverified_zero" : "pi_final",
    usageSource: "final_assistant_message", usageMode: "disjoint",
    subsetDetailsLocation: "metadata_only", ordinaryInput: i, cacheRead: r, cacheWrite: w,
    cacheWrite1h: h, cacheWriteOther: h === undefined ? undefined : w - h,
    reasoning: q, nonReasoningOutput: q === undefined ? undefined : o - q,
    reportedTotal: usage.totalTokens, normalizedTotal: total,
    totalMismatch: usage.totalTokens !== undefined && usage.totalTokens !== total,
    costStatus: "unknown",
  };
  const result = { metadata };
  if (total > 0) result.usageDetails = { input: i, input_cache_read: r, input_cache_write: w, output: o };
  const cost = usage.cost;
  const priceKeys = ["input", "output", "cacheRead", "cacheWrite"];
  const knownPrice = model?.cost && priceKeys.every((key) => valid(model.cost[key]))
    && priceKeys.some((key) => model.cost[key] > 0);
  if (knownPrice && cost && [cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total].every(valid)) {
    const input = cost.input + cost.cacheRead + cost.cacheWrite;
    if (Math.abs(input + cost.output - cost.total) < 1e-8 && total > 0) {
      result.costDetails = { input: cost.input, input_cache_read: cost.cacheRead,
        input_cache_write: cost.cacheWrite, output: cost.output, total: cost.total };
      Object.assign(metadata, { costStatus: "estimated", costSource: "pi_final_cost",
        costCurrency: "USD", inputCost: cost.input, cacheReadCost: cost.cacheRead,
        cacheWriteCost: cost.cacheWrite, outputCost: cost.output, costTotal: cost.total });
    }
  }
  return result;
}
