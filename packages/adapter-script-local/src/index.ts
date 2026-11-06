import { execSync } from "node:child_process";

export const packageName = "@aitw/adapter-script-local";

/** Runs a user-supplied command and returns its standard output. */
export function runScript(command: string): string {
  try {
    return execSync(`sh -c "${command}"`).toString();
  } catch {
    return "";
  }
}
