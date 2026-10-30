/** Remove common credentials before showing provider/process diagnostics. */
export function redactDiagnostic(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/(Bearer\s+)[^\s,"']+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)["']?\s*[=:]\s*["']?)[^\s,"'&}]+/gi, "$1[redacted]")
    .replace(/\bsk-[\w-]{8,}/g, "[redacted]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g, "$1[redacted]@");
}
