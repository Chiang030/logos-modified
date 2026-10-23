import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, access, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

/** Materialize the shipped runtime without depending on a developer checkout. */
export async function installBundledRuntime(extensionRoot: string, storageRoot: string): Promise<string> {
  const source = join(extensionRoot, "runtime");
  const manifest = await readFile(join(source, "payload-manifest.json"));
  const digest = createHash("sha256").update(manifest).digest("hex").slice(0, 20);
  const installations = join(storageRoot, "installations");
  const target = join(installations, digest);
  try { await access(join(target, ".complete")); return target; } catch { /* First activation of this payload. */ }
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
  return target;
}
