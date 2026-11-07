#!/usr/bin/env node
import { configureLogging } from "@aitw/engine";

import { createProgram } from "./program.js";

// The CLI reports failures itself, so Worker warnings would only repeat them.
configureLogging("ERROR");

await createProgram().parseAsync();
