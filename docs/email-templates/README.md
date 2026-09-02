# Supabase Auth email templates

**Nothing in this folder is loaded by any code.** These are Supabase *dashboard*
configuration, kept here so the wording and markup are version-controlled and
reviewable like everything else.

## Why these are not in `email.service.ts`

The API sends its own mail through Mailgun (`src/services/email.service.ts`, from
`noreply@improveseoplugin.com`). The signup **confirmation link** is different: it
is sent by **Supabase Auth**, because only Supabase can mint the confirmation
token. It reaches the customer from `auth@improveseoplugin.com` — Supabase's own
Custom SMTP identity, pointed at the same Mailgun account, which is why the
header reads `via mailgun.org`.

Two senders, two systems. There is no code path in this repo that can change the
confirmation email's appearance.

## Applying `supabase-confirm-signup.html`

1. Supabase Dashboard → **Authentication → Emails → Templates → Confirm signup**
2. Set **Subject** to: `Confirm your email address`
3. Paste the whole file into the message body, replacing what is there
4. Save, then use **Send test email** before trusting it

`{{ .ConfirmationURL }}` is Supabase's placeholder for the confirmation link and
appears twice — once on the button, once as the paste-able fallback. **Both must
survive any edit**; without it the email cannot do its job. `{{ .Email }}` and
`{{ .SiteURL }}` are also available if you want them.

The sender name and address are set separately, under
**Authentication → Emails → SMTP Settings**.

## Notes on the markup

- **Tables and inline styles, deliberately.** Gmail strips `<style>` blocks in
  some contexts and Outlook ignores flexbox, grid, and most `border-radius`.
  Anything cleverer than this renders unpredictably.
- **The button is a solid `#E55432`, not the CMS's orange gradient.** CSS
  gradients do not render in Outlook, and a gradient that half-loads looks worse
  than a flat colour that always works.
- **The logo is a PNG, not an SVG.** Gmail does not render SVG in email — worth
  knowing, because the ticket and bulk templates in `email.service.ts` hotlink
  `…/logo.svg` and are therefore probably showing nothing in Gmail today.
- The logo is served from the CMS host (`FRONTEND_URL`). If that host moves,
  update the `<img src>` — or better, point it at a stable marketing domain.

## Reusing the shell

The other Supabase templates — **Magic Link**, **Reset Password**, **Change Email
Address**, **Invite** — are configured on the same screen and are currently
Supabase defaults. To bring them into line, copy this file and change three
things: the `<h1>`, the paragraph under it, and the button label. Each template
has its own placeholder (`{{ .ConfirmationURL }}` for most, `{{ .Token }}` where
a code is shown instead of a link) — check the label above each editor rather
than assuming.

## What this does *not* cover

The **"Your ImproveSEO account is ready"** confirmation and the **welcome** email
are a separate pair, sent by this API from
`src/services/trial-emails.service.ts` and templated in `email.service.ts`
(`accountConfirmation`, `trialWelcome`). They are code, not dashboard config, and
are edited there. See `ensureSignupEmails` for when they go out.
