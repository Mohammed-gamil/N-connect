import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
const cargoBin = path.join(home, ".cargo", "bin");
const sep = process.platform === "win32" ? ";" : ":";
const env = {
  ...process.env,
  PATH: `${cargoBin}${sep}${process.env.PATH || ""}`,
};

// On sandboxed Linux VMs where system rustup is read-only, use user-space ~/.rustup if present.
if (
  process.platform !== "win32" &&
  fs.existsSync(path.join(home, ".rustup")) &&
  (!env.RUSTUP_HOME || env.RUSTUP_HOME === "/usr/local/rustup")
) {
  env.RUSTUP_HOME = path.join(home, ".rustup");
  env.CARGO_HOME = path.join(home, ".cargo");
}

const args = ["--release", ...process.argv.slice(2)];
const result = spawnSync("worker-build", args, {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

if (result.error) {
  console.error("Failed to run worker-build:", result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
