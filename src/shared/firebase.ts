// packages/functions/src/shared/firebase.ts

/**
 * @fileoverview Firebase data transformation utilities for functions
 * @description Server-safe functions for converting data between Firebase and application formats
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { DateValue, FirestoreTimestamp } from '@donotdev/core/server';

/**
 * Create a server-safe version of the Timestamp creation
 * @param date - The Date object to convert
 * @returns A representation of the timestamp
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createTimestamp(date: Date): FirestoreTimestamp {
  return {
    seconds: Math.floor(date.getTime() / 1000),
    nanoseconds: (date.getTime() % 1000) * 1000000,
    toDate: () => new Date(date),
    toMillis: () => date.getTime(),
    isEqual: (other: FirestoreTimestamp) =>
      other.seconds === Math.floor(date.getTime() / 1000) &&
      other.nanoseconds === (date.getTime() % 1000) * 1000000,
    valueOf: () =>
      `Timestamp(seconds=${Math.floor(date.getTime() / 1000)}, nanoseconds=${(date.getTime() % 1000) * 1000000})`,
  };
}

/**
 * Converts a Date or ISO string to a Firestore Timestamp.
 * @param date - The date to convert (string or Date)
 * @returns The Firestore Timestamp
 * @throws Error if the date is invalid
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function toTimestamp(date: string | Date): FirestoreTimestamp {
  try {
    if (typeof date === 'string') {
      const parsed = new Date(date);
      if (isNaN(parsed.getTime())) {
        throw new Error(`Invalid date string format: ${date}`);
      }
      return createTimestamp(parsed);
    }
    if (date instanceof Date) {
      if (isNaN(date.getTime())) {
        throw new Error('Invalid Date object');
      }
      return createTimestamp(date);
    }
    throw new Error('Date must be a string or Date object');
  } catch (error) {
    throw new Error(
      `Failed to convert to timestamp: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Converts a Firestore Timestamp to an ISO string.
 * @param timestamp - The Firestore Timestamp
 * @returns The ISO string representation
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function toISOString(timestamp: FirestoreTimestamp): string {
  return timestamp.toDate().toISOString();
}

/**
 * Checks if a value is a Firestore Timestamp.
 * @param value - The value to check
 * @returns True if the value is a Timestamp
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function isTimestamp(value: any): value is FirestoreTimestamp {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.seconds === 'number' &&
    typeof value.nanoseconds === 'number' &&
    typeof value.toDate === 'function' &&
    typeof value.toMillis === 'function'
  );
}

/**
 * Recursively transforms Firestore data to application format by converting Timestamps to ISO strings.
 * @param data - The data to transform
 * @param includeDocumentIds - Whether to include document IDs
 * @returns The transformed data
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function transformFirestoreData<T = any>(
  data: T,
  includeDocumentIds: boolean = false
): T {
  if (!data) return data;

  // Handle Firestore document with ID
  if (
    includeDocumentIds &&
    typeof data === 'object' &&
    data !== null &&
    'id' in data &&
    'ref' in data &&
    'data' in data &&
    typeof (data as any).data === 'function'
  ) {
    const doc = data as any;
    const documentData = doc.data();
    return {
      id: doc.id,
      ...transformFirestoreData(documentData),
    } as T;
  }

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map((item) => transformFirestoreData(item)) as unknown as T;
  }

  // Handle Timestamps
  if (isTimestamp(data)) {
    return toISOString(data) as unknown as T;
  }

  // Handle objects recursively
  if (typeof data === 'object' && data !== null) {
    const transformed: Record<string, any> = {};
    for (const [key, value] of Object.entries(data as Record<string, any>)) {
      transformed[key] = transformFirestoreData(value);
    }
    return transformed as T;
  }

  // Return primitive values unchanged
  return data;
}

/**
 * Recursively prepares data for Firestore by converting Date objects to ISO strings.
 * ISO strings are kept as-is (no conversion needed).
 * @param data - The data to prepare
 * @param removeFields - Optional array of field names to remove
 * @returns The prepared data
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function prepareForFirestore<T = any>(
  data: T,
  removeFields: string[] = []
): T {
  if (!data) return data;

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map((item) =>
      prepareForFirestore(item, removeFields)
    ) as unknown as T;
  }

  // Handle objects recursively
  if (typeof data === 'object' && data !== null) {
    const prepared: Record<string, any> = {};
    for (const [key, value] of Object.entries(data as Record<string, any>)) {
      // Skip fields that should be removed
      if (removeFields.includes(key)) {
        continue;
      }

      // Handle Date objects - convert to ISO string
      if (value instanceof Date) {
        prepared[key] = value.toISOString();
      }
      // ISO strings stay as strings - no conversion needed
      // Handle nested objects and arrays
      else {
        prepared[key] = prepareForFirestore(value, removeFields);
      }
    }
    return prepared as T;
  }

  // Handle Date objects at root level - convert to ISO string
  if (data instanceof Date) {
    return data.toISOString() as unknown as T;
  }

  // ISO strings stay as strings - no conversion needed

  // Return primitive values unchanged
  return data;
}
