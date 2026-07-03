/**
 * Company-email policy for the free-credit verification gate.
 *
 * "Company email" is a heuristic — we reject the common free/consumer providers and
 * a starter list of disposable domains. It is not foolproof (someone can buy a cheap
 * domain with catch-all mail), but combined with the one-grant-per-email ledger cap it
 * bounds abuse: each mailbox is worth exactly one grant, ever.
 *
 * Tuning: set ALLOW_FREE_EMAIL=true to permit free providers (useful for testing).
 * The lists below are intentionally small and easy to extend.
 */

const FREE_PROVIDERS = new Set<string>([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'yandex.ru', 'zoho.com',
  'pm.me', 'tutanota.com', 'hey.com',
]);

const DISPOSABLE_PROVIDERS = new Set<string>([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', '10minutemail.com',
  'tempmail.com', 'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'getnada.com',
  'trashmail.com', 'sharklasers.com', 'maildrop.cc', 'dispostable.com', 'fakeinbox.com',
  'mohmal.com', 'mintemail.com', 'emailondeck.com', 'moakt.com', 'tmpmail.org',
  'spamgourmet.com', 'mytemp.email', 'discard.email', 'tempmailo.com', 'burnermail.io',
]);

export type EmailPolicyResult =
  | { ok: true; domain: string }
  | { ok: false; code: 'INVALID_EMAIL' | 'FREE_EMAIL' | 'DISPOSABLE_EMAIL'; message: string };

export function checkCompanyEmail(rawEmail: string): EmailPolicyResult {
  const email = (rawEmail || '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1 || !email.includes('.', at)) {
    return { ok: false, code: 'INVALID_EMAIL', message: 'Please enter a valid email address.' };
  }
  const domain = email.slice(at + 1);

  if (DISPOSABLE_PROVIDERS.has(domain)) {
    return { ok: false, code: 'DISPOSABLE_EMAIL', message: 'Temporary/disposable email addresses are not allowed. Please use your company email.' };
  }

  const allowFree = String(process.env.ALLOW_FREE_EMAIL || '').toLowerCase() === 'true';
  if (!allowFree && FREE_PROVIDERS.has(domain)) {
    return { ok: false, code: 'FREE_EMAIL', message: 'Please use your company email address (personal Gmail/Outlook/etc. are not accepted).' };
  }

  return { ok: true, domain };
}
