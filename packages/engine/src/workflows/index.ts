/** Verifies that a Worker can bundle and execute a Workflow. */
export async function smokeWorkflow(name: string): Promise<string> {
  return `Hello, ${name}!`;
}
