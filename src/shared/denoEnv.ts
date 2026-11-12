// packages/functions/src/shared/denoEnv.ts

/**
 * @fileoverview Typed access to the Deno env from cross-runtime code
 * @description Supabase Edge Functions run on Deno, Firebase/Vercel on Node.
 * This package compiles against the Node lib types, which have no `Deno`
 * global. Internal: not re-exported from any package entry.
 *
 * @version 0.1.0
 * @since 0.2.2
 * @author AMBROISE PARK Consulting
 */

/** The part of the Deno namespace read by this package. */
interface DenoEnvNamespace {
  env?: { get(key: string): string | undefined };
}

/**
 * Deno env accessor, when running on Deno.
 *
 * @version 0.1.0
 * @since 0.2.2
 * @author AMBROISE PARK Consulting
 */
export function getDenoEnv(): DenoEnvNamespace['env'] {
  // why: the Deno global is absent from the Node lib types this package compiles against
  return (globalThis as { Deno?: DenoEnvNamespace }).Deno?.env;
}
