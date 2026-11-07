import { packageName as adapterScriptLocal } from "@aitw/adapter-script-local";
import { packageName as core } from "@aitw/core";
import { packageName as definition } from "@aitw/definition";
import { packageName as engine } from "@aitw/engine";

/** Names of the workspace packages that the CLI composes. */
export const workspacePackages = [core, definition, engine, adapterScriptLocal];

export { createProgram } from "./program.js";
