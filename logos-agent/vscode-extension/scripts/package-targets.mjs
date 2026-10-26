// Shared build-target definitions for the packaging scripts so the pinned
// Node.js version and archive layout cannot drift between them.
export const NODE_RUNTIME_VERSION = "22.23.4";
export const NODE_DIST_URL = "https://nodejs.org/dist";
export const BUILD_TARGETS = ["win32-x64", "linux-x64", "linux-arm64"];

export function parseTargetArgument(argv) {
  const index = argv.indexOf("--target");
  return index !== -1 ? argv[index + 1] : undefined;
}

/** Resolve the Node.js dist archive layout for a build target. */
export function targetDefinition(target) {
  if (!BUILD_TARGETS.includes(target)) {
    const msg = `Unknown build target ${JSON.stringify(target ?? "")}; expected one of: ${BUILD_TARGETS.join(", ")}`;
    throw new Error(msg);
  }
  const windows = target === "win32-x64";
  // nodejs.org dist names the Windows archive "win-x64", not "win32-x64".
  const root = `node-v${NODE_RUNTIME_VERSION}-${windows ? "win-x64" : target}`;
  return {
    archive: `${root}.${windows ? "zip" : "tar.xz"}`,
    nodeBinary: windows ? "node.exe" : "node",
    nodeEntry: windows ? `${root}/node.exe` : `${root}/bin/node`,
    nodeLicense: "LICENSE",
    esbuildPackage: `@esbuild/${target}`,
    // esbuild ships the binary at the package root on Windows, under bin/ on POSIX.
    esbuildBinary: windows ? "esbuild.exe" : "bin/esbuild",
  };
}
