#!/usr/bin/env node
import { createProgram } from "./program.js";
import { UnsafeDirectoryError } from "./private-directory.js";

try {
  await createProgram().parseAsync();
} catch (error) {
  // A directory that others can use is a problem of the setup, not a bug of aitw.
  if (!(error instanceof UnsafeDirectoryError)) {
    throw error;
  }
  process.stderr.write(`aitw: ${error.message}\n`);
  process.exitCode = 1;
}
