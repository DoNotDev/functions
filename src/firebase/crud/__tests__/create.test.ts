// packages/functions/src/firebase/crud/__tests__/create.test.ts

/**
 * @fileoverview Unit tests for the Firestore create logic: status rule
 * (`DEFAULT_STATUS_VALUE`, `writeSchemaFor`) and parse-output writes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('firebase-functions/v2', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

/** Last document added to the mock Firestore. */
let added: Record<string, unknown> = {};
const add = vi.fn(async (data: Record<string, unknown>) => {
  added = data;
  return { get: async () => ({ id: 'n1', data: () => added }) };
});
const mockDb = { collection: vi.fn(() => ({ add })) };

vi.mock('@donotdev/firebase/server', () => ({
  getFirebaseAdminFirestore: () => mockDb,
}));

// Import AFTER mocks are in place.
import { createSchemas } from '@donotdev/core/server';

import { createEntityLogicFactory } from '../create';
import { contactEntity } from '@dndev/test-entities';

const schemas = createSchemas(contactEntity);

const logic = createEntityLogicFactory('contacts', schemas.create as never, schemas.draft as never);
const context = { uid: 'u1', userRole: 'user', request: {} } as never;
const run = (payload: Record<string, unknown>) => logic({ payload }, context);

describe('createEntity status rule and writes', () => {
  beforeEach(() => {
    add.mockClear();
  });

  it('a create without status is published (DEFAULT_STATUS_VALUE) and validated as a create', async () => {
    await expect(run({ phone: '+33 6 12 34 56 78' })).rejects.toMatchObject({ code: 'invalid-argument' });
    await run({ name: 'Ana' });
    expect(added.status).toBe('available');
  });

  it('a draft is validated with the draft schema: required may be empty, filled values keep their format', async () => {
    await run({ status: 'draft', name: null });
    expect(added.status).toBe('draft');
    await expect(run({ status: 'draft', phone: 'TOTO' })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('writes the parse output: unknown, hidden and generated keys never reach the DB', async () => {
    await run({ name: 'Ana', secret: 's', role: 'admin', createdById: 'evil', id: 'x' });
    expect(added).not.toHaveProperty('secret');
    expect(added).not.toHaveProperty('role');
    expect(added).not.toHaveProperty('id');
    // createdById comes from the server metadata only
    expect(added.createdById).toBe('u1');
    expect(added.name).toBe('Ana');
  });
});
