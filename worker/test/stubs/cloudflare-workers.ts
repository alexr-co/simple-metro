/* Minimal stand-in for the 'cloudflare:workers' module so unit tests can
   import worker/src/index.ts outside the workerd runtime. Tests only exercise
   the pure functions; the DurableObject base class is never instantiated. */
export class DurableObject<Env = unknown> {
  protected ctx!: unknown;
  protected env!: Env;
}
