// packages/functions/src/shared/utils/vercelHelpers.ts

/**
 * @fileoverview DRY helpers for Vercel API functions with schema validation
 * @description Provides reusable patterns for Vercel API routes
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import {
  withVercelSchemaValidation,
  validateRequestData,
} from './schemaValidation.js';

import type { NextApiRequest, NextApiResponse } from 'next';
import type * as v from 'valibot';

/**
 * Creates a Vercel API handler with schema validation
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createVercelHandler<TRequest, TResponse>(
  defaultSchema: v.BaseSchema<unknown, TRequest, v.BaseIssue<unknown>>,
  handler: (
    req: NextApiRequest,
    res: NextApiResponse,
    validatedData: TRequest
  ) => Promise<TResponse>
) {
  return withVercelSchemaValidation(defaultSchema, handler);
}

/**
 * Creates a Vercel API handler with method validation and schema validation
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createVercelApiHandler<TRequest, TResponse>(
  method: string,
  defaultSchema: v.BaseSchema<unknown, TRequest, v.BaseIssue<unknown>>,
  handler: (
    req: NextApiRequest,
    res: NextApiResponse,
    validatedData: TRequest
  ) => Promise<TResponse>
) {
  return async (
    req: NextApiRequest,
    res: NextApiResponse,
    customSchema?: v.BaseSchema<unknown, TRequest, v.BaseIssue<unknown>>
  ): Promise<TResponse> => {
    if (req.method !== method) {
      return res.status(405).json({ error: 'Method not allowed' }) as TResponse;
    }

    const validation = validateRequestData(
      req.body,
      defaultSchema,
      customSchema
    );

    if (!validation.success) {
      return res.status(400).json({
        error: validation.error,
      }) as TResponse;
    }

    return await handler(req, res, validation.data as TRequest);
  };
}
