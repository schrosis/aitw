import { execFileSync } from "node:child_process";
import { accessSync, constants, rmSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { TestProject } from "vitest/node";

import { temporalCliManifest } from "./packages/cli/src/temporal-cli/manifest.ts";

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Finds the Temporal CLI that mise installs from mise.toml.
 *
 * Tests use it instead of letting the Temporal SDK download a server at run time, and its
 * version must match the release that ugoke pins for the development server.
 */
const findTemporalCli = (): string => {
  const path = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((directory) => directory !== "")
    .map((directory) => join(directory, "temporal"))
    .find(isExecutable);
  if (path === undefined) {
    throw new Error("Temporal CLI is not in PATH. Install it with: mise install");
  }

  const version = execFileSync(path, ["--version"], { encoding: "utf8" });
  const expected = `temporal version ${temporalCliManifest.version} `;
  if (!version.startsWith(expected)) {
    throw new Error(
      `Temporal CLI at ${path} is not ${temporalCliManifest.version}: ${version.trim()}. ` +
        "Keep mise.toml in sync with packages/cli/src/temporal-cli/manifest.ts",
    );
  }
  return path;
};

export default ({ config, provide }: TestProject): (() => void) => {
  provide("temporalCli", findTemporalCli());
  const state = config.env.XDG_STATE_HOME;
  return () => {
    if (state !== undefined) {
      rmSync(state, { force: true, recursive: true });
    }
  };
};
