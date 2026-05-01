// packages/functions/src/shared/utils/external/date.ts

/**
 * @fileoverview Date utility functions for functions package
 * @description Self-contained date conversion utilities for server-side functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { Timestamp } from '@donotdev/firebase/server';

/**
 * Represents a date value in various formats accepted by Firebase.
 * Can be a JavaScript Date, a Firestore Timestamp, or an ISO 8601 string.
 */
export type DateValue = Date | FirestoreTimestamp | string;

/**
 * Interface mimicking Firebase Timestamp for type compatibility
 */
export interface FirestoreTimestamp {
  seconds: number;
  nanoseconds: number;
  toDate(): Date;
  toMillis(): number;
  isEqual(other: FirestoreTimestamp): boolean;
  valueOf(): string;
}

/**
 * Converts various date formats to ISO string
 * Handles Date, FirestoreTimestamp, and string inputs
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function toISOString(date: DateValue): string {
  if (date instanceof Date) {
    return date.toISOString();
  }
  if (typeof date === 'object' && date !== null && 'toDate' in date) {
    const timestamp = date as any;
    if (typeof timestamp.toDate === 'function') {
      return timestamp.toDate().toISOString();
    }
  }

  // Handle string dates
  if (typeof date === 'string') {
    const parsed = new Date(date);
    if (isNaN(parsed.getTime())) {
      throw new Error('Invalid date format');
    }
    return parsed.toISOString();
  }

  // Fallback for any other type
  const parsed = new Date(date as any);
  if (isNaN(parsed.getTime())) {
    throw new Error('Invalid date format');
  }

  return parsed.toISOString();
}

/**
 * Add months to a date with proper edge case handling
 * Fixes issues like Jan 31 + 1 month = March 3 (should be Feb 28/29)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const originalDate = result.getDate();

  result.setMonth(result.getMonth() + months);

  if (result.getDate() !== originalDate) {
    result.setDate(0);
  }

  return result;
}

/**
 * Add years to a date with proper edge case handling
 * Fixes issues like Feb 29 + 1 year in non-leap year
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
function addYears(date: Date, years: number): Date {
  const result = new Date(date);
  const originalDate = result.getDate();

  result.setFullYear(result.getFullYear() + years);

  if (result.getDate() !== originalDate) {
    result.setDate(0);
  }

  return result;
}

/**
 * Calculate subscription end date with proper edge case handling
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 * @param duration - Duration string (e.g., '1month', '3months', '1year', 'lifetime')
 * @param startDate - Start date (defaults to now)
 * @returns ISO string of end date (required for Firestore compatibility)
 */
export function calculateSubscriptionEndDate(
  duration: string,
  startDate: Date = new Date()
): string {
  if (duration === 'lifetime') {
    return '2099-12-31T23:59:59.000Z';
  }

  let endDate: Date;

  if (duration === '1month') {
    endDate = addMonths(startDate, 1);
  } else if (duration === '3months') {
    endDate = addMonths(startDate, 3);
  } else if (duration === '6months') {
    endDate = addMonths(startDate, 6);
  } else if (duration === '1year') {
    endDate = addYears(startDate, 1);
  } else if (duration === '2years') {
    endDate = addYears(startDate, 2);
  } else {
    endDate = addMonths(startDate, 1);
  }

  return endDate.toISOString();
}
