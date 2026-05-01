// packages/functions/src/shared/utils/functionWrapper.ts

/**
 * @fileoverview Simple DRY wrapper for functions with schema validation
 * @description Eliminates duplication by providing a clean pattern for all functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import type { CallableRequest } from 'firebase-functions/v2/https';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Simple wrapper that validates data against schema and calls the handler
 * This is the ONLY pattern needed for all functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function withValidation<TData, TResponse>(
  schema: v.BaseSchema<unknown, TData, v.BaseIssue<unknown>>,
  handler: (data: TData) => Promise<TResponse>
) {
  return async (data: any): Promise<TResponse> => {
    // Schema handles ALL validation - no manual checks needed
    const validatedData = v.parse(schema, data);
    return await handler(validatedData);
  };
}

/**
 * Firebase function wrapper
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function firebaseFunction<TData, TResponse>(
  schema: v.BaseSchema<unknown, TData, v.BaseIssue<unknown>>,
  handler: (data: TData) => Promise<TResponse>
) {
  return async (request: CallableRequest<TData>): Promise<TResponse> => {
    return await withValidation(schema, handler)(request.data as any);
  };
}

/**
 * Vercel function wrapper
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function vercelFunction<TData, TResponse>(
  schema: v.BaseSchema<unknown, TData, v.BaseIssue<unknown>>,
  handler: (
    req: NextApiRequest,
    res: NextApiResponse,
    data: TData
  ) => Promise<TResponse>
) {
  return async (
    req: NextApiRequest,
    res: NextApiResponse
  ): Promise<TResponse> => {
    const validatedData = v.parse(schema, req.body);
    return await handler(req, res, validatedData);
  };
}
