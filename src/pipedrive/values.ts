/**
 * Value rules shared by tool schemas, handlers and the change resolution.
 *
 * Pipedrive names deals, persons, organizations, activities, notes, users,
 * pipelines and stages by a positive integer id (`id` in API v1 and v2,
 * https://developers.pipedrive.com/docs/api/v1). An activity type has a key
 * (`call`, `meeting`, `task`, or one the company made). A deal's status is
 * `open`, `won` or `lost`. Dates are `YYYY-MM-DD`, times `HH:MM` (UTC).
 */

/** A Pipedrive id: a positive safe integer. */
export function isRecordId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** An internal key (an activity type, a deal status, a currency code): letters, digits, `_` and `-`. */
export const INTERNAL_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isInternalValue(value: unknown): value is string {
  return typeof value === 'string' && INTERNAL_VALUE_PATTERN.test(value);
}

/** A calendar date written YYYY-MM-DD that exists. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** A time of day written HH:MM (24 hours). */
export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The start (UTC) of a YYYY-MM-DD date in RFC 3339, as API v2 takes `updated_since`. */
export function startOfDay(date: string): string {
  return `${date}T00:00:00Z`;
}
