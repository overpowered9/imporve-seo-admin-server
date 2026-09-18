import axios from 'axios';
import FormData from 'form-data';

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Override the default "From" header (e.g. "Nathan from ImproveSEO <nathan@…>"). */
  from?: string;
  /** Set a Reply-To so replies reach a monitored inbox. */
  replyTo?: string;
  /**
   * List-Unsubscribe target for LIFECYCLE mail (BILL-008).
   *
   * Deliberately absent on transactional receipts: offering to unsubscribe from
   * being told what you were charged is an offer we cannot honour, and mailbox
   * providers treat the header as a promise.
   */
  listUnsubscribe?: string;
}

export const sendEmail = async (options: EmailOptions): Promise<boolean> => {
  try {
    const mailgunDomain = process.env.MAILGUN_DOMAIN;
    const mailgunApiKey = process.env.MAILGUN_API_KEY;
    const mailgunFromName = process.env.MAILGUN_FROM_NAME || 'ImproveSEO Support';
    const mailgunFromEmail = process.env.MAILGUN_FROM_EMAIL || 'noreply@improveseo.app';
    const defaultFromHeader = mailgunFromEmail.includes('<')
      ? mailgunFromEmail
      : `${mailgunFromName} <${mailgunFromEmail}>`;
    const fromHeader = options.from || defaultFromHeader;

    if (!mailgunDomain || !mailgunApiKey) {
      console.warn('Mailgun configuration missing. Skipping email send.');
      return false;
    }

    const form = new FormData();
    form.append('from', fromHeader);
    form.append('to', options.to);
    form.append('subject', options.subject);
    form.append('html', options.html);
    if (options.text) {
      form.append('text', options.text);
    }
    if (options.replyTo) {
      form.append('h:Reply-To', options.replyTo);
    }
    if (options.listUnsubscribe) {
      // Both headers: One-Click is what Gmail and Yahoo require for bulk
      // senders, and the plain header is the long-standing fallback.
      form.append('h:List-Unsubscribe', `<${options.listUnsubscribe}>`);
      form.append('h:List-Unsubscribe-Post', 'List-Unsubscribe=One-Click');
    }

    const response = await axios.post(
      `https://api.mailgun.net/v3/${mailgunDomain}/messages`,
      form,
      {
        auth: {
          username: 'api',
          password: mailgunApiKey
        },
        headers: form.getHeaders()
      }
    );

    console.log('Email sent successfully:', response.data.id);
    return true;
  } catch (error) {
    console.error('Failed to send email:', error);
    return false;
  }
};

// ── Trial drip emails (personal, from the CEO) ───────────────────────────────
// Simple, letter-style layout — these read as a person writing, not a product
// ═══════════════════════════════════════════════════════════════════════════
// Templates
//
// MOVED OUT of this module. It owned the transport, three different HTML
// shells and every template, which is exactly how the three shells came to
// disagree with each other — nothing sat above them to notice.
//
// This file is now the transport and nothing else. Layout lives in
// email/layout.ts; templates live beside it. Both are re-exported here so the
// existing call sites keep their imports.
// ═══════════════════════════════════════════════════════════════════════════
export { emailTemplates } from './email/product-templates.js';
// ═══════════════════════════════════════════════════════════════════════════
// Billing, credit and subscription templates
//
// MOVED to services/email/billing-templates.ts, and re-exported here so the
// existing import sites keep working.
//
// They moved because they stopped being a handful of receipts: there are now
// twelve of them covering every billing action, and they share a layout with
// the trial and ticket mail. Keeping them in this file would have meant one
// module owning the transport, the layout and every template — which is how the
// three shells that disagreed with each other came about in the first place.
//
// The contract is unchanged: one payload object per template, captured from the
// billing event at enqueue time, formatted and never recomputed.
// ═══════════════════════════════════════════════════════════════════════════
export { billingEmailTemplates } from './email/billing-templates.js';
export type {
  PlanChangedPayload, DowngradePayload, CancelledPayload, PausePayload, ResumePayload,
  CreditPurchasePayload, RenewalPayload, RefundPayload, PaymentFailedPayload,
  CreditExpiryPayload, InactivityPayload, TrialEndedPayload, RenderedEmail, LineItem,
} from './email/billing-templates.js';
