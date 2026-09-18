/**
 * Send ONE template to ONE address, to check real-world delivery and rendering.
 *
 *   npm run email:test -- --to you@example.com --template billing.upgrade
 *   npm run email:test -- --to you@example.com --all
 *
 * ── WHY THIS AND NOT `email:drain` ──────────────────────────────────────────
 * DO NOT verify delivery by running the worker locally. The local .env points at
 * PRODUCTION data, so a worker started here claims real queued jobs and mails
 * real customers from a dev machine — and rows it claims are taken away from the
 * deployed worker.
 *
 * This touches the outbox not at all. It renders a template from the same
 * fixtures the preview uses and hands it straight to Mailgun, so what lands in
 * your inbox is byte-for-byte what a customer would get.
 *
 * Requires MAILGUN_DOMAIN and MAILGUN_API_KEY in .env. Without them sendEmail()
 * no-ops with a warning and this reports that rather than pretending it sent.
 */
import { sendEmail } from '../services/email.service.js';
import { RENDERERS, unrenderedTokensIn } from '../services/billing/email-worker.js';

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

/**
 * Realistic payloads, one per template.
 *
 * Kept here rather than imported from the preview script so this stays runnable
 * on a machine where that script's output directory does not exist.
 */
const FIXTURES: Record<string, any> = {
  'billing.upgrade': {
    firstName: 'Zaid', oldPlan: 'Optimize', newPlan: 'Scale', amountCharged: '$24.13',
    lines: [{ description: 'Scale (remainder of period)', amount: '$61.20' },
            { description: 'Unused time on Optimize', amount: '-$37.07' }],
    nextAmount: '$99.00', nextBillingDate: 'October 18, 2026',
    cardBrand: 'visa', cardLast4: '4242',
    billingUrl: 'https://account.improveseoplugin.com/credits', timezone: 'UTC',
  },
  'billing.downgrade': {
    firstName: 'Zaid', oldPlan: 'Scale', newPlan: 'Optimize', effectiveDate: 'October 18, 2026',
    nextAmount: '$49.00', creditsNote: 'The credits already on your account stay there.',
    billingUrl: 'https://account.improveseoplugin.com/credits', timezone: 'UTC',
  },
  'billing.cancellation': {
    firstName: 'Zaid', planName: 'Scale', accessUntil: 'October 18, 2026',
    creditsNote: 'You have 240 credits remaining.',
    resubscribeUrl: 'https://account.improveseoplugin.com/credits?view=plans',
    billingUrl: 'https://account.improveseoplugin.com/credits', timezone: 'UTC',
  },
  'billing.paused': {
    firstName: 'Zaid', planName: 'Scale', resumesOn: null,
    creditsNote: 'Your credits stay on your account while the subscription is paused.',
    billingUrl: 'https://account.improveseoplugin.com/credits',
  },
  'billing.resumed': {
    firstName: 'Zaid', planName: 'Scale', nextAmount: '$99.00',
    nextBillingDate: 'October 18, 2026',
    creditsNote: 'Your monthly credit allowance starts arriving again next cycle.',
    billingUrl: 'https://account.improveseoplugin.com/credits', timezone: 'UTC',
  },
  'billing.credit_purchase': {
    firstName: 'Zaid', packName: '500 credits — about 20 pieces of content',
    creditsAdded: '500 credits', newBalance: '740 credits', amountCharged: '$40.00',
    cardBrand: 'visa', cardLast4: '4242', receiptUrl: 'https://invoice.stripe.com/x',
    expiresOn: 'September 18, 2027', creditsUrl: 'https://account.improveseoplugin.com/credits',
  },
  'billing.renewal': {
    firstName: 'Zaid', planName: 'Scale', amountCharged: '$99.00', periodLabel: 'another month',
    creditsNote: 'Your monthly credit allowance has been added to your account.',
    nextBillingDate: 'November 18, 2026', cardBrand: 'visa', cardLast4: '4242',
    receiptUrl: 'https://invoice.stripe.com/x',
    billingUrl: 'https://account.improveseoplugin.com/credits', timezone: 'UTC',
  },
  'billing.refund': {
    firstName: 'Zaid', amountRefunded: '$99.00', reasonLabel: 'your ImproveSEO account',
    cardBrand: 'visa', cardLast4: '4242', arrivalWindow: '5–10 business days',
    creditsNote: null, billingUrl: 'https://account.improveseoplugin.com/credits',
  },
  'billing.payment_failed': {
    firstName: 'Zaid', planName: 'Scale', amountDue: '$99.00', cardBrand: 'visa', cardLast4: '4242',
    attemptNumber: 1, nextAttemptDate: 'September 22, 2026', accessEndsOn: 'October 2, 2026',
    creditsNote: 'Your plan credits have been paused while this is outstanding.',
    updatePaymentUrl: 'https://account.improveseoplugin.com/credits',
    invoiceUrl: 'https://invoice.stripe.com/x',
  },
  'lifecycle.credit_expiry': {
    firstName: 'Zaid', expiringAmount: '214 plan credits', expiryDate: 'October 1, 2026',
    remainingAfter: '30 credits', ctaUrl: 'https://account.improveseoplugin.com/credits',
    leadTimeLabel: 'in 14 days', pieces: 8,
    unsubscribeUrl: 'https://example.invalid/unsubscribe?token=test',
  },
  'lifecycle.inactivity': {
    firstName: 'Zaid', creditBalance: '120 credits', nearestExpiry: 'October 1, 2026',
    planName: 'Grow', ctaUrl: 'https://account.improveseoplugin.com/overview', pieces: 5,
    unsubscribeUrl: 'https://example.invalid/unsubscribe?token=test',
  },
  'lifecycle.trial_ended': {
    firstName: 'Zaid', ctaUrl: 'https://account.improveseoplugin.com/credits',
    pagesCreated: 3, freeBalance: '10 credits',
    unsubscribeUrl: 'https://example.invalid/unsubscribe?token=test',
  },
};

async function main() {
  const to = arg('to');
  const wanted = arg('template');
  const all = process.argv.includes('--all');

  if (!to || (!wanted && !all)) {
    console.error('Usage: npm run email:test -- --to you@example.com --template <name>');
    console.error('       npm run email:test -- --to you@example.com --all\n');
    console.error('Templates:\n  ' + Object.keys(RENDERERS).join('\n  '));
    process.exit(1);
  }

  if (!process.env.MAILGUN_DOMAIN || !process.env.MAILGUN_API_KEY) {
    console.error('❌ MAILGUN_DOMAIN and MAILGUN_API_KEY are not set in .env.');
    console.error('   sendEmail() would no-op with a warning, so nothing would actually be sent.');
    process.exit(1);
  }

  const names = all ? Object.keys(RENDERERS) : [wanted as string];
  for (const name of names) {
    if (!RENDERERS[name]) {
      console.error(`❌ Unknown template "${name}". Known: ${Object.keys(RENDERERS).join(', ')}`);
      process.exit(1);
    }
  }

  console.log(`Sending ${names.length} email(s) to ${to} — real delivery, outbox untouched.\n`);

  for (const name of names) {
    const rendered = RENDERERS[name](FIXTURES[name]);

    // The same gate the worker applies. A test send that happily delivers
    // "undefined" would defeat the point of testing.
    const leaked = unrenderedTokensIn(rendered);
    if (leaked.length > 0) {
      console.error(`❌ ${name} — REFUSED, renders ${leaked.join(', ')}`);
      continue;
    }

    const ok = await sendEmail({
      to,
      subject: `[TEST] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text,
    });
    console.log(`${ok ? '✅' : '❌'} ${name.padEnd(26)} ${rendered.subject}`);
  }

  console.log('\nCheck the inbox — and the spam folder, which is where the broken one was found.');
}

main().catch((err) => {
  console.error('❌ Test send failed:', err);
  process.exit(1);
});
