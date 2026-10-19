/** Interpret engineering evidence without changing tool results or triggering operations. */
export function simulationResult(result) {
  const d = result?.details;
  if (!d || typeof d !== "object") return { engineeringEvidence: "missing" };
  const fields = {};
  for (const key of ["transport_ok", "script_ok", "acceptance", "exit_code", "remote_state",
    "operation_id", "output_truncated", "stage", "backend", "error"])
    if (Object.hasOwn(d, key)) fields[key] = d[key];
  fields.engineeringEvidence = "result.details";
  return fields;
}
