import { createRequire } from "node:module";

import { Command } from "@commander-js/extra-typings";

const readVersion = (): string => {
  const manifest: unknown = createRequire(import.meta.url)("../package.json");
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
  ) {
    return manifest.version;
  }
  throw new Error("The package version is missing");
};

/** Creates the `aitw` command line program. */
export const createProgram = () =>
  new Command()
    .name("aitw")
    .description("Run workflows that combine AI, people, and scripts")
    .version(readVersion());
