import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getUser, setCustomUserClaims, getUserById, updateUserById } = vi.hoisted(() => ({
  getUser: vi.fn(),
  setCustomUserClaims: vi.fn(),
  getUserById: vi.fn(),
  updateUserById: vi.fn(),
}));

vi.mock('@donotdev/firebase/server', () => ({
  getFirebaseAdminAuth: () => ({ getUser, setCustomUserClaims }),
  getFirebaseAdminFirestore: vi.fn(),
}));
vi.mock('../../firebase/baseFunction.js', () => ({
  createBaseFunction: (_config: unknown, _schema: unknown, _name: string, handler: unknown) => handler,
}));
vi.mock('../../supabase/baseFunction.js', () => ({
  createSupabaseHandler: (_name: string, _schema: unknown, handler: unknown) => handler,
}));

import { setCustomClaims } from '../../firebase/auth/setCustomClaims.js';
import { createSetCustomClaims } from '../../supabase/auth/setCustomClaims.js';

// Base wrappers are mocked above to expose only the authenticated business logic.
type Handler = (data: { customClaims: Record<string, unknown> }, context: unknown) => Promise<unknown>;

const subscription = {
  tier: 'member',
  status: 'active',
  subscriptionEnd: null,
  updatedAt: '2026-06-01T00:00:00.000Z',
};
const existingClaims = { subscription, role: 'user', locale: 'en' };

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ customClaims: existingClaims });
  setCustomUserClaims.mockResolvedValue(undefined);
  getUserById.mockResolvedValue({ data: { user: { app_metadata: existingClaims } }, error: null });
  updateUserById.mockResolvedValue({ error: null });
});

for (const provider of ['firebase', 'supabase'] as const) {
  describe(`${provider} self-service custom claims`, () => {
    const create = (allowedClaimKeys: string[]) => provider === 'firebase'
      ? setCustomClaims({ allowedClaimKeys })
      : createSetCustomClaims({ allowedClaimKeys });
    const context = {
      uid: 'user-1',
      supabaseAdmin: { auth: { admin: { getUserById, updateUserById } } },
    };

    it.each(['subscription', 'role', 'tier', 'plan'])(
      'rejects mistakenly allowlisted %s at factory creation',
      (key) => {
        expect(() => create(['locale', key])).toThrow(`Claim key "${key}" is blocked`);
        expect(getUser).not.toHaveBeenCalled();
        expect(getUserById).not.toHaveBeenCalled();
        expect(setCustomUserClaims).not.toHaveBeenCalled();
        expect(updateUserById).not.toHaveBeenCalled();
      }
    );

    it.each([subscription, { ...subscription, tier: 'premium', subscriptionId: 'sub_paid', customerId: 'cus_paid', cancelAtPeriodEnd: false }, null])(
      'rejects subscription assignment or replacement through the request',
      async (value) => {
        const handler = create(['locale']) as unknown as Handler;
        await expect(handler({ customClaims: { subscription: value } }, context))
          .rejects.toThrow('Claim keys not allowed: subscription');
        expect(getUser).not.toHaveBeenCalled();
        expect(getUserById).not.toHaveBeenCalled();
        expect(setCustomUserClaims).not.toHaveBeenCalled();
        expect(updateUserById).not.toHaveBeenCalled();
      }
    );

    it.runIf(provider === 'supabase')('does not replay stale access claims over a concurrent trusted revoke', async () => {
      const handler = create(['locale']) as unknown as Handler;
      const revoked = { ...subscription, tier: 'free', status: 'canceled' };
      const stored = { ...existingClaims, subscription: revoked };
      // getUserById returns the earlier snapshot; the server has since revoked access.
      updateUserById.mockImplementation(async (_uid, { app_metadata }) => {
        Object.assign(stored, app_metadata);
        return { error: null };
      });
      await handler({ customClaims: { locale: 'fr' } }, context);
      expect(stored).toEqual({ ...existingClaims, subscription: revoked, locale: 'fr' });
    });

    it('preserves canonical subscription and unrelated claims when updating an allowed key', async () => {
      const handler = create(['locale']) as unknown as Handler;
      const updatedClaims = { ...existingClaims, locale: 'fr' };
      await expect(handler({ customClaims: { locale: 'fr' } }, context))
        .resolves.toEqual({ success: true, customClaims: updatedClaims });
      if (provider === 'firebase') {
        expect(setCustomUserClaims).toHaveBeenCalledWith('user-1', updatedClaims);
      } else {
        expect(updateUserById).toHaveBeenCalledWith('user-1', { app_metadata: { locale: 'fr' } });
      }
      expect(existingClaims.subscription).toEqual(subscription);
    });
  });
}
