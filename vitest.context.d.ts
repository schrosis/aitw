/** Path of an executable file. */
export type ExecutablePath = string;

declare module "vitest" {
  interface ProvidedContext {
    /** Path of the Temporal CLI that tests start servers with. Provided by vitest.global-setup.ts. */
    temporalCli: ExecutablePath;
  }
}
