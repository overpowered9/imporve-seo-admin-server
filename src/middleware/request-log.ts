/**
 * What the request logger prints for a body (moved out of index.ts so it can be tested).
 *
 * Bodies are redacted before logging. This previously printed req.body verbatim, which wrote
 * every customer's plaintext password to the logs on each /auth/login and /auth/signup, and
 * would now do the same for the admin password. Anyone with log access had the credentials.
 *
 * Content v3 bodies carry the customer's own words (owner answers, business description,
 * "anything else", the call-to-action phone), so for /api/v1/content-v3/* only the field names
 * are logged; the v3 handlers log what support needs, by run id.
 */
export const REDACTED_KEYS = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apiKey',
  // Business contact details. The v3 content route carries a full business profile, so without
  // these a customer's phone number, street address and geo coordinates would be printed to the
  // application log on every generation.
  'phone',
  'telephone',
  'cta_phone',
  'address',
  'latitude',
  'longitude',
]);

/**
 * Redact sensitive keys at any depth.
 *
 * This used to be top-level only, which was enough when bodies were flat. A nested profile object
 * walked straight past it, so the redaction has to follow the nesting. Depth is capped so a
 * pathological body cannot turn logging into a traversal.
 */
export function redactBody(body: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (Array.isArray(body)) return body.map((v) => redactBody(v, depth + 1));
  if (!body || typeof body !== 'object') return body;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key) ? '[redacted]' : redactBody(value, depth + 1);
  }
  return out;
}

const FIELD_NAMES_ONLY = /^\/api\/v1\/content-v3(?:\/|$)/;

/** The body as the request log line shows it. */
export function requestLogBody(path: string, body: unknown): unknown {
  if (FIELD_NAMES_ONLY.test(path) && body && typeof body === 'object' && !Array.isArray(body)) {
    return { fields: Object.keys(body as Record<string, unknown>) };
  }
  return redactBody(body);
}
