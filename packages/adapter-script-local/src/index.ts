import { execFileSync } from "node:child_process";

export const packageName = "@aitw/adapter-script-local";

/** Runs a trusted shell command and returns its standard output. */
export function runScript(command: string): string {
  return execFileSync("sh", ["-e", "-c", command], { encoding: "utf8" });
}
