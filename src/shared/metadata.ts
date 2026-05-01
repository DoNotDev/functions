// packages/functions/src/shared/metadata.ts

/**
 * @fileoverview Document metadata utilities for functions
 * @description Server-safe metadata creation and update utilities
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

/**
 * Creates metadata for a new document.
 * @param userId - The ID of the user creating the document
 * @returns An object with creation and update timestamps and user IDs
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createMetadata(userId: string) {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    updatedAt: now,
    createdById: userId,
    updatedById: userId,
  };
}

/**
 * Creates update metadata for an existing document.
 * @param userId - The ID of the user updating the document
 * @returns An object with update timestamp and user ID
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function updateMetadata(userId: string) {
  return {
    updatedAt: new Date().toISOString(),
    updatedById: userId,
  };
}
