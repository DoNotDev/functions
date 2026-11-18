import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getUser, setCustomUserClaims, getUserById, updateUserById } = vi.hoisted(() => ({
  getUser: vi.fn(),
  setCustomUserClaims: vi.fn(),
  getUserById: vi.fn(),
  updateUserById: vi.fn(),
}));

vi.mock('@donotdev/firebase/server', () => ({
  getFirebaseAdminAuth: () => ({ getUser, setCustomUserClaims }),
}));
vi.mock('../../firebase/baseFunction.js', () => ({
  createBaseFunction: (_config: unknown, _schema: unknown, _name: string, handler: unknown) => handler,
}));
vi.mock('../../supabase/baseFunction.js', () => ({
  createSupabaseHandler: (_name: string, _schema: unknown, handler: unknown) => handler,
}));

import { removeCustomClaims } from '../../firebase/auth/removeCustomClaims.js';
import { createRemoveCustomClaims } from '../../supabase/auth/removeCustomClaims.js';

// Base wrappers are mocked to expose only the authenticated business logic.
type Handler = (data: { claimsToRemove: string[] }, context: unknown) => Promise<unknown>;

const subscription = {
  tier: 'member',
  status: 'active',
  subscriptionEnd: null,
  updatedAt: '2026-06-01T00:00:00.000Z',
};
const paidSubscription = {
  ...subscription,
  tier: 'premium',
  subscriptionId: 'sub_paid',
  customerId: 'cus_paid',
  cancelAtPeriodEnd: false,
};
const existingClaims = { subscription, role: 'user', locale: 'en', theme: 'dark' };
const protectedKeys = [
  'admin', 'isAdmin', 'isSuper', 'isSuperAdmin', 'role', 'roles',
  'permissions', 'superuser', 'moderator', 'staff', 'elevated',
  'plan', 'tier', 'subscription', 'provider', 'providers', 'sub', 'iss', 'aud',
];

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ customClaims: existingClaims });
  setCustomUserClaims.mockResolvedValue(undefined);
  getUserById.mockResolvedValue({ data: { user: { app_metadata: existingClaims } }, error: null });
  updateUserById.mockResolvedValue({ error: null });
});

for (const provider of ['firebase', 'supabase'] as const) {
  describe(`${provider} self-service claim removal`, () => {
    const create = () => (provider === 'firebase'
      ? removeCustomClaims()
      : createRemoveCustomClaims()) as unknown as Handler;
    const context = {
      uid: 'user-1',
      supabaseAdmin: { auth: { admin: { getUserById, updateUserById } } },
    };

    it.each(protectedKeys)('rejects protected %s removal before accessing the provider', async (key) => {
      await expect(create()({ claimsToRemove: ['locale', key] }, context))
        .rejects.toThrow(`Protected claims cannot be removed: ${key}`);
      expect(getUser).not.toHaveBeenCalled();
      expect(getUserById).not.toHaveBeenCalled();
      expect(setCustomUserClaims).not.toHaveBeenCalled();
      expect(updateUserById).not.toHaveBeenCalled();
      expect(existingClaims.locale).toBe('en');
    });

    it.each([subscription, paidSubscription])(
      'preserves canonical subscription and unrelated metadata when removing safe keys',
      async (canonicalSubscription) => {
        const claims = { ...existingClaims, subscription: canonicalSubscription };
        getUser.mockResolvedValue({ customClaims: claims });
        getUserById.mockResolvedValue({ data: { user: { app_metadata: claims } }, error: null });
        const updatedClaims = { subscription: canonicalSubscription, role: 'user' };

        await expect(create()({ claimsToRemove: ['locale', 'theme', 'missing'] }, context))
          .resolves.toEqual({ success: true, customClaims: updatedClaims });
        if (provider === 'firebase') {
          expect(setCustomUserClaims).toHaveBeenCalledExactlyOnceWith('user-1', updatedClaims);
        } else {
          expect(updateUserById).toHaveBeenCalledExactlyOnceWith('user-1', {
            app_metadata: { locale: null, theme: null, missing: null },
          });
        }
        expect(claims).toEqual({ ...existingClaims, subscription: canonicalSubscription });
      }
    );

    it.runIf(provider === 'supabase')('actually deletes safe keys without replaying a stale subscription', async () => {
      const revoked = { ...subscription, tier: 'free', status: 'canceled' };
      const stored: Record<string, unknown> = { ...existingClaims, subscription: revoked };
      // Mirror Supabase Auth UpdateAppMetaData: merge values, delete null keys.
      updateUserById.mockImplementation(async (_uid, { app_metadata }) => {
        for (const [key, value] of Object.entries(app_metadata)) {
          if (value === null) delete stored[key];
          else stored[key] = value;
        }
        return { error: null };
      });
      await create()({ claimsToRemove: ['locale', 'theme'] }, context);
      expect(stored).toEqual({ subscription: revoked, role: 'user' });
    });

    it('keeps safe removal working when the user has no claims', async () => {
      getUser.mockResolvedValue({});
      getUserById.mockResolvedValue({ data: { user: {} }, error: null });
      await expect(create()({ claimsToRemove: ['locale'] }, context))
        .resolves.toEqual({ success: true, customClaims: {} });
    });
  });
}
