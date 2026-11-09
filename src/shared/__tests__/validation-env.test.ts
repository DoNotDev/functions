import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { validateEnvironment } from '../validation';

describe('validateEnvironment', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_API_VERSION;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws listing all missing env vars', () => {
    expect(() => validateEnvironment()).toThrow(
      'Missing required environment variables'
    );
    expect(() => validateEnvironment()).toThrow('STRIPE_SECRET_KEY');
    expect(() => validateEnvironment()).toThrow('STRIPE_WEBHOOK_SECRET');
    expect(() => validateEnvironment()).toThrow('STRIPE_API_VERSION');
  });

  it('throws for missing single env var', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_abc';

    expect(() => validateEnvironment()).toThrow('STRIPE_API_VERSION');
  });

  it('throws for invalid STRIPE_API_VERSION format', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_abc';
    process.env.STRIPE_API_VERSION = 'bad-format';

    expect(() => validateEnvironment()).toThrow(
      'Invalid STRIPE_API_VERSION format'
    );
  });

  it('throws for invalid STRIPE_SECRET_KEY format', () => {
    process.env.STRIPE_SECRET_KEY = 'pk_test_abc';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_abc';
    process.env.STRIPE_API_VERSION = '2025-09-30.clover';

    expect(() => validateEnvironment()).toThrow(
      'Invalid STRIPE_SECRET_KEY format'
    );
  });

  it('passes with all valid env vars', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_abc';
    process.env.STRIPE_API_VERSION = '2025-09-30.clover';

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => validateEnvironment()).not.toThrow();

    consoleSpy.mockRestore();
  });

  it('accepts various valid API version formats', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_abc';
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    process.env.STRIPE_API_VERSION = '2024-12-18.acacia';
    expect(() => validateEnvironment()).not.toThrow();

    process.env.STRIPE_API_VERSION = '2025-09-30.clover';
    expect(() => validateEnvironment()).not.toThrow();

    consoleSpy.mockRestore();
  });
});
