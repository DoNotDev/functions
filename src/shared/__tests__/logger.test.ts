import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Regression: Supabase Edge Runtime defines `window` (= globalThis) but no
 * `document`. A module-level `'window' in globalThis` guard made the logger
 * throw on import, failing every Supabase edge function with WORKER_ERROR.
 */
describe('logger on a runtime that defines window (Supabase Edge shape)', () => {
  const g = globalThis as Record<string, unknown>;

  afterEach(() => {
    delete g.window;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('imports and logs when window is defined and document is not', async () => {
    g.window = globalThis;
    expect(typeof (globalThis as { document?: unknown }).document).toBe(
      'undefined'
    );
    vi.resetModules();

    const { logger } = await import('../logger');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.error('edge boot ok');

    expect(spy).toHaveBeenCalled();
  });
});
