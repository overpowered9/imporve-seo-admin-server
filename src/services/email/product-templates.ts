/**
 * Trial, support-ticket and bulk-project email.
 *
 * ── WHAT CHANGED AND WHY ────────────────────────────────────────────────────
 * The copy is preserved; the HTML around it is not. These templates each
 * carried their own ~60-line `<style>` block, repeated almost verbatim five
 * times, built on `linear-gradient`, `::before`, `box-shadow` and an SVG logo.
 *
 * Every one of those fails somewhere that matters:
 *   • Outlook ignores `<style>` for layout and drops gradients and radii, so
 *     the most heavily designed emails were the ones that arrived broken.
 *   • Gmail strips `<style>` in clipped and forwarded views.
 *   • No mainstream mail client renders SVG — the logo was a broken-image icon
 *     for most recipients of every one of these.
 *
 * They now render through `emailShell`, which is table-based, inline-styled,
 * and carries a wordmark that cannot break. See layout.ts for the reasoning.
 *
 * ── SIGNATURES ARE UNCHANGED ────────────────────────────────────────────────
 * Positional arguments, exactly as the call sites in tickets.routes.ts,
 * bulk-notifications.routes.ts and trial-emails.service.ts pass them. Changing
 * them here would have meant changing four files to fix a rendering problem.
 */
import { emailShell, p, small, row, dataTable, callout, list, signoff, textBody, escapeHtml } from './layout.js';

export interface RenderedEmail { subject: string; html: string; text: string }

/** Where a ticket lives in the CMS. */
const ticketUrl = (cmsUrl: string, ticketId: string): string =>
  `${String(cmsUrl).replace(/\/$/, '')}/support/tickets/${ticketId}`;

/**
 * Truncate a quoted message.
 *
 * Kept at the original 500 characters. The point of quoting a reply is to tell
 * the reader whether it needs their attention, not to replace the thread.
 */
const excerpt = (message: string, limit = 500): string =>
  message.length > limit ? `${message.slice(0, limit)}…` : message;

export const emailTemplates = {
  /**
   * Email 1 of 4 — account creation. Transactional, from the system sender,
   * sent alongside the (human) welcome email.
   */
  accountConfirmation: (firstName: string, dashboardUrl: string, trialEndsDate: string): RenderedEmail => ({
    subject: 'Your ImproveSEO account is ready',
    html: emailShell({
      heading: 'Your account is ready',
      preheader: `Your 7-day free trial is active until ${trialEndsDate}.`,
      body:
        p(`Hi ${escapeHtml(firstName)},`) +
        p(`Your ImproveSEO account has been created and your <strong>7-day free trial</strong> is now active.`) +
        dataTable(
          row('Trial ends', escapeHtml(trialEndsDate)) +
          row('Included', '10 free credits each for articles, images &amp; keywords'),
        ) +
        p(`Log in any time to start generating local-search-ready content.`),
      cta: { label: 'Go to dashboard', url: dashboardUrl },
      footnote: 'This is an automated confirmation from ImproveSEO.',
    }),
    text: textBody([
      `Hi ${firstName},`,
      '',
      `Your ImproveSEO account has been created and your 7-day free trial is now active.`,
      '',
      `Trial ends: ${trialEndsDate}`,
      `Included: 10 free credits each for articles, images & keywords`,
      '',
      `Log in any time to start generating local-search-ready content:`,
      dashboardUrl,
      '',
      `This is an automated confirmation from ImproveSEO.`,
    ]),
  }),

  /** Email 2 of 4 — welcome, from the CEO, sent with the confirmation. */
  trialWelcome: (firstName: string, createUrl: string): RenderedEmail => ({
    subject: "You're in — let's create your first local SEO page",
    html: emailShell({
      heading: "Let's get your first page live",
      preheader: 'One thing to do today, and it takes a few minutes.',
      body:
        p(`Hi ${escapeHtml(firstName)},`) +
        p(`Welcome to ImproveSEO! You've already got the technical setup email — this one's just from us, human to human.`) +
        p(`Most local businesses lose customers to competitors simply because they don't have enough content targeting the neighborhoods, services, and search terms people actually search for — and increasingly, ask AI chatbots like ChatGPT and Google's AI answers about. That's what this plugin solves — it generates new, local-search-ready content built to get found both on Google and in AI chatbot answers, without you needing to write it yourself or know anything about SEO.`) +
        callout(`<strong>One thing to do today:</strong> log in and generate your first page or post. Takes a few minutes, and you'll see exactly how it's built for local search.`) +
        p(`Stuck or confused? Just reply — a real person reads these.`) +
        signoff(),
      cta: { label: 'Create my first page', url: createUrl },
    }),
    text: textBody([
      `Hi ${firstName},`,
      '',
      `Welcome to ImproveSEO! You've already got the technical setup email — this one's just from us, human to human.`,
      '',
      `Most local businesses lose customers to competitors simply because they don't have enough content targeting the neighborhoods, services, and search terms people actually search for — and increasingly, ask AI chatbots like ChatGPT and Google's AI answers about. That's what this plugin solves — it generates new, local-search-ready content built to get found both on Google and in AI chatbot answers, without you needing to write it yourself or know anything about SEO.`,
      '',
      `One thing to do today: log in and generate your first page or post. Takes a few minutes, and you'll see exactly how it's built for local search.`,
      '',
      `Create my first page: ${createUrl}`,
      '',
      `Stuck or confused? Just reply — a real person reads these.`,
      '',
      `Best,`,
      `Nathan, CEO of ImproveSEO`,
    ]),
  }),

  /** Email 3 of 4 — check-in, around day 3. No CTA: this one asks for a reply. */
  trialCheckin: (firstName: string): RenderedEmail => ({
    subject: "How's it going so far?",
    html: emailShell({
      heading: 'How is it going so far?',
      preheader: 'A few days in — tell us your business type and we will suggest where to start.',
      body:
        p(`Hi ${escapeHtml(firstName)},`) +
        p(`A few days into your trial — checking in.`) +
        p(`Have you generated your first piece of content yet? Most business owners are surprised how much local detail (neighborhoods, services, common customer phrases) ImproveSEO builds in automatically — content designed to help you get found on Google and when people ask AI chatbots for recommendations.`) +
        p(`If you haven't started, or aren't sure what to create first, reply and tell us your business type and service area. We'll suggest exactly where to start.`) +
        signoff(),
    }),
    text: textBody([
      `Hi ${firstName},`,
      '',
      `A few days into your trial — checking in.`,
      '',
      `Have you generated your first piece of content yet? Most business owners are surprised how much local detail (neighborhoods, services, common customer phrases) ImproveSEO builds in automatically — content designed to help you get found on Google and when people ask AI chatbots for recommendations.`,
      '',
      `If you haven't started, or aren't sure what to create first, reply and tell us your business type and service area. We'll suggest exactly where to start.`,
      '',
      `Best,`,
      `Nathan, CEO of ImproveSEO`,
    ]),
  }),

  /** Email 4 of 4 — the morning of the last trial day. */
  trialEnding: (firstName: string, upgradeUrl: string): RenderedEmail => ({
    subject: 'Your trial wraps up today',
    html: emailShell({
      heading: 'Your trial wraps up today',
      preheader: '$25/month, no contract, cancel anytime.',
      body:
        p(`Hi ${escapeHtml(firstName)},`) +
        p(`Your 7-day trial ends tonight. Here's a quick recap of what ImproveSEO does for you:`) +
        list([
          `Generates new, local-search-ready content for your site — no writing or SEO knowledge needed`,
          `Helps you show up for the neighborhoods, services, and search terms your customers are actually searching — including through AI chatbots like ChatGPT, not just Google`,
        ]) +
        callout(`<strong>To keep it going:</strong> $25/month, no contract, cancel anytime.`) +
        p(`Questions or on the fence? Reply — happy to help you decide either way.`) +
        signoff(),
      cta: { label: 'Keep my plugin active', url: upgradeUrl },
    }),
    text: textBody([
      `Hi ${firstName},`,
      '',
      `Your 7-day trial ends tonight. Here's a quick recap of what ImproveSEO does for you:`,
      '',
      `- Generates new, local-search-ready content for your site — no writing or SEO knowledge needed`,
      `- Helps you show up for the neighborhoods, services, and search terms your customers are actually searching — including through AI chatbots like ChatGPT, not just Google`,
      '',
      `To keep it going: $25/month, no contract, cancel anytime.`,
      '',
      `Keep my plugin active: ${upgradeUrl}`,
      '',
      `Questions or on the fence? Reply — happy to help you decide either way.`,
      '',
      `Best,`,
      `Nathan, CEO of ImproveSEO`,
    ]),
  }),

  // ── Support tickets ───────────────────────────────────────────────────────
  // `subject` and `message` are user-supplied and were interpolated raw into
  // the HTML. They are escaped now — these go to staff as well as customers.

  ticketCreated: (
    ticketId: string, ticketDisplayId: string, subject: string, userName: string, cmsUrl: string,
  ): RenderedEmail => ({
    subject: `Your support ticket has been created — ${ticketDisplayId}`,
    html: emailShell({
      heading: "We've got your ticket",
      preheader: `${ticketDisplayId} — our team responds within 24 hours.`,
      body:
        p(`Hi ${escapeHtml(userName)},`) +
        p(`Thanks for reaching out. Your ticket is in our system and the team will get back to you shortly.`) +
        dataTable(
          row('Ticket ID', `<strong>${escapeHtml(ticketDisplayId)}</strong>`, true) +
          row('Subject', escapeHtml(subject)),
        ) +
        p(`<strong>What happens next</strong>`) +
        list([
          'Your ticket is queued for review',
          'Our team will respond within 24 hours',
          "You'll get an email update whenever there's progress",
        ]),
      cta: { label: 'View your ticket', url: ticketUrl(cmsUrl, ticketId) },
      footnote: 'Please reply in your support dashboard rather than to this email, so everything stays on the ticket.',
    }),
    text: textBody([
      `Hi ${userName},`,
      '',
      `Thanks for reaching out. Your ticket is in our system and the team will get back to you shortly.`,
      '',
      `Ticket ID: ${ticketDisplayId}`,
      `Subject: ${subject}`,
      '',
      `View your ticket: ${ticketUrl(cmsUrl, ticketId)}`,
      '',
      `What happens next:`,
      `- Your ticket is queued for review`,
      `- Our team will respond within 24 hours`,
      `- You'll get an email update whenever there's progress`,
    ]),
  }),

  ticketReplied: (
    ticketId: string, ticketDisplayId: string, message: string, senderName: string, cmsUrl: string,
  ): RenderedEmail => ({
    subject: `New reply on your ticket — ${ticketDisplayId}`,
    html: emailShell({
      heading: `${escapeHtml(senderName)} replied to your ticket`,
      preheader: excerpt(message, 110),
      body:
        p(`Hi there,`) +
        p(`<strong>${escapeHtml(senderName)}</strong> has responded to your support ticket:`) +
        callout(escapeHtml(excerpt(message))) +
        small(`Ticket: ${escapeHtml(ticketDisplayId)}`),
      cta: { label: 'View conversation', url: ticketUrl(cmsUrl, ticketId) },
      footnote: 'Reply in your support dashboard so your answer reaches the same ticket.',
    }),
    text: textBody([
      `Hi there,`,
      '',
      `${senderName} has replied to your support ticket ${ticketDisplayId}:`,
      '',
      excerpt(message),
      '',
      `View the conversation: ${ticketUrl(cmsUrl, ticketId)}`,
    ]),
  }),

  ticketClosed: (
    ticketId: string, ticketDisplayId: string, reason: string, cmsUrl: string,
  ): RenderedEmail => ({
    subject: `Your ticket has been closed — ${ticketDisplayId}`,
    html: emailShell({
      heading: 'Your ticket is resolved',
      preheader: `${ticketDisplayId} is closed. Reopen it any time if it is not fixed.`,
      body:
        p(`Hi there,`) +
        p(`Your support ticket has been resolved and closed.`) +
        callout(escapeHtml(reason || 'Your issue has been addressed by our support team.')) +
        small(`Ticket: ${escapeHtml(ticketDisplayId)}`) +
        p(`If this isn't actually fixed, reply on the ticket and it reopens — you don't need to start a new one.`),
      cta: { label: 'View ticket details', url: ticketUrl(cmsUrl, ticketId) },
    }),
    text: textBody([
      `Hi there,`,
      '',
      `Your support ticket ${ticketDisplayId} has been resolved and closed.`,
      '',
      reason || 'Your issue has been addressed by our support team.',
      '',
      `If this isn't actually fixed, reply on the ticket and it reopens.`,
      `View ticket details: ${ticketUrl(cmsUrl, ticketId)}`,
    ]),
  }),

  // ── Bulk projects ─────────────────────────────────────────────────────────

  bulkTaskCreated: (
    userName: string, taskName: string, totalKeywords: number, websiteDomain: string, projectUrl: string,
  ): RenderedEmail => ({
    subject: `Bulk project created — ${taskName}`,
    html: emailShell({
      heading: 'Your bulk project is queued',
      preheader: `${totalKeywords} keywords queued for ${websiteDomain}.`,
      body:
        p(`Hi ${escapeHtml(userName)},`) +
        p(`Your bulk content project has been created and is now queued for processing on <strong>${escapeHtml(websiteDomain)}</strong>.`) +
        dataTable(
          row('Project', `<strong>${escapeHtml(taskName)}</strong>`, true) +
          row('Total keywords', String(totalKeywords)) +
          row('Website', escapeHtml(websiteDomain)),
        ) +
        p(`You'll get another email when all the posts have been generated.`),
      cta: { label: 'View project', url: projectUrl },
    }),
    text: textBody([
      `Hi ${userName},`,
      '',
      `Your bulk content project has been created and queued for processing.`,
      '',
      `Project: ${taskName}`,
      `Total keywords: ${totalKeywords}`,
      `Website: ${websiteDomain}`,
      '',
      `You'll get another email when all the posts have been generated.`,
      `View project: ${projectUrl}`,
    ]),
  }),

  bulkTaskCompleted: (
    userName: string, taskName: string, totalGenerated: number, totalFailed: number,
    websiteDomain: string, projectUrl: string,
  ): RenderedEmail => {
    const totalTasks = totalGenerated + totalFailed;
    const allFailed = totalGenerated === 0 && totalFailed > 0;
    const statusText = allFailed ? 'Bulk project finished (with issues)' : 'Bulk project complete';

    return {
      subject: `${statusText} — ${taskName}`,
      html: emailShell({
        heading: statusText,
        preheader: `${totalGenerated} of ${totalTasks} generated on ${websiteDomain}.`,
        body:
          p(`Hi ${escapeHtml(userName)},`) +
          p(`Your bulk content project on <strong>${escapeHtml(websiteDomain)}</strong> has finished processing.`) +
          dataTable(
            row('Project', `<strong>${escapeHtml(taskName)}</strong>`, true) +
            row('Website', escapeHtml(websiteDomain)) +
            row('Total', String(totalTasks)) +
            row('Generated', String(totalGenerated)) +
            row('Failed', String(totalFailed)),
          ) +
          // The stat grid this replaces was three floated cards with coloured
          // backgrounds that collapsed into a vertical stack in Outlook and
          // needed an mso-conditional fallback to survive at all. A table row
          // per number says the same thing in every client.
          (allFailed
            ? p(`Nothing generated this time. That usually means the site connection dropped or the keywords came back empty — open the project and the per-keyword errors will say which.`)
            : totalFailed > 0
              ? p(`${totalFailed} of ${totalTasks} didn't generate. Open the project to see why and retry just those.`)
              : p(`Everything generated successfully.`)),
        cta: { label: 'View project', url: projectUrl },
      }),
      text: textBody([
        `${statusText}`,
        '',
        `Hi ${userName},`,
        '',
        `Your bulk content project on ${websiteDomain} has finished processing.`,
        '',
        `Project: ${taskName}`,
        `Website: ${websiteDomain}`,
        `Total: ${totalTasks}`,
        `Generated: ${totalGenerated}`,
        `Failed: ${totalFailed}`,
        '',
        allFailed
          ? `Nothing generated this time. Open the project and the per-keyword errors will say why.`
          : totalFailed > 0
            ? `${totalFailed} of ${totalTasks} didn't generate. Open the project to see why and retry just those.`
            : `Everything generated successfully.`,
        '',
        `View project: ${projectUrl}`,
      ]),
    };
  },
};
