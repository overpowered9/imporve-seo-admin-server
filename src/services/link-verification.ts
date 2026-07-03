/**
 * Shared helpers for the email-code link verification gate.
 *
 * Codes are stored only as HMAC-SHA256 hashes (peppered), never in plaintext.
 * A successful verify mints a single-use, short-TTL `proof_token` bound to
 * (user_id, site_domain); the grant paths consume that proof to award credits.
 */
import crypto from 'crypto';
import sql from '../data/db.js';

const pepper = (): string =>
  process.env.VERIFICATION_PEPPER ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'improveseo-fallback-pepper';

export const hashCode = (code: string): string =>
  crypto.createHmac('sha256', pepper()).update(code).digest('hex');

export const timingSafeEqualHex = (a: string, b: string): boolean => {
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length !== bb.length || ba.length === 0) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
};

/**
 * Validate a link proof for this user + domain and consume it (single-use).
 * Returns the verified company email if valid, otherwise null.
 */
export const consumeLinkProof = async (
  proof: string | undefined | null,
  userId: number,
  domain: string,
): Promise<string | null> => {
  if (!proof) return null;
  const rows = await sql`
    SELECT id, email FROM email_verifications
    WHERE proof_token = ${proof}
      AND user_id = ${userId}
      AND site_domain = ${domain}
      AND proof_expires_at > NOW()
    LIMIT 1
  `;
  if (!rows[0]) return null;
  // Consume so the proof cannot be replayed.
  await sql`UPDATE email_verifications SET proof_token = NULL, proof_expires_at = NULL WHERE id = ${rows[0].id}`;
  return rows[0].email as string;
};
