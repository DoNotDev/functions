import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { isFirestoreConfigured } from '../utils/detectFirestore';

describe('isFirestoreConfigured', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all relevant env vars
    delete process.env.FUNCTION_NAME;
    delete process.env.FIREBASE_CONFIG;
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  it('returns true when FUNCTION_NAME is set (Firebase Functions runtime)', () => {
    process.env.FUNCTION_NAME = 'myFunction';

    expect(isFirestoreConfigured()).toBe(true);
  });

  it('returns true when FIREBASE_CONFIG is set', () => {
    process.env.FIREBASE_CONFIG = '{"projectId":"test"}';

    expect(isFirestoreConfigured()).toBe(true);
  });

  it('returns true when all manual credentials are set', () => {
    process.env.FIREBASE_PROJECT_ID = 'my-project';
    process.env.FIREBASE_CLIENT_EMAIL = 'sa@project.iam.gserviceaccount.com';
    process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\n...';

    expect(isFirestoreConfigured()).toBe(true);
  });

  it('returns false when only partial credentials are set', () => {
    process.env.FIREBASE_PROJECT_ID = 'my-project';
    // Missing CLIENT_EMAIL and PRIVATE_KEY

    expect(isFirestoreConfigured()).toBe(false);
  });

  it('returns false when no env vars are set', () => {
    expect(isFirestoreConfigured()).toBe(false);
  });
});
