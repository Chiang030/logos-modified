#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const localEnv = new URL("../.env", import.meta.url);
if (existsSync(localEnv)) process.loadEnvFile(fileURLToPath(localEnv));

const args = process.argv.slice(2);
if (args[0] === "--logo") {
  const { preview } = await import("./preview.mjs");
  await preview({ staticFrame: args.includes("--static"), once: args.includes("--once") });
} else {
  const source = new URL("../../vendor/pi/", import.meta.url);
  const entry = new URL("packages/coding-agent/src/cli.ts", source);
  const resolver = new URL("packages/coding-agent/src/experimental/source-resolver.ts", source);
  if (!existsSync(entry) || !existsSync(resolver)) {
    console.error("LOGOS: Pi source is missing. Run git submodule update --init --recursive, then npm run pi:setup.");
    process.exit(1);
  }
  if (!existsSync(new URL("node_modules/.package-lock.json", source))) {
    const product = fileURLToPath(new URL("../", import.meta.url));
    console.error(`LOGOS: dependencies are missing. Prepare them once: npm --prefix "${product}" run pi:setup`);
    process.exit(1);
  }
  const extension = fileURLToPath(new URL("../pi-domain/extensions/index.mjs", import.meta.url));
  const defaults = [];
  if (!args.includes("--system-prompt")) {
    const prompt = fileURLToPath(new URL("../pi-domain/prompts/system.md", import.meta.url));
    defaults.push("--system-prompt", prompt);
  }
  defaults.push("--append-system-prompt", fileURLToPath(new URL("../pi-domain/prompts/append.md", import.meta.url)));
  if (!args.includes("--no-skills") && !args.includes("-ns")) {
    defaults.push("--skill", fileURLToPath(new URL("../pi-domain/skills/", import.meta.url)));
  }
  if (!args.some((arg) => arg === "--model" || arg.startsWith("--model=")) && process.env.LOGOS_MODEL) {
    defaults.push("--model", process.env.LOGOS_MODEL);
    if (process.env.LOGOS_PROVIDER && !args.some((arg) => arg === "--provider" || arg.startsWith("--provider="))) {
      defaults.push("--provider", process.env.LOGOS_PROVIDER);
    }
  }
  const child = spawn(process.execPath, ["--import", resolver.href, fileURLToPath(entry), "-e", extension, ...defaults, ...args], {
    stdio: "inherit",
  });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  child.on("error", (error) => { console.error(`LOGOS: ${error.message}`); process.exitCode = 1; });
  child.on("exit", (code, signal) => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  });
}
