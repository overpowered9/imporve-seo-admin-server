/**
 * Render every email to a browsable gallery.
 *
 *   npm run email:preview            # writes email-previews/index.html
 *   npm run email:preview -- --open  # and prints the path to open
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * A customer received a receipt headed "Welcome to undefined". Nobody had ever
 * LOOKED at one. There was no way to look short of triggering a real billing
 * event against a real Stripe account and checking a real inbox, which is why
 * in practice nobody did.
 *
 * This renders all of them from fixtures in a couple of seconds, with no
 * database, no Stripe and no Mailgun. Run it after touching any template.
 *
 * The fixtures are deliberately AWKWARD, not tidy: absent cards, open-ended
 * pauses, zero-failure and all-failure bulk runs, a final dunning attempt. The
 * tidy cases were never the ones that broke.
 */
import fs from 'node:fs';
import path from 'node:path';
import { billingEmailTemplates } from '../services/email/billing-templates.js';
import { emailTemplates } from '../services/email/product-templates.js';
import { unrenderedTokensIn } from '../services/billing/email-worker.js';

interface Sample { group: string; name: string; note: string; rendered: { subject: string; html: string; text: string } }

const B = billingEmailTemplates;
const P = emailTemplates;

const samples: Sample[] = [
  // ── Subscription ────────────────────────────────────────────────────────
  {
    group: 'Subscription', name: 'First subscription', note: 'billing.upgrade with oldPlan = null',
    rendered: B.billingPlanChanged({
      firstName: 'Zaid', oldPlan: null, newPlan: 'Scale', amountCharged: '$99.00',
      lines: [{ description: 'Scale — first month', amount: '$99.00' }],
      nextAmount: '$99.00', nextBillingDate: 'October 18, 2026',
      cardBrand: 'visa', cardLast4: '4242', billingUrl: 'https://account.improveseoplugin.com/credits',
      timezone: 'UTC', creditsNote: '1,200 credits have been added to your account.',
    }),
  },
  {
    group: 'Subscription', name: 'Upgrade', note: 'Prorated, quoting the disclosure the customer accepted',
    rendered: B.billingPlanChanged({
      firstName: 'Zaid', oldPlan: 'Optimize', newPlan: 'Scale', amountCharged: '$24.13',
      lines: [
        { description: 'Scale (remainder of period)', amount: '$61.20' },
        { description: 'Unused time on Optimize', amount: '-$37.07' },
      ],
      nextAmount: '$99.00', nextBillingDate: 'October 18, 2026',
      cardBrand: 'mastercard', cardLast4: '5100', billingUrl: 'https://account.improveseoplugin.com/credits',
      timezone: 'UTC',
    }),
  },
  {
    group: 'Subscription', name: 'Downgrade', note: 'NEW — this previously sent nothing at all',
    rendered: B.billingDowngraded({
      firstName: 'Zaid', oldPlan: 'Scale', newPlan: 'Optimize', effectiveDate: 'October 18, 2026',
      nextAmount: '$49.00',
      creditsNote: 'The credits already on your account stay there — this change does not remove any. From October 18, 2026 your monthly allowance becomes the Optimize allowance.',
      billingUrl: 'https://account.improveseoplugin.com/credits', timezone: 'UTC',
    }),
  },
  {
    group: 'Subscription', name: 'Cancellation', note: 'With remaining credits',
    rendered: B.billingCancelled({
      firstName: 'Zaid', planName: 'Scale', accessUntil: 'October 18, 2026',
      creditsNote: 'You have 240 credits remaining. They stay usable until October 18, 2026; any credits you purchased separately remain on your account afterwards.',
      resubscribeUrl: 'https://account.improveseoplugin.com/credits?view=plans',
      billingUrl: 'https://account.improveseoplugin.com/credits', timezone: 'UTC',
    }),
  },
  {
    group: 'Subscription', name: 'Paused', note: 'NEW — open-ended, so no restart date is invented',
    rendered: B.billingPaused({
      firstName: 'Zaid', planName: 'Scale', resumesOn: null,
      creditsNote: 'The credits already on your account stay there and remain usable while the subscription is paused. Your monthly allowance simply stops arriving until you resume.',
      billingUrl: 'https://account.improveseoplugin.com/credits',
    }),
  },
  {
    group: 'Subscription', name: 'Resumed', note: 'NEW — quotes the period Stripe just decided on',
    rendered: B.billingResumed({
      firstName: 'Zaid', planName: 'Scale', nextAmount: '$99.00', nextBillingDate: 'October 18, 2026',
      creditsNote: 'Your monthly credit allowance starts arriving again from your next billing date.',
      billingUrl: 'https://account.improveseoplugin.com/credits', timezone: 'UTC',
    }),
  },

  // ── Money ───────────────────────────────────────────────────────────────
  {
    group: 'Money', name: 'Credit pack receipt', note: 'NEW — the largest gap; money moved with no confirmation',
    rendered: B.creditPurchase({
      firstName: 'Zaid', packName: '500 credits — about 20 pieces of content',
      creditsAdded: '500 credits', newBalance: '740 credits', amountCharged: '$40.00',
      cardBrand: 'visa', cardLast4: '4242', receiptUrl: 'https://invoice.stripe.com/x',
      expiresOn: 'September 18, 2027', creditsUrl: 'https://account.improveseoplugin.com/credits',
    }),
  },
  {
    group: 'Money', name: 'Renewal receipt', note: 'NEW — quiet by design; findable in a search months later',
    rendered: B.renewalReceipt({
      firstName: 'Zaid', planName: 'Scale', amountCharged: '$99.00', periodLabel: 'another month',
      creditsNote: 'Your monthly credit allowance has been added to your account.',
      nextBillingDate: 'November 18, 2026', cardBrand: 'visa', cardLast4: '4242',
      receiptUrl: 'https://invoice.stripe.com/x', billingUrl: 'https://account.improveseoplugin.com/credits',
      timezone: 'UTC',
    }),
  },
  {
    group: 'Money', name: 'Payment failed (1st attempt)', note: 'NEW — routine tone; states what already happened to credits',
    rendered: B.paymentFailed({
      firstName: 'Zaid', planName: 'Scale', amountDue: '$99.00', cardBrand: 'visa', cardLast4: '4242',
      attemptNumber: 1, nextAttemptDate: 'September 22, 2026', accessEndsOn: 'October 2, 2026',
      creditsNote: 'Your plan credits have been paused while this is outstanding. Any credits you purchased separately are untouched and still usable, and your plan allowance comes straight back once the payment goes through.',
      updatePaymentUrl: 'https://account.improveseoplugin.com/credits',
      invoiceUrl: 'https://invoice.stripe.com/x',
    }),
  },
  {
    group: 'Money', name: 'Payment failed (final attempt)', note: 'Same template, escalated — leads with the consequence',
    rendered: B.paymentFailed({
      firstName: 'Zaid', planName: 'Scale', amountDue: '$99.00', cardBrand: 'visa', cardLast4: '4242',
      attemptNumber: 4, nextAttemptDate: null, accessEndsOn: 'October 2, 2026',
      creditsNote: 'Your plan credits have been paused while this is outstanding. Any credits you purchased separately are untouched.',
      updatePaymentUrl: 'https://account.improveseoplugin.com/credits',
      invoiceUrl: 'https://invoice.stripe.com/x',
    }),
  },
  {
    group: 'Money', name: 'Refund', note: 'NEW — with no card on file, to prove the fallback wording',
    rendered: B.refundIssued({
      firstName: 'Zaid', amountRefunded: '$99.00', reasonLabel: 'your ImproveSEO account',
      cardBrand: null, cardLast4: null, arrivalWindow: '5–10 business days',
      creditsNote: null, billingUrl: 'https://account.improveseoplugin.com/credits',
    }),
  },

  // ── Lifecycle ───────────────────────────────────────────────────────────
  {
    group: 'Lifecycle', name: 'Credits expiring', note: 'FINAL COPY — was "[PLACEHOLDER] Your credits expire soon"',
    rendered: B.creditsExpiring({
      firstName: 'Zaid', expiringAmount: '214 plan credits', expiryDate: 'October 1, 2026',
      remainingAfter: '30 credits', ctaUrl: 'https://account.improveseoplugin.com/credits',
      leadTimeLabel: 'in 14 days', pieces: 8, planExpiring: 214, purchasedExpiring: 0,
      unsubscribeUrl: 'https://api.example/api/v1/users/unsubscribe?token=demo',
    }),
  },
  {
    group: 'Lifecycle', name: 'Inactivity nudge', note: 'FINAL COPY — short, no guilt, invites a reply',
    rendered: B.inactivityNudge({
      firstName: 'Zaid', creditBalance: '120 credits', nearestExpiry: 'October 1, 2026',
      planName: 'Grow', ctaUrl: 'https://account.improveseoplugin.com/overview', pieces: 5,
      daysInactive: 21, unsubscribeUrl: 'https://api.example/api/v1/users/unsubscribe?token=demo',
    }),
  },
  {
    group: 'Lifecycle', name: 'Trial ended', note: 'FINAL COPY — confirms nothing was lost before selling',
    rendered: B.trialEnded({
      firstName: 'Zaid', ctaUrl: 'https://account.improveseoplugin.com/credits',
      pagesCreated: 3, freeBalance: '10 credits',
      unsubscribeUrl: 'https://api.example/api/v1/users/unsubscribe?token=demo',
    }),
  },

  // ── Trial drip ──────────────────────────────────────────────────────────
  {
    group: 'Trial drip', name: 'Account confirmation', note: 'Rehoused on the shared shell',
    rendered: P.accountConfirmation('Zaid', 'https://account.improveseoplugin.com/overview', 'September 25, 2026'),
  },
  { group: 'Trial drip', name: 'Welcome', note: 'From the CEO', rendered: P.trialWelcome('Zaid', 'https://account.improveseoplugin.com/overview') },
  { group: 'Trial drip', name: 'Day-3 check-in', note: 'No CTA — this one asks for a reply', rendered: P.trialCheckin('Zaid') },
  { group: 'Trial drip', name: 'Trial ending', note: 'Morning of the last day', rendered: P.trialEnding('Zaid', 'https://account.improveseoplugin.com/credits') },

  // ── Support & bulk ──────────────────────────────────────────────────────
  {
    group: 'Support & bulk', name: 'Ticket created', note: 'User-supplied subject is escaped now',
    rendered: P.ticketCreated('t_123', 'ISEO-4821', 'Images are not generating on my staging site', 'Zaid', 'https://account.improveseoplugin.com'),
  },
  {
    group: 'Support & bulk', name: 'Ticket replied', note: 'Quoted message escaped and truncated at 500 chars',
    rendered: P.ticketReplied('t_123', 'ISEO-4821', 'Thanks for the details — that staging site is behind basic auth, which is blocking our image fetch. Whitelisting our IP should fix it.', 'Sarah', 'https://account.improveseoplugin.com'),
  },
  {
    group: 'Support & bulk', name: 'Ticket closed', note: 'Says how to reopen',
    rendered: P.ticketClosed('t_123', 'ISEO-4821', 'Basic auth was blocking image generation; resolved by whitelisting.', 'https://account.improveseoplugin.com'),
  },
  {
    group: 'Support & bulk', name: 'Bulk project created', note: 'Rehoused on the shared shell',
    rendered: P.bulkTaskCreated('Zaid', 'Denver plumbing pages', 48, 'denverplumbing.com', 'https://account.improveseoplugin.com/bulk/12'),
  },
  {
    group: 'Support & bulk', name: 'Bulk complete (partial failure)', note: 'The stat grid that broke in Outlook is now a table',
    rendered: P.bulkTaskCompleted('Zaid', 'Denver plumbing pages', 44, 4, 'denverplumbing.com', 'https://account.improveseoplugin.com/bulk/12'),
  },
  {
    group: 'Support & bulk', name: 'Bulk complete (all failed)', note: 'Says what to check, rather than only the count',
    rendered: P.bulkTaskCompleted('Zaid', 'Denver plumbing pages', 0, 48, 'denverplumbing.com', 'https://account.improveseoplugin.com/bulk/12'),
  },
];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function main() {
  const outDir = path.resolve(process.cwd(), 'email-previews');
  fs.mkdirSync(outDir, { recursive: true });

  // Fail loudly on the exact defect this whole exercise was about.
  const broken = samples.filter((s) => unrenderedTokensIn(s.rendered).length > 0);

  const groups = [...new Set(samples.map((s) => s.group))];
  const cards = groups.map((g) => `
    <h2>${esc(g)}</h2>
    <div class="grid">
      ${samples.filter((s) => s.group === g).map((s, i) => {
        const id = `${g}-${i}`.replace(/\W+/g, '-').toLowerCase();
        fs.writeFileSync(path.join(outDir, `${id}.html`), s.rendered.html, 'utf8');
        return `
        <section class="card">
          <header>
            <h3>${esc(s.name)}</h3>
            <p class="note">${esc(s.note)}</p>
            <p class="subj"><span>Subject</span> ${esc(s.rendered.subject)}</p>
          </header>
          <iframe title="${esc(s.name)}" src="${id}.html" loading="lazy"></iframe>
          <details><summary>Plain-text part</summary><pre>${esc(s.rendered.text)}</pre></details>
        </section>`;
      }).join('')}
    </div>`).join('');

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ImproveSEO email previews</title>
<style>
  :root{--ink:#0F0F14;--muted:#6B7280;--rule:#E8E8ED;--coral:#FF7A59;--teal:#1C7C73;}
  body{margin:0;padding:28px;background:#FAF9FB;color:var(--ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;}
  h1{font-size:24px;margin:0 0 6px;} h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:38px 0 14px;border-bottom:1px solid var(--rule);padding-bottom:8px;}
  h3{font-size:15px;margin:0 0 4px;} .lede{color:var(--muted);margin:0 0 4px;}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:20px;}
  .card{background:#fff;border:1px solid var(--rule);border-radius:12px;overflow:hidden;}
  .card header{padding:14px 16px;border-bottom:1px solid var(--rule);}
  .note{margin:0 0 8px;font-size:12px;color:var(--coral);}
  .subj{margin:0;font-size:12px;color:var(--muted);} .subj span{display:inline-block;background:#F2F2F6;border-radius:4px;padding:1px 6px;margin-right:6px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;}
  iframe{width:100%;height:520px;border:0;display:block;background:#FAF9FB;}
  details{border-top:1px solid var(--rule);padding:10px 16px;} summary{cursor:pointer;font-size:12px;color:var(--muted);}
  pre{white-space:pre-wrap;font-size:11.5px;color:#3A3F44;background:#FAFAFC;padding:12px;border-radius:8px;overflow-x:auto;}
  .warn{background:#FEF3F2;border:1px solid #FDA29B;color:#B42318;padding:12px 16px;border-radius:10px;margin:16px 0;}
  .ok{background:#ECFDF3;border:1px solid #A6F4C5;color:#027A48;padding:12px 16px;border-radius:10px;margin:16px 0;}
</style></head><body>
<h1>ImproveSEO email previews</h1>
<p class="lede">${samples.length} templates, rendered from fixtures. No database, Stripe or Mailgun involved.</p>
${broken.length
    ? `<div class="warn"><strong>${broken.length} template(s) contain placeholder tokens and would be BLOCKED before sending:</strong> ${broken.map((b) => esc(b.name)).join(', ')}</div>`
    : `<div class="ok"><strong>All ${samples.length} render clean.</strong> None contains undefined, null, NaN, [object Object] or an unevaluated template literal.</div>`}
${cards}
</body></html>`;

  const indexPath = path.join(outDir, 'index.html');
  fs.writeFileSync(indexPath, html, 'utf8');

  // A machine-readable index alongside the gallery, so a review page (or a
  // future snapshot test) can consume the same fixtures without re-deriving
  // which file is which.
  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(
      samples.map((s, idx) => {
        const g = s.group;
        const i = samples.filter((o) => o.group === g).indexOf(s);
        return {
          id: `${g}-${i}`.replace(/\W+/g, '-').toLowerCase(),
          group: g,
          name: s.name,
          note: s.note,
          subject: s.rendered.subject,
          text: s.rendered.text,
          order: idx,
        };
      }),
      null,
      2,
    ),
    'utf8',
  );

  console.log(`✅ ${samples.length} previews written to ${outDir}`);
  console.log(`   Open: ${indexPath}`);
  if (broken.length > 0) {
    console.error(`❌ ${broken.length} template(s) would be blocked before sending: ${broken.map((b) => b.name).join(', ')}`);
    process.exit(1);
  }
}

main();
