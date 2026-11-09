#!/usr/bin/env node
import { createProgram } from "./program.js";
import { StateDirectoryError } from "./state.js";

try {
  await createProgram().parseAsync();
} catch (error) {
  // A state directory that others can use is a problem of the setup, not a bug of aitw.
  if (!(error instanceof StateDirectoryError)) {
    throw error;
  }
  process.stderr.write(`aitw: ${error.message}\n`);
  process.exitCode = 1;
}
