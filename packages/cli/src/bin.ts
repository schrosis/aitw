#!/usr/bin/env node
import { configureRuntime } from "@aitw/engine";

import { createProgram } from "./program.js";

// The CLI reports failures and handles SIGINT itself.
configureRuntime({ logLevel: "ERROR" });

await createProgram().parseAsync();
