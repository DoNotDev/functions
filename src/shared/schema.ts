// packages/functions/src/shared/schema.ts

/**
 * @fileoverview Schema utilities for functions
 * @description Server-safe schema field visibility utilities
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type * as v from 'valibot';

/** Visibility levels matching @donotdev/core */
type Visibility = 'guest' | 'user' | 'admin' | 'technical' | 'hidden' | 'owner';

// Define a type for the custom visibility property we might add to Valibot schemas
interface ValibotSchemaWithVisibility extends v.BaseSchema<
  unknown,
  any,
  v.BaseIssue<unknown>
> {
  visibility?: Visibility;
}

/**
 * Safely extracts the visibility setting from a Valibot field schema.
 * Looks for a custom 'visibility' property on the schema object.
 *
 * @param field - A Valibot schema field (e.g., v.string()).
 * @returns The visibility setting if found, otherwise undefined.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
function getFieldVisibility(field: any): Visibility | undefined {
  // Check if the field has visibility property
  if (field && typeof field === 'object' && 'visibility' in field) {
    return (field as ValibotSchemaWithVisibility).visibility;
  }
  return undefined;
}

/**
 * Determines if a field should be visible based on its visibility setting
 * and the user's authentication/admin status.
 *
 * Visibility levels:
 * - 'guest': Always visible (even to unauthenticated users)
 * - 'user': Visible to authenticated users (users see both guest and user fields)
 * - 'admin': Visible only to admins
 * - 'technical': Visible to admins only (shown as read-only in edit forms)
 * - 'hidden': Never visible (passwords, tokens, API keys - only in DB)
 * - 'owner': Visible only when uid matches one of entity.ownership.ownerFields (requires document context; here treated as not visible for aggregate)
 * - undefined: Defaults to 'user' behavior (visible to authenticated users)
 *
 * @param key - The name (key) of the field.
 * @param visibility - The visibility setting.
 * @param isAdmin - Whether the current user is an admin.
 * @param isAuthenticated - Whether the current user is authenticated (defaults to true for backward compat).
 * @returns True if the field should be visible, false otherwise.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function isFieldVisible(
  key: string,
  visibility: Visibility | undefined,
  isAdmin: boolean,
  isAuthenticated: boolean = true
): boolean {
  // Hidden fields are never exposed
  if (visibility === 'hidden') {
    return false;
  }

  // Guest fields are always visible
  if (visibility === 'guest') {
    return true;
  }

  // Admin fields are visible only to admins
  if (visibility === 'admin') {
    return isAdmin;
  }

  // Technical fields are visible only to admins
  if (visibility === 'technical') {
    return isAdmin;
  }

  // Owner: requires per-document check (documentData, uid, ownership); not available in aggregate context
  if (visibility === 'owner') {
    return false;
  }

  // User fields (or undefined/default) are visible to authenticated users
  if (visibility === 'user' || visibility === undefined) {
    return isAuthenticated;
  }

  // Fallback: hide unknown visibility levels
  return false;
}

/**
 * Extracts the names of all fields from a Valibot object schema that should be visible
 * based on the user's administrative status and the visibility rules defined in the schema.
 *
 * @param schema - The Valibot schema, expected to be an object schema (v.object).
 * @param isAdmin - Whether the current user is an admin.
 * @returns An array of strings, where each string is the name of a visible field.
 * Returns an empty array if the schema is not an object schema or has no entries.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function getVisibleFields(
  schema: any, // Accept any Valibot type, but process only objects
  isAdmin: boolean
): string[] {
  // Valibot object schemas use .entries property
  // Ensure the schema is an object schema and has entries
  if (!schema || typeof schema !== 'object' || !schema.entries) {
    console.warn(
      'getVisibleFields expects a Valibot object schema (v.object).'
    );
    return []; // Return empty array if not an object schema
  }

  // Extract the entries (field definitions) from the schema
  const entries = schema.entries as Record<
    string,
    v.BaseSchema<unknown, any, v.BaseIssue<unknown>>
  >;
  const visibleFieldNames: string[] = [];

  // Iterate over each field defined in the schema's entries
  for (const [key, field] of Object.entries(entries)) {
    // Get the visibility setting for the current field
    const visibility = getFieldVisibility(field);

    // Check if the field is visible based on its key, visibility setting, and admin status
    if (isFieldVisible(key, visibility, isAdmin)) {
      visibleFieldNames.push(key); // Add the field name to the list if visible
    }
  }

  return visibleFieldNames;
}

/**
 * Filters the fields of a data object based on visibility rules defined
 * in a Valibot schema and the user's admin status.
 *
 * @template T - The expected type of the data object.
 * @param {T | null | undefined} data - The document data object to filter.
 * @param {any} schema - The Valibot schema defining the structure and field visibility.
 * Expected to be a v.object schema with entries property.
 * @param {boolean} isAdmin - Whether the current user has administrative privileges.
 * @returns {Partial<T>} A new object containing only the fields visible to the user,
 * or an empty object if input data is null/undefined.
 */
export function filterVisibleFields<T extends Record<string, any>>(
  data: T | null | undefined,
  schema: any, // Use any for broader compatibility
  isAdmin: boolean
): Partial<T> {
  if (!data) {
    return {}; // Return empty object if data is null or undefined
  }

  // Get the list of field names visible based on the schema and admin status
  const visibleFieldNames = getVisibleFields(schema, isAdmin);

  // Create a new result object
  const result: Partial<T> = {};

  // Iterate over the visible field names and copy corresponding values from the original data
  for (const key of visibleFieldNames) {
    // Check if the key exists in the original data object
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      // Type assertion needed as key is string, but we expect it to be keyof T
      result[key as keyof T] = data[key as keyof T];
    }
  }

  return result;
}
