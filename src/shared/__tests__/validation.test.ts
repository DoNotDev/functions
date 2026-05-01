import { describe, it, expect, vi } from 'vitest';

// Mock firebase-functions/v2 logger
vi.mock('firebase-functions/v2', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  },
}));

import {
  validateGitHubUsername,
  validateEmail,
  validateStripePriceId,
  validateStripeSessionId,
  validateUrl,
  validateMetadata,
} from '../utils/validation';

describe('validateGitHubUsername', () => {
  it('accepts valid usernames', () => {
    expect(validateGitHubUsername('octocat')).toBe(true);
    expect(validateGitHubUsername('user-name')).toBe(true);
    expect(validateGitHubUsername('a')).toBe(true);
    expect(validateGitHubUsername('user123')).toBe(true);
  });

  it('rejects invalid usernames', () => {
    expect(validateGitHubUsername('')).toBe(false);
    expect(validateGitHubUsername('-leadingdash')).toBe(false);
    expect(validateGitHubUsername('has spaces')).toBe(false);
    expect(validateGitHubUsername('special@char')).toBe(false);
  });

  it('rejects username exceeding 39 characters', () => {
    const longName = 'a'.repeat(40);
    expect(validateGitHubUsername(longName)).toBe(false);
  });

  it('accepts username at max 39 characters', () => {
    const maxName = 'a'.repeat(39);
    expect(validateGitHubUsername(maxName)).toBe(true);
  });
});

describe('validateEmail', () => {
  it('accepts valid emails', () => {
    expect(validateEmail('user@example.com')).toBe(true);
    expect(validateEmail('name+tag@domain.co')).toBe(true);
    expect(validateEmail('a@b.c')).toBe(true);
  });

  it('rejects invalid emails', () => {
    expect(validateEmail('')).toBe(false);
    expect(validateEmail('noemail')).toBe(false);
    expect(validateEmail('@missing.local')).toBe(false);
    expect(validateEmail('missing@')).toBe(false);
    expect(validateEmail('has space@test.com')).toBe(false);
  });
});

describe('validateStripePriceId', () => {
  it('accepts valid price IDs', () => {
    expect(validateStripePriceId('price_1234567890')).toBe(true);
    expect(validateStripePriceId('price_abc')).toBe(true);
  });

  it('rejects invalid price IDs', () => {
    expect(validateStripePriceId('price_')).toBe(false);
    expect(validateStripePriceId('prod_123')).toBe(false);
    expect(validateStripePriceId('')).toBe(false);
    expect(validateStripePriceId('123')).toBe(false);
  });
});

describe('validateStripeSessionId', () => {
  it('accepts valid session IDs', () => {
    expect(validateStripeSessionId('cs_test_abc123')).toBe(true);
    expect(validateStripeSessionId('cs_live_xyz')).toBe(true);
  });

  it('rejects invalid session IDs', () => {
    expect(validateStripeSessionId('cs_')).toBe(false);
    expect(validateStripeSessionId('sess_123')).toBe(false);
    expect(validateStripeSessionId('')).toBe(false);
  });
});

describe('validateUrl', () => {
  it('accepts valid HTTP/HTTPS URLs', () => {
    expect(validateUrl('https://example.com')).toBe('https://example.com');
    expect(validateUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(validateUrl('https://app.example.com/path?q=1')).toBe(
      'https://app.example.com/path?q=1'
    );
  });

  it('rejects invalid URLs', () => {
    expect(() => validateUrl('not-a-url')).toThrow();
    expect(() => validateUrl('')).toThrow();
  });

  it('rejects non-HTTP protocols', () => {
    expect(() => validateUrl('ftp://example.com')).toThrow('Invalid protocol');
    expect(() => validateUrl('file:///etc/passwd')).toThrow('Invalid protocol');
  });

  it('includes custom name in error message', () => {
    expect(() => validateUrl('bad', 'Success URL')).toThrow(
      'Invalid Success URL'
    );
  });
});

describe('validateMetadata', () => {
  it('passes through valid string metadata', () => {
    const result = validateMetadata({ key: 'value', name: 'test' });

    expect(result).toEqual({ key: 'value', name: 'test' });
  });

  it('rejects non-string values', () => {
    expect(() => validateMetadata({ key: 123 as any })).toThrow(
      'must be a string'
    );
    expect(() => validateMetadata({ key: true as any })).toThrow(
      'must be a string'
    );
  });

  it('sanitizes script tags', () => {
    const result = validateMetadata({
      xss: '<script>alert("xss")</script>',
    });

    expect(result.xss).not.toContain('<script');
  });

  it('sanitizes javascript: protocol', () => {
    const result = validateMetadata({
      link: 'javascript:alert(1)',
    });

    expect(result.link).not.toContain('javascript:');
  });

  it('sanitizes inline event handlers', () => {
    const result = validateMetadata({
      html: 'onclick=alert(1)',
    });

    expect(result.html).not.toContain('onclick=');
  });

  it('rejects values exceeding 1000 characters', () => {
    const longValue = 'a'.repeat(1001);

    expect(() => validateMetadata({ key: longValue })).toThrow('too long');
  });

  it('rejects keys exceeding 100 characters', () => {
    const longKey = 'k'.repeat(101);

    expect(() => validateMetadata({ [longKey]: 'value' })).toThrow('too long');
  });

  it('handles empty metadata object', () => {
    const result = validateMetadata({});

    expect(result).toEqual({});
  });
});
