// packages/functions/vitest.config.ts

import { resolve } from 'path';
import { fileURLToPath } from 'url';

import { defineConfig } from 'vitest/config';

import { sharedAliases } from '../../vitest.shared';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(__dirname, '../..');

export default defineConfig({
  resolve: {
    alias: {
      // Server subpath aliases (must be before base aliases to match first)
      '@donotdev/utils/server': resolve(
        root,
        'packages/core/utils/src/server/index.ts'
      ),
      '@donotdev/core/server': resolve(root, 'packages/core/server.ts'),
      '@donotdev/firebase/server': resolve(
        root,
        'packages/providers/firebase/src/server/index.ts'
      ),
      ...sharedAliases,
    },
    extensions: ['.ts', '.js', '.mjs'],
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/lib/**'],
  },
});
