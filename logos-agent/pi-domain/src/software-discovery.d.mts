export interface SoftwareProduct {
  product: string; host: string; platform: string;
  status: "installed" | "missing" | "unsupported" | "invalid-path";
  selected?: string;
  candidates: Array<{ path: string; source: string; version?: string; versionSource: string }>;
  dependency: string; connection: string;
}
export interface SoftwareDiscovery { host: string; platform: string; checkedAt: string; products: SoftwareProduct[]; }
export const SOFTWARE: Array<{ id: string; names: string[]; env: string[]; match: RegExp; windowsOnly?: boolean }>;
export function discoverSoftware(options?: { overrides?: Record<string, string>; cacheFile?: string; refresh?: boolean; platform?: string; env?: NodeJS.ProcessEnv; roots?: string[]; host?: string; registry?: (platform: string) => Promise<string[]> }): Promise<SoftwareDiscovery>;
export function discoveryEnvironment(result: SoftwareDiscovery, original?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
