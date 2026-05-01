// packages/functions/src/shared/utils/__tests__/functionWrapper.test.ts

/**
 * @fileoverview Tests for withValidation, firebaseFunction, vercelFunction
 * @description Unit tests for schema validation wrappers.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  withValidation,
  firebaseFunction,
  vercelFunction,
} from '../functionWrapper';

// ---------------------------------------------------------------------------
// Schemas and fixtures
// ---------------------------------------------------------------------------

const TestSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  count: v.optional(v.pipe(v.number(), v.minValue(0))),
});

type TestData = v.InferOutput<typeof TestSchema>;

// ---------------------------------------------------------------------------
// withValidation
// ---------------------------------------------------------------------------

describe('withValidation', () => {
  it('returns handler result when data is valid', async () => {
    const handler = vi.fn().mockResolvedValue({ id: '123' });
    const wrapped = withValidation(TestSchema, handler);
    const data = { name: 'foo', count: 2 };

    const result = await wrapped(data);

    expect(result).toEqual({ id: '123' });
    expect(handler).toHaveBeenCalledWith({ name: 'foo', count: 2 });
  });

  it('throws when data fails validation', async () => {
    const handler = vi.fn();
    const wrapped = withValidation(TestSchema, handler);

    await expect(wrapped({ name: '' })).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes validated (parsed) data to handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const wrapped = withValidation(TestSchema, handler);
    await wrapped({ name: 'a', count: 0 });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'a', count: 0 })
    );
  });
});

// ---------------------------------------------------------------------------
// firebaseFunction
// ---------------------------------------------------------------------------

describe('firebaseFunction', () => {
  it('calls handler with parsed request.data', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true });
    const fn = firebaseFunction(TestSchema, handler);
    const request = {
      data: { name: 'test', count: 1 },
      rawRequest: {} as any,
    };

    const result = await fn(request);

    expect(result).toEqual({ success: true });
    expect(handler).toHaveBeenCalledWith({ name: 'test', count: 1 });
  });

  it('throws when request.data is invalid', async () => {
    const handler = vi.fn();
    const fn = firebaseFunction(TestSchema, handler);
    const request = { data: { name: '' }, rawRequest: {} as any };

    await expect(fn(request)).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// vercelFunction
// ---------------------------------------------------------------------------

describe('vercelFunction', () => {
  it('parses req.body and calls handler with (req, res, data)', async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const fn = vercelFunction(TestSchema, handler);
    const req = { body: { name: 'v', count: 0 } } as any;
    const res = {} as any;

    const result = await fn(req, res);

    expect(result).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledWith(req, res, { name: 'v', count: 0 });
  });

  it('throws when req.body is invalid', async () => {
    const handler = vi.fn();
    const fn = vercelFunction(TestSchema, handler);
    const req = { body: {} } as any;
    const res = {} as any;

    await expect(fn(req, res)).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});
