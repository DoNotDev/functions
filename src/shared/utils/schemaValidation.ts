// packages/functions/src/shared/utils/schemaValidation.ts

/**
 * @fileoverview DRY utilities for schema validation across all functions
 * @description Provides reusable patterns for Firebase and Vercel functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import type { CallableRequest } from 'firebase-functions/v2/https';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Validates request data using a schema with custom override support
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validateRequestData<T>(
  data: any,
  defaultSchema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>,
  customSchema?: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>
): { success: true; data: T } | { success: false; error: string } {
  const schema = customSchema || defaultSchema;
  const validationResult = v.safeParse(schema, data);

  if (!validationResult.success) {
    return {
      success: false,
      error: `Validation failed: ${validationResult.issues.map((e) => e.message).join(', ')}`,
    };
  }

  return {
    success: true,
    data: validationResult.output,
  };
}

/**
 * Firebase function wrapper that adds schema validation
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function withSchemaValidation<TRequest, TResponse>(
  defaultSchema: v.BaseSchema<unknown, TRequest, v.BaseIssue<unknown>>,
  handler: (
    request: CallableRequest<TRequest>,
    validatedData: TRequest
  ) => Promise<TResponse>
) {
  return async (
    request: CallableRequest<TRequest>,
    customSchema?: v.BaseSchema<unknown, TRequest, v.BaseIssue<unknown>>
  ): Promise<TResponse> => {
    const validation = validateRequestData(
      request.data,
      defaultSchema,
      customSchema
    );

    if (!validation.success) {
      throw new Error(validation.error);
    }

    return await handler(request, validation.data);
  };
}

/**
 * Vercel function wrapper that adds schema validation
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function withVercelSchemaValidation<TRequest, TResponse>(
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

    return await handler(req, res, validation.data);
  };
}

/**
 * Creates both standard and custom schema versions of a Firebase function
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createFirebaseFunction<TRequest, TResponse>(
  defaultSchema: v.BaseSchema<unknown, TRequest, v.BaseIssue<unknown>>,
  handler: (
    request: CallableRequest<TRequest>,
    validatedData: TRequest
  ) => Promise<TResponse>
) {
  const internalHandler = withSchemaValidation(defaultSchema, handler);

  return {
    // Standard function (no custom schema)
    standard: (request: CallableRequest<TRequest>) => internalHandler(request),

    // Custom schema function
    withSchema: (
      request: CallableRequest<TRequest>,
      customSchema: v.BaseSchema<unknown, TRequest, v.BaseIssue<unknown>>
    ) => internalHandler(request, customSchema),
  };
}

/**
 * Creates a Vercel function with schema validation
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createVercelFunction<TRequest, TResponse>(
  defaultSchema: v.BaseSchema<unknown, TRequest, v.BaseIssue<unknown>>,
  handler: (
    req: NextApiRequest,
    res: NextApiResponse,
    validatedData: TRequest
  ) => Promise<TResponse>
) {
  return withVercelSchemaValidation(defaultSchema, handler);
}
