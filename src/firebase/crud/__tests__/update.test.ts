// packages/functions/src/firebase/crud/__tests__/update.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('firebase-functions/v2', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

/** Stored document of the mock Firestore (one collection, one document). */
let stored: Record<string, unknown> = {};
const update = vi.fn(async (data: Record<string, unknown>) => {
  stored = { ...stored, ...data };
});
const docRef = {
  get: vi.fn(async () => ({ exists: true, id: 'c1', data: () => stored })),
  update,
};
const mockDb = { collection: vi.fn(() => ({ doc: () => docRef })) };

vi.mock('@donotdev/firebase/server', () => ({
  getFirebaseAdminFirestore: () => mockDb,
}));

// Import AFTER mocks are in place.
import { createSchemas } from '@donotdev/core/server';

import { updateEntityLogicFactory } from '../update';
import { contactEntity } from '@dndev/test-entities';

const schemas = createSchemas(contactEntity);

const logic = updateEntityLogicFactory('contacts', schemas.update as never, schemas.draft as never);
const context = { uid: 'u1', userRole: 'user', request: {} } as never;
const run = (payload: Record<string, unknown>) => logic({ id: 'c1', payload }, context);

describe('updateEntity validation (same rules as the client)', () => {
  beforeEach(() => {
    update.mockClear();
  });

  it('non-draft: checks what the update writes against the update schema', async () => {
    // Legacy document with a required field empty: an update of another field passes
    stored = { name: null, status: 'available' };
    await expect(run({ phone: '+33 6 12 34 56 78' })).resolves.toBeDefined();
    await expect(run({ name: null })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(run({ name: '' })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(run({ phone: 'TOTO' })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('draft: required fields may be empty, filled ones keep their format', async () => {
    stored = { name: 'Ana', status: 'draft' };
    await expect(run({ name: null })).resolves.toBeDefined();
    await expect(run({ phone: 'TOTO' })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('writes the parse output of the sent keys, never the raw payload', async () => {
    stored = { name: 'Ana', status: 'available' };
    await run({ phone: '+33 6 12 34 56 78', createdById: 'evil', role: 'admin' });
    const written = update.mock.calls[0]![0];
    expect(written).toMatchObject({ phone: '+33 6 12 34 56 78' });
    expect(written).not.toHaveProperty('role');
    expect(written.createdById).toBeUndefined();
    expect(written).not.toHaveProperty('name');
  });

  it('status rule: the sent status wins over the stored one (writeSchemaFor)', async () => {
    // Publishing a draft: the patch is checked against the update schema
    stored = { name: null, status: 'draft' };
    await expect(run({ status: 'available', name: '' })).rejects.toMatchObject({ code: 'invalid-argument' });
    // Back to draft from a published document: the merged document against the draft schema
    stored = { name: 'Ana', status: 'available' };
    await expect(run({ status: 'draft', name: null })).resolves.toBeDefined();
  });

  it('publishing a draft through a status-only patch checks the whole merged document', async () => {
    update.mockClear();
    // Stored null required field
    stored = { name: null, status: 'draft' };
    await expect(run({ status: 'available' })).rejects.toMatchObject({ code: 'invalid-argument' });
    // Required key absent from the stored document (counted as null)
    stored = { status: 'draft' };
    await expect(run({ status: 'available' })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(update).not.toHaveBeenCalled();
    // Filled in: published; only the sent keys are written
    stored = { name: 'Ana', status: 'draft' };
    await expect(run({ status: 'available' })).resolves.toBeDefined();
    const written = update.mock.calls[0]![0];
    expect(written.status).toBe('available');
    expect(written).not.toHaveProperty('name');
  });

  it('soft-deleting a draft stays relaxed (deleted is hidden)', async () => {
    stored = { name: null, status: 'draft' };
    await expect(run({ status: 'deleted' })).resolves.toBeDefined();
  });
});
