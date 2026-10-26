import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureExecutableBits } from "../src/bundledInstallation";

describe("ensureExecutableBits", () => {
  it("restores execute bits on POSIX payloads and skips Windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "logos-chmod-"));
    try {
      await mkdir(join(root, "vendor", "node"), { recursive: true });
      await writeFile(join(root, "vendor", "node", "node"), "");
      await mkdir(join(root, "vendor", "pi", "node_modules", "@esbuild", "linux-x64"), { recursive: true });
      await writeFile(join(root, "vendor", "pi", "node_modules", "@esbuild", "linux-x64", "esbuild"), "");
      const calls: Array<[string, number]> = [];
      const changeMode = async (path: string, mode: number) => { calls.push([path, mode]); };

      await ensureExecutableBits(root, "win32", changeMode);
      expect(calls).toEqual([]);

      await ensureExecutableBits(root, "linux", changeMode);
      expect(calls).toEqual([
        [join(root, "vendor", "node", "node"), 0o755],
        [join(root, "vendor", "pi", "node_modules", "@esbuild", "linux-x64", "esbuild"), 0o755],
        [join(root, "vendor", "pi", "node_modules", "@esbuild", "linux-x64", "bin", "esbuild"), 0o755],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tolerates payloads without the expected binaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "logos-chmod-empty-"));
    try {
      await expect(ensureExecutableBits(root, "linux")).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
