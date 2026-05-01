// packages/functions/src/shared/utils/firebaseHelpers.ts

/**
 * @fileoverview DRY helpers for Firebase functions with schema validation
 * @description Provides reusable patterns for Firebase onCall functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { onCall } from 'firebase-functions/v2/https';

import { withSchemaValidation } from './schemaValidation.js';

import type { CallableRequest } from 'firebase-functions/v2/https';
import type * as v from 'valibot';

/**
 * Creates a Firebase onCall function with schema validation
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createFirebaseCallable<TRequest, TResponse>(
  config: any,
  defaultSchema: v.BaseSchema<unknown, TRequest, v.BaseIssue<unknown>>,
  handler: (
    request: CallableRequest<TRequest>,
    validatedData: TRequest
  ) => Promise<TResponse>
) {
  const internalHandler = withSchemaValidation(defaultSchema, handler);

  return {
    // Standard onCall function
    onCall: onCall(config, async (request: CallableRequest<TRequest>) => {
      return await internalHandler(request);
    }),

    // Custom schema function
    withSchema: async (
      request: CallableRequest<TRequest>,
      customSchema: v.BaseSchema<unknown, TRequest, v.BaseIssue<unknown>>
    ) => {
      return await internalHandler(request, customSchema);
    },
  };
}

/**
 * Creates both onCall and withSchema exports for a Firebase function
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createFirebaseFunctionExports<TRequest, TResponse>(
  config: any,
  defaultSchema: v.BaseSchema<unknown, TRequest, v.BaseIssue<unknown>>,
  handler: (
    request: CallableRequest<TRequest>,
    validatedData: TRequest
  ) => Promise<TResponse>
) {
  const { onCall: onCallFunction, withSchema } = createFirebaseCallable(
    config,
    defaultSchema,
    handler
  );

  return {
    // Main export (onCall)
    [handler.name || 'mainFunction']: onCallFunction,

    // Custom schema export
    [`${handler.name || 'mainFunction'}WithSchema`]: withSchema,
  };
}
