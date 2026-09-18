/**
 * The one email layout.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * There were three unrelated shells: a letter-style one for the trial drip, a
 * plain one for billing, and a gradient-heavy one repeated verbatim in five
 * ticket and bulk templates. They disagreed on width, typeface, button colour,
 * footer and logo, so which brand a customer saw depended on which system
 * happened to mail them. Worse, two of the three used colours that are not in
 * the product's palette at all.
 *
 * Everything the server sends now renders through `emailShell`. Adding a
 * template means writing copy and picking components, never HTML scaffolding.
 *
 * ── WHY INLINE STYLES AND TABLES ────────────────────────────────────────────
 * Not nostalgia. Outlook (Word's rendering engine) ignores `<style>` blocks for
 * layout, drops `border-radius`, and mis-sizes anything that is not a table.
 * Gmail strips `<style>` entirely in its clipped/forwarded views. The old
 * ticket templates used `::before`, `linear-gradient` and `box-shadow`, none of
 * which survive Outlook — so the "designed" emails were the ones that looked
 * broken in the client most business customers read mail in.
 *
 * ── WHY THE CTA IS TEAL AND NOT THE CORAL PRIMARY ───────────────────────────
 * The product's primary is coral (#FF7A59). White text on coral is 2.6:1 —
 * it fails WCAG AA (4.5:1) and is genuinely hard to read on a phone outdoors.
 * Pacific teal is 5.1:1 and passes. So coral stays as an accent on borders and
 * rules, where contrast rules do not apply, and the button — the one element
 * that must be readable — is teal. This is a deliberate divergence from the
 * app's palette, not a mistake to "fix" later.
 */

/** Straight from the CMS theme, so email and app cannot drift apart. */
export const BRAND = {
  coral: '#FF7A59',
  teal: '#1C7C73',
  navy: '#0B1229',
  ink: '#0F0F14',
  offWhite: '#FAF9FB',
  sand: '#EAFADE',
  mint: '#7ECDB0',
  /** Body copy. Softer than ink, still 9.7:1 on white. */
  body: '#3A3F44',
  muted: '#6B7280',
  rule: '#E8E8ED',
  danger: '#B42318',
} as const;

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;

/**
 * Logo.
 *
 * Defaults to a text wordmark, NOT the SVG the old templates used. Gmail,
 * Outlook and Yahoo do not render SVG in mail — every one of those templates
 * showed a broken-image icon to most recipients. A wordmark always renders.
 *
 * Set EMAIL_LOGO_URL to a hosted **PNG** (≈240px wide, 2× for retina) to use
 * the real mark instead.
 */
const logoBlock = (): string => {
  const url = process.env.EMAIL_LOGO_URL;
  if (url && /\.(png|jpg|jpeg|gif)(\?|$)/i.test(url)) {
    return `<img src="${url}" alt="ImproveSEO" width="120" style="display:block;border:0;outline:none;text-decoration:none;height:auto;max-width:120px;">`;
  }
  return `<span style="font-family:${FONT};font-size:19px;font-weight:700;color:${BRAND.navy};letter-spacing:-0.3px;">Improve<span style="color:${BRAND.coral};">SEO</span></span>`;
};

/**
 * The hidden line the inbox shows next to the subject.
 *
 * Without one, Gmail previews whatever text comes first — for the old billing
 * templates that was "Hi Zaid," on every single email, so the list view gave
 * the reader nothing. The trailing entities stop the client from pulling body
 * copy in after it.
 */
const preheaderBlock = (text: string): string =>
  `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#FAF9FB;opacity:0;">${text}${'&#847;&zwnj;&nbsp;'.repeat(60)}</div>`;

export interface ShellOptions {
  /** The <h1>. Keep it under ~45 characters or it wraps awkwardly on a phone. */
  heading: string;
  /** Inbox preview line. Say something the subject does not. */
  preheader: string;
  /** Body HTML, built from the components below. */
  body: string;
  cta?: { label: string; url: string };
  /**
   * Lifecycle mail only. Renders the footer unsubscribe link.
   *
   * Absent on receipts by design: offering to unsubscribe from being told what
   * you were charged is an offer we cannot honour, and mailbox providers treat
   * the link as a promise.
   */
  unsubscribeUrl?: string | null;
  /** Optional small print above the footer rule (e.g. a support nudge). */
  footnote?: string;
}

/** Render a complete email. The only place raw page HTML is written. */
export const emailShell = (o: ShellOptions): string => `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(o.heading)}</title>
</head>
<body style="margin:0;padding:0;width:100%;background-color:${BRAND.offWhite};-webkit-font-smoothing:antialiased;">
${preheaderBlock(o.preheader)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BRAND.offWhite};">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;">

        <tr><td align="left" style="padding:0 8px 18px;">${logoBlock()}</td></tr>

        <tr><td style="background-color:#ffffff;border:1px solid ${BRAND.rule};border-radius:12px;padding:36px 32px;">
          <h1 style="margin:0 0 18px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:700;color:${BRAND.navy};">${o.heading}</h1>
          ${o.body}
          ${o.cta ? `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 4px;">
            <tr><td align="center" bgcolor="${BRAND.teal}" style="border-radius:8px;">
              <a href="${o.cta.url}" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${o.cta.label}</a>
            </td></tr>
          </table>` : ''}
        </td></tr>

        ${o.footnote ? `<tr><td style="padding:18px 8px 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${BRAND.muted};">${o.footnote}</td></tr>` : ''}

        <tr><td style="padding:22px 8px 0;">
          <div style="border-top:1px solid ${BRAND.rule};padding-top:16px;font-family:${FONT};font-size:12px;line-height:1.7;color:${BRAND.muted};">
            <div>&copy; ${new Date().getFullYear()} ImproveSEO</div>
            <div>${o.unsubscribeUrl
              ? `<a href="${o.unsubscribeUrl}" style="color:${BRAND.muted};text-decoration:underline;">Unsubscribe from product emails</a> &middot; You will still receive billing receipts.`
              : `This is a billing notification for your ImproveSEO account.`}</div>
          </div>
        </td></tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

// ── Body components ─────────────────────────────────────────────────────────
// Templates compose these instead of writing <p style="…"> by hand, so type
// scale and spacing cannot drift one template at a time.

/** A body paragraph. */
export const p = (html: string): string =>
  `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.65;color:${BRAND.body};">${html}</p>`;

/** Small, muted print — caveats and "if you did not do this" lines. */
export const small = (html: string): string =>
  `<p style="margin:0 0 12px;font-family:${FONT};font-size:13px;line-height:1.6;color:${BRAND.muted};">${html}</p>`;

/** One "label → value" row inside `dataTable`. */
export const row = (label: string, value: string, emphasis = false): string =>
  `<tr>
     <td style="padding:9px 0;border-bottom:1px solid ${BRAND.rule};font-family:${FONT};font-size:14px;color:${BRAND.muted};">${label}</td>
     <td style="padding:9px 0;border-bottom:1px solid ${BRAND.rule};text-align:right;font-family:${FONT};font-size:14px;font-weight:${emphasis ? 700 : 600};color:${emphasis ? BRAND.navy : BRAND.ink};">${value}</td>
   </tr>`;

/** The receipt block. Pass rows built with `row`. */
export const dataTable = (rows: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin:20px 0;border-collapse:collapse;">${rows}</table>`;

/**
 * A highlighted aside — the one thing the reader must not miss.
 *
 * Coral left rule rather than a coral fill: a tinted background behind body
 * text is where email clients' dark-mode inversion does the most damage, and a
 * 3px rule survives it intact.
 */
export const callout = (html: string, tone: 'accent' | 'warning' = 'accent'): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin:20px 0;">
     <tr><td style="border-left:3px solid ${tone === 'warning' ? BRAND.danger : BRAND.coral};padding:4px 0 4px 16px;font-family:${FONT};font-size:15px;line-height:1.6;color:${BRAND.body};">${html}</td></tr>
   </table>`;

/** A bulleted list. Pass the items as plain strings. */
export const list = (items: string[]): string =>
  `<ul style="margin:0 0 14px;padding-left:20px;font-family:${FONT};font-size:15px;line-height:1.65;color:${BRAND.body};">
     ${items.map((i) => `<li style="margin-bottom:7px;">${i}</li>`).join('')}
   </ul>`;

/** A personal sign-off, for the relationship emails rather than the receipts. */
export const signoff = (name = 'Nathan', title = 'CEO, ImproveSEO'): string =>
  `<p style="margin:22px 0 0;font-family:${FONT};font-size:15px;line-height:1.6;color:${BRAND.body};">Best,<br><strong style="color:${BRAND.navy};">${name}</strong><br><span style="color:${BRAND.muted};font-size:14px;">${title}</span></p>`;

/**
 * Escape text that came from outside before putting it in HTML.
 *
 * Ticket subjects and website names are user-supplied and were interpolated
 * raw. A subject containing markup broke the layout at best, and the emails go
 * to staff as well as customers.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build the plain-text part from the same pieces as the HTML.
 *
 * A text part is not optional: Gmail scores mail without one as more likely to
 * be spam, and the screenshot that started this work was found in a spam
 * folder. Passing `null`/`undefined` lines skips them, so a template can drop a
 * row conditionally without assembling arrays by hand.
 */
export const textBody = (lines: Array<string | null | undefined | false>): string =>
  lines.filter((l): l is string => typeof l === 'string').join('\n').replace(/\n{3,}/g, '\n\n').trim();
