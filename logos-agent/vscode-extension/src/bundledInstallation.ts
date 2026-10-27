import { createHash } from "node:crypto";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

/** Materialize the shipped runtime without depending on a developer checkout. */
export async function installBundledRuntime(
  extensionRoot: string,
  storageRoot: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const source = join(extensionRoot, "runtime");
  const manifest = await readFile(join(source, "payload-manifest.json"));
  const digest = createHash("sha256").update(manifest).digest("hex").slice(0, 20);
  const installations = join(storageRoot, "installations");
  const target = join(installations, digest);
  try {
    await access(join(target, ".complete"));
  } catch {
    await mkdir(installations, { recursive: true });
    const temporary = await mkdtemp(join(installations, ".install-"));
    try {
      await cp(source, temporary, { recursive: true });
      await cp(join(source, "payload-manifest.json"), join(temporary, ".complete"));
      try { await rename(temporary, target); } catch (error) {
        // Another VS Code window may have completed the same installation.
        try { await access(join(target, ".complete")); } catch { throw error; }
      }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  await ensureExecutableBits(target, platform);
  return target;
}

export type ChangeMode = (path: string, mode: number) => Promise<void>;

/**
 * VSIX extraction drops execute permission bits, so restore them on POSIX hosts
 * for the bundled Node.js, esbuild, and sim runtime binaries.
 */
export async function ensureExecutableBits(
  root: string,
  platform: NodeJS.Platform = process.platform,
  changeMode: ChangeMode = (path, mode) => chmod(path, mode),
): Promise<void> {
  if (platform === "win32") return;
  await setModeWhenPresent(changeMode, join(root, "vendor", "node", "node"));
  const esbuildPackages = join(root, "vendor", "pi", "node_modules", "@esbuild");
  try {
    for (const entry of await readdir(esbuildPackages, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // esbuild ships its binary at the package root on Windows and under bin/ on POSIX.
      await setModeWhenPresent(changeMode, join(esbuildPackages, entry.name, "esbuild"));
      await setModeWhenPresent(changeMode, join(esbuildPackages, entry.name, "bin", "esbuild"));
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  // The bundled sim runtime's interpreters lose their bits the same way.
  const venvBin = join(root, "logos-agent", "integrations", ".venv", "bin");
  try {
    for (const entry of await readdir(venvBin, { withFileTypes: true })) {
      if (entry.isFile()) await setModeWhenPresent(changeMode, join(venvBin, entry.name));
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function setModeWhenPresent(changeMode: ChangeMode, path: string): Promise<void> {
  try {
    await changeMode(path, 0o755);
  } catch (error) {
    // Payloads built for other platforms carry different binary names; the
    // launch-time platform check reports that case precisely.
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === "ENOENT";
}
