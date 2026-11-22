// packages/functions/src/supabase/__tests__/firebaseBoundary.test.ts

/**
 * @fileoverview Regression test: the Supabase entry never references Firebase
 * @description A Supabase app does not install `@donotdev/firebase`,
 * `firebase-admin` or `firebase-functions`. The edge bundler (esbuild) resolves
 * every import reachable from `@donotdev/functions/supabase`, a lazy `import()`
 * included, even one that is never called: a single Firebase specifier anywhere
 * in that graph fails every edge function with `Could not resolve
 * "@donotdev/firebase/server"` (shared/utils.ts did this through
 * `verifyFirebaseAuthToken`). Module mocks cannot see an unexecuted `import()`,
 * so this test walks the import graph with esbuild, as the edge bundler does.
 *
 * @version 0.1.0
 * @since 0.3.3
 * @author AMBROISE PARK Consulting
 */

import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const FIREBASE = /^(@donotdev\/firebase|firebase-admin|firebase-functions)(\/|$)/;

describe('supabase entry without firebase', () => {
  it('reaches no Firebase specifier, static or dynamic', async () => {
    const hits: string[] = [];
    await build({
      entryPoints: [fileURLToPath(new URL('../index.ts', import.meta.url))],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      logLevel: 'silent',
      plugins: [
        {
          name: 'record-firebase',
          setup(pluginBuild) {
            // Follow the package's own (relative) modules; record Firebase, keep other packages out
            pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => {
              if (FIREBASE.test(args.path)) {
                hits.push(`${args.path} (${args.kind}) from ${args.importer}`);
              }
              return { path: args.path, external: true };
            });
          },
        },
      ],
    });
    expect(hits).toEqual([]);
  }, 60_000);
});
