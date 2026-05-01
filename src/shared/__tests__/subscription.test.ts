import { describe, it, expect, vi } from 'vitest';

// Mock Firebase deps (only getTierFromPriceId is pure)
vi.mock('@donotdev/firebase/server', () => ({
  getFirebaseAdminAuth: vi.fn(),
  getFirebaseAdminFirestore: vi.fn(),
}));
vi.mock('@donotdev/core/server', () => ({
  SUBSCRIPTION_STATUS: {
    ACTIVE: 'active',
    CANCELED: 'canceled',
    INCOMPLETE: 'incomplete',
    PAST_DUE: 'past_due',
    TRIALING: 'trialing',
    UNPAID: 'unpaid',
  },
}));

import { getTierFromPriceId } from '../utils/external/subscription';

describe('getTierFromPriceId', () => {
  it('maps monthly pro price to "pro"', () => {
    expect(getTierFromPriceId('price_pro_monthly')).toBe('pro');
  });

  it('maps yearly pro price to "pro"', () => {
    expect(getTierFromPriceId('price_pro_yearly')).toBe('pro');
  });

  it('maps monthly ai price to "ai"', () => {
    expect(getTierFromPriceId('price_ai_monthly')).toBe('ai');
  });

  it('maps yearly ai price to "ai"', () => {
    expect(getTierFromPriceId('price_ai_yearly')).toBe('ai');
  });

  it('returns "free" for unknown price ID', () => {
    expect(getTierFromPriceId('price_unknown_123')).toBe('free');
  });

  it('returns "free" for empty string', () => {
    expect(getTierFromPriceId('')).toBe('free');
  });
});
