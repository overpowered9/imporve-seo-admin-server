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
// broadcast. bodyHtml is a series of <p>…</p> paragraphs; ctaLabel/ctaUrl render
// an optional button.
const trialEmailShell = (bodyHtml: string, ctaLabel?: string, ctaUrl?: string): string => `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.65; color: #2c3e50; margin: 0; padding: 0; background: #f5f7fa; }
      .wrapper { background: #f5f7fa; padding: 24px; }
      .container { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 10px; padding: 36px 34px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
      .container p { margin: 0 0 16px; font-size: 15px; color: #333; }
      .container ul { margin: 0 0 16px; padding-left: 20px; }
      .container li { font-size: 15px; color: #333; margin-bottom: 8px; }
      .cta { text-align: center; margin: 28px 0; }
      .cta a { display: inline-block; background: #1c7293; color: #ffffff !important; text-decoration: none; padding: 14px 30px; border-radius: 8px; font-weight: 700; font-size: 15px; }
      .sig { margin-top: 24px; }
      .footer { max-width: 560px; margin: 14px auto 0; text-align: center; color: #9aa0a6; font-size: 11px; }
      .footer a { color: #9aa0a6; }
    </style>
  </head>
  <body>
    <div class="wrapper">
      <div class="container">
        ${bodyHtml}
        ${ctaLabel && ctaUrl ? `<div class="cta"><a href="${ctaUrl}">${ctaLabel}</a></div>` : ''}
        <div class="sig">
          <p style="margin:0;">Best,<br><strong>Nathan</strong><br>CEO of ImproveSEO</p>
        </div>
      </div>
      <div class="footer">
        <p>© 2026 ImproveSEO. You're receiving this because you started a free trial.</p>
      </div>
    </div>
  </body>
  </html>
`;

// Email template generators
export const emailTemplates = {
  // Email 1 (of 4) — Technical account-creation confirmation. Transactional,
  // sent from the default system sender alongside the (human) Welcome email.
  accountConfirmation: (firstName: string, dashboardUrl: string, trialEndsDate: string) => ({
    subject: 'Your ImproveSEO account is ready',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #2c3e50; margin: 0; padding: 0; background: #f5f7fa; }
          .wrapper { background: #f5f7fa; padding: 22px; }
          .container { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
          .header { background: linear-gradient(135deg, #1c7293 0%, #2ec5b6 100%); padding: 40px 30px; text-align: center; }
          .header h1 { margin: 0; color: #fff; font-size: 24px; font-weight: 700; }
          .content { padding: 34px 30px; }
          .content p { margin: 0 0 14px; font-size: 15px; color: #333; }
          .facts { background: #f0f7f9; border-radius: 8px; padding: 16px 18px; margin: 18px 0; }
          .facts p { margin: 6px 0; font-size: 14px; color: #1c7293; }
          .cta { text-align: center; margin: 26px 0 6px; }
          .cta a { display: inline-block; background: #1c7293; color: #fff !important; text-decoration: none; padding: 13px 30px; border-radius: 8px; font-weight: 700; font-size: 15px; }
          .footer { background: #f8f9fa; padding: 22px; text-align: center; border-top: 1px solid #eee; }
          .footer p { margin: 3px 0; font-size: 11px; color: #9aa0a6; }
        </style>
      </head>
      <body>
        <div class="wrapper">
          <div class="container">
            <div class="header"><h1>Your account is ready</h1></div>
            <div class="content">
              <p>Hi ${firstName},</p>
              <p>Your ImproveSEO account has been created and your <strong>7-day free trial</strong> is now active.</p>
              <div class="facts">
                <p><strong>Trial ends:</strong> ${trialEndsDate}</p>
                <p><strong>Included:</strong> 10 free credits each for articles, images &amp; keywords</p>
              </div>
              <p>Log in any time to start generating local-search-ready content.</p>
              <div class="cta"><a href="${dashboardUrl}">Go to Dashboard</a></div>
            </div>
            <div class="footer">
              <p>This is an automated confirmation from ImproveSEO.</p>
              <p>© 2026 ImproveSEO. All rights reserved.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `Hi ${firstName},\n\nYour ImproveSEO account has been created and your 7-day free trial is now active.\n\nTrial ends: ${trialEndsDate}\nIncluded: 10 free credits each for articles, images & keywords\n\nLog in any time to start generating local-search-ready content:\n${dashboardUrl}\n\nThis is an automated confirmation from ImproveSEO.\n© 2026 ImproveSEO`,
  }),

  // Email 2 (of 4) — Welcome (human, from the CEO; sent with the confirmation)
  trialWelcome: (firstName: string, createUrl: string) => ({
    subject: "You're in — let's create your first local SEO page",
    html: trialEmailShell(
      `
      <p>Hi ${firstName},</p>
      <p>Welcome to ImproveSEO! You've already got the technical setup email — this one's just from us, human to human.</p>
      <p>Most local businesses lose customers to competitors simply because they don't have enough content targeting the neighborhoods, services, and search terms people actually search for — and increasingly, ask AI chatbots like ChatGPT and Google's AI answers about. That's what this plugin solves — it generates new, local-search-ready content built to get found both on Google and in AI chatbot answers, without you needing to write it yourself or know anything about SEO.</p>
      <p><strong>One thing to do today:</strong> Log in and generate your first page or post. Takes a few minutes, and you'll see exactly how it's built for local search.</p>
      <p>Stuck or confused? Just reply — a real person reads these.</p>
      `,
      'Create My First Page →',
      createUrl,
    ),
    text: `Hi ${firstName},\n\nWelcome to ImproveSEO! You've already got the technical setup email — this one's just from us, human to human.\n\nMost local businesses lose customers to competitors simply because they don't have enough content targeting the neighborhoods, services, and search terms people actually search for — and increasingly, ask AI chatbots like ChatGPT and Google's AI answers about. That's what this plugin solves — it generates new, local-search-ready content built to get found both on Google and in AI chatbot answers, without you needing to write it yourself or know anything about SEO.\n\nOne thing to do today: Log in and generate your first page or post. Takes a few minutes, and you'll see exactly how it's built for local search.\n\nCreate My First Page: ${createUrl}\n\nStuck or confused? Just reply — a real person reads these.\n\nBest,\nNathan, CEO of ImproveSEO`,
  }),

  // Email 2 — Check-in (Day 3-4)
  trialCheckin: (firstName: string) => ({
    subject: "How's it going so far?",
    html: trialEmailShell(
      `
      <p>Hi ${firstName},</p>
      <p>A few days into your trial — checking in.</p>
      <p>Have you generated your first piece of content yet? Most business owners are surprised how much local detail (neighborhoods, services, common customer phrases) the ImproveSEO builds in automatically — content designed to help you get found on Google and when people ask AI chatbots for recommendations.</p>
      <p>If you haven't started, or aren't sure what to create first, reply and tell us your business type and service area. We'll suggest exactly where to start.</p>
      `,
    ),
    text: `Hi ${firstName},\n\nA few days into your trial — checking in.\n\nHave you generated your first piece of content yet? Most business owners are surprised how much local detail (neighborhoods, services, common customer phrases) the ImproveSEO builds in automatically — content designed to help you get found on Google and when people ask AI chatbots for recommendations.\n\nIf you haven't started, or aren't sure what to create first, reply and tell us your business type and service area. We'll suggest exactly where to start.\n\nBest,\nNathan, CEO of ImproveSEO`,
  }),

  // Email 3 — Trial ending (morning of the last day)
  trialEnding: (firstName: string, upgradeUrl: string) => ({
    subject: 'Your trial wraps up today',
    html: trialEmailShell(
      `
      <p>Hi ${firstName},</p>
      <p>Your 7-day trial ends tonight. Here's a quick recap of what ImproveSEO does for you:</p>
      <ul>
        <li>Generates new, local-search-ready content for your site — no writing or SEO knowledge needed</li>
        <li>Helps you show up for the neighborhoods, services, and search terms your customers are actually searching — including through AI chatbots like ChatGPT, not just Google</li>
      </ul>
      <p><strong>To keep it going:</strong> $25/month, no contract, cancel anytime.</p>
      <p>Questions or on the fence? Reply — happy to help you decide either way.</p>
      `,
      'Keep My Plugin Active →',
      upgradeUrl,
    ),
    text: `Hi ${firstName},\n\nYour 7-day trial ends tonight. Here's a quick recap of what ImproveSEO does for you:\n\n- Generates new, local-search-ready content for your site — no writing or SEO knowledge needed\n- Helps you show up for the neighborhoods, services, and search terms your customers are actually searching — including through AI chatbots like ChatGPT, not just Google\n\nTo keep it going: $25/month, no contract, cancel anytime.\n\nKeep My Plugin Active: ${upgradeUrl}\n\nQuestions or on the fence? Reply — happy to help you decide either way.\n\nBest,\nNathan, CEO of ImproveSEO`,
  }),

  ticketCreated: (ticketId: string, ticketDisplayId: string, subject: string, userName: string, cmsUrl: string) => {
    return {
      subject: `Your Support Ticket Has Been Created - ${ticketDisplayId}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #2c3e50; margin: 0; padding: 0; background: #f5f7fa; }
            .wrapper { background: #f5f7fa; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
            .header { background: linear-gradient(135deg, #1c7293 0%, #2ec5b6 100%); padding: 50px 30px; text-align: center; position: relative; overflow: hidden; }
            .header::before { content: ''; position: absolute; top: -50%; right: -10%; width: 300px; height: 300px; background: rgba(255, 122, 89, 0.1); border-radius: 50%; }
            .header::after { content: ''; position: absolute; top: 50%; left: -5%; width: 200px; height: 200px; background: rgba(255, 255, 255, 0.05); border-radius: 50%; }
            .header-content { position: relative; z-index: 1; }
            .logo { max-width: 100px; height: auto; margin-bottom: 15px; }
            .header h1 { margin: 10px 0 0 0; color: white; font-size: 28px; font-weight: 700; letter-spacing: -0.5px; }
            .header-subtext { color: rgba(255,255,255,0.9); font-size: 14px; margin-top: 8px; }
            .content { padding: 45px 30px; }
            .content p { margin: 12px 0; color: #555; font-size: 15px; line-height: 1.7; }
            .content p:first-child { font-size: 16px; font-weight: 500; color: #1c7293; }
            .ticket-info { background: linear-gradient(135deg, rgba(44, 185, 255, 0.05) 0%, rgba(46, 197, 182, 0.05) 100%); padding: 25px; border-radius: 8px; margin: 30px 0; border-left: 5px solid #ff7a59; }
            .ticket-info p { margin: 10px 0; font-size: 14px; }
            .ticket-info strong { color: #1c7293; font-weight: 600; }
            .ticket-id { font-family: 'Courier New', monospace; font-weight: 700; color: #ff7a59; font-size: 18px; letter-spacing: 1px; }
            .ticket-subject { color: #2c3e50; font-weight: 500; }
            .info-text { font-size: 13px; color: #888; margin-top: 12px !important; font-style: italic; }
            .section-title { font-size: 16px; font-weight: 600; color: #1c7293; margin: 25px 0 15px 0; }
            .cta-button { display: inline-block; background: #1c7293; color: white; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 15px; margin: 25px 0; transition: all 0.3s ease; box-shadow: 0 4px 12px rgba(28, 114, 147, 0.3); }
            .cta-button:hover { background: #165d78; transform: translateY(-2px); box-shadow: 0 6px 16px rgba(28, 114, 147, 0.4); }
            .cta-container { text-align: center; margin: 35px 0; }
            .divider { border-top: 2px solid #f0f0f0; margin: 35px 0; }
            .footer { background: linear-gradient(135deg, #f8f9fa 0%, #f0f2f5 100%); padding: 30px; text-align: center; border-top: 1px solid #eee; }
            .footer p { margin: 5px 0; font-size: 12px; color: #888; }
            .footer-brand { font-weight: 600; color: #1c7293; }
            .badge { display: inline-block; background: #2ec5b6; color: white; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div class="container">
              <div class="header">
                <div class="header-content">
                  <img src="https://improveseoplugin.com/wp-content/uploads/2025/10/logo.svg" alt="ImproveSEO Logo" class="logo">
                  <h1>Ticket Received</h1>
                  <p class="header-subtext">We're on it!</p>
                </div>
              </div>
              
              <div class="content">
                <p>Hi ${userName},</p>
                
                <p>Thank you for reaching out to ImproveSEO support! We've successfully received your support ticket and it's now in our system. Our team will review your request and get back to you shortly.</p>
                
                <div class="ticket-info">
                  <p><strong>Ticket ID:</strong> <span class="ticket-id">${ticketDisplayId}</span></p>
                  <p><strong>Subject:</strong> <span class="ticket-subject">${subject}</span></p>
                  <p class="info-text">Save your ticket ID for future reference</p>
                </div>
                
                <p class="section-title">What happens next?</p>
                <p>- Your ticket is queued for review<br>- Our team will respond within 24 hours<br>- You'll receive email updates on progress<br>- Track everything in your support dashboard</p>
                
                <div class="cta-container">
                  <a href="${cmsUrl}/support/tickets/${ticketId}" class="cta-button" style="color: #ffffff !important; text-decoration: none;">View Your Ticket</a>
                </div>
                
                <p style="font-size: 13px; color: #888; text-align: center; margin-top: 20px;">Click the button above to view your ticket, add files, or provide additional details.</p>
              </div>
              
              <div class="footer">
                <p><span class="footer-brand">ImproveSEO Support</span></p>
                <p>© 2026 ImproveSEO. All rights reserved.</p>
                <p style="margin-top: 10px; color: #999; font-size: 11px;">Please don't reply to this email. Use your support dashboard instead.</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
Support Ticket Created

Hi ${userName},

Thank you for reaching out to ImproveSEO support! We've successfully received your support ticket.

Ticket ID: ${ticketDisplayId}
Subject: ${subject}

View your ticket: ${cmsUrl}/support/tickets/${ticketId}

What happens next?
- Your ticket is queued for review
- Our team will respond within 24 hours
- You'll receive email updates on progress

© 2026 ImproveSEO
      `
    };
  },

  ticketReplied: (ticketId: string, ticketDisplayId: string, message: string, senderName: string, cmsUrl: string) => {
    return {
      subject: `New Reply on Your Ticket - ${ticketDisplayId}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #2c3e50; margin: 0; padding: 0; background: #f5f7fa; }
            .wrapper { background: #f5f7fa; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
            .header { background: linear-gradient(135deg, #1c7293 0%, #2ec5b6 100%); padding: 50px 30px; text-align: center; position: relative; overflow: hidden; }
            .header::before { content: ''; position: absolute; top: -50%; right: -10%; width: 300px; height: 300px; background: rgba(255, 122, 89, 0.1); border-radius: 50%; }
            .header::after { content: ''; position: absolute; top: 50%; left: -5%; width: 200px; height: 200px; background: rgba(255, 255, 255, 0.05); border-radius: 50%; }
            .header-content { position: relative; z-index: 1; }
            .logo { max-width: 100px; height: auto; margin-bottom: 15px; }
            .header h1 { margin: 10px 0 0 0; color: white; font-size: 28px; font-weight: 700; letter-spacing: -0.5px; }
            .header-subtext { color: rgba(255,255,255,0.9); font-size: 14px; margin-top: 8px; }
            .content { padding: 45px 30px; }
            .content p { margin: 12px 0; color: #555; font-size: 15px; line-height: 1.7; }
            .sender-highlight { color: #ff7a59; font-weight: 700; }
            .message-box { background: linear-gradient(135deg, rgba(255, 122, 89, 0.08) 0%, rgba(46, 197, 182, 0.08) 100%); padding: 30px; border-radius: 8px; margin: 25px 0; border-left: 5px solid #2ec5b6; font-size: 14px; }
            .message-box p { margin: 0; color: #333; white-space: pre-wrap; word-wrap: break-word; line-height: 1.7; }
            .sender-label { font-size: 12px; color: #ff7a59; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
            .ticket-ref { display: inline-block; background: #f0f2f5; padding: 10px 15px; border-radius: 6px; font-family: 'Courier New', monospace; color: #1c7293; font-weight: 700; font-size: 12px; margin-top: 20px; }
            .cta-button { display: inline-block; background: #1c7293; color: white; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 15px; margin: 25px 0; transition: all 0.3s ease; box-shadow: 0 4px 12px rgba(28, 114, 147, 0.3); }
            .cta-button:hover { background: #165d78; transform: translateY(-2px); box-shadow: 0 6px 16px rgba(28, 114, 147, 0.4); }
            .cta-container { text-align: center; margin: 35px 0; }
            .badge { display: inline-block; background: #2ec5b6; color: white; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; margin-right: 8px; }
            .footer { background: linear-gradient(135deg, #f8f9fa 0%, #f0f2f5 100%); padding: 30px; text-align: center; border-top: 1px solid #eee; }
            .footer p { margin: 5px 0; font-size: 12px; color: #888; }
            .footer-brand { font-weight: 600; color: #1c7293; }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div class="container">
              <div class="header">
                <div class="header-content">
                  <img src="https://improveseoplugin.com/wp-content/uploads/2025/10/logo.svg" alt="ImproveSEO Logo" class="logo">
                  <h1>You've Got a Reply</h1>
                  <p class="header-subtext">Check your support ticket</p>
                </div>
              </div>
              
              <div class="content">
                <p>Hi there,</p>
                
                <p><span class="badge">NEW REPLY</span><span class="sender-highlight">${senderName}</span> has responded to your support ticket:</p>
                
                <div class="message-box">
                  <div class="sender-label">Support Team Response</div>
                  <p>${message.substring(0, 500)}${message.length > 500 ? '...' : ''}</p>
                </div>
                
                <p style="font-size: 14px; color: #666;">To see the full conversation and add your reply, click the button below:</p>
                
                <div class="cta-container">
                  <a href="${cmsUrl}/support/tickets/${ticketId}" class="cta-button" style="color: #ffffff !important; text-decoration: none;">View Conversation</a>
                </div>
                
                <div class="ticket-ref">Ticket: ${ticketDisplayId}</div>
                
                <p style="font-size: 13px; color: #888; margin-top: 20px; padding-top: 20px; border-top: 1px solid #eee;">All ticket communication stays in your support dashboard for easy reference.</p>
              </div>
              
              <div class="footer">
                <p><span class="footer-brand">ImproveSEO Support</span></p>
                <p>© 2026 ImproveSEO. All rights reserved.</p>
                <p style="margin-top: 10px; color: #999; font-size: 11px;">Please don't reply to this email. Use your support dashboard instead.</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
New Support Message

Hi there,

${senderName} has replied to your support ticket ${ticketDisplayId}:

${message.substring(0, 500)}${message.length > 500 ? '...' : ''}

View the full conversation at: ${cmsUrl}/support/tickets/${ticketId}

© 2026 ImproveSEO
      `
    };
  },

  ticketClosed: (ticketId: string, ticketDisplayId: string, reason: string, cmsUrl: string) => {
    return {
      subject: `Your Ticket Has Been Closed - ${ticketDisplayId}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #2c3e50; margin: 0; padding: 0; background: #f5f7fa; }
            .wrapper { background: #f5f7fa; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
            .header { background: linear-gradient(135deg, #1c7293 0%, #2ec5b6 100%); padding: 50px 30px; text-align: center; position: relative; overflow: hidden; }
            .header::before { content: ''; position: absolute; top: -50%; right: -10%; width: 300px; height: 300px; background: rgba(255, 122, 89, 0.1); border-radius: 50%; }
            .header::after { content: ''; position: absolute; top: 50%; left: -5%; width: 200px; height: 200px; background: rgba(255, 255, 255, 0.05); border-radius: 50%; }
            .header-content { position: relative; z-index: 1; }
            .logo { max-width: 100px; height: auto; margin-bottom: 15px; }
            .header h1 { margin: 10px 0 0 0; color: white; font-size: 28px; font-weight: 700; letter-spacing: -0.5px; }
            .header-subtext { color: rgba(255,255,255,0.9); font-size: 14px; margin-top: 8px; }
            .content { padding: 45px 30px; }
            .content p { margin: 12px 0; color: #555; font-size: 15px; line-height: 1.7; }
            .status-badge { display: inline-block; background: #2ec5b6; color: white; padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 700; margin-top: 12px; }
            .status-box { background: linear-gradient(135deg, rgba(46, 197, 182, 0.1) 0%, rgba(255, 122, 89, 0.05) 100%); padding: 30px; border-radius: 8px; margin: 25px 0; border-left: 5px solid #2ec5b6; }
            .status-box h3 { margin: 0 0 15px 0; color: #1c7293; font-size: 16px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
            .status-box p { margin: 0; color: #333; font-size: 14px; line-height: 1.7; white-space: pre-wrap; word-wrap: break-word; }
            .ticket-ref { display: inline-block; background: #f0f2f5; padding: 10px 15px; border-radius: 6px; font-family: 'Courier New', monospace; color: #1c7293; font-weight: 700; font-size: 12px; margin-top: 20px; }
            .cta-button { display: inline-block; background: #1c7293; color: white; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 15px; margin: 25px auto; transition: all 0.3s ease; box-shadow: 0 4px 12px rgba(28, 114, 147, 0.3); }
            .cta-button:hover { background: #165d78; transform: translateY(-2px); box-shadow: 0 6px 16px rgba(28, 114, 147, 0.4); }
            .cta-container { text-align: center; margin: 35px 0; }
            .checkmark { font-size: 48px; margin-bottom: 15px; }
            .footer { background: linear-gradient(135deg, #f8f9fa 0%, #f0f2f5 100%); padding: 30px; text-align: center; border-top: 1px solid #eee; }
            .footer p { margin: 5px 0; font-size: 12px; color: #888; }
            .footer-brand { font-weight: 600; color: #1c7293; }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div class="container">
              <div class="header">
                <div class="header-content">
                  <img src="https://improveseoplugin.com/wp-content/uploads/2025/10/logo.svg" alt="ImproveSEO Logo" class="logo">
                  <h1>Ticket Resolved</h1>
                  <p class="header-subtext">Your issue has been resolved</p>
                </div>
              </div>
              
              <div class="content">
                <div style="text-align: center; margin: 30px 0;">
                  <div class="checkmark">✓</div>
                  <p style="font-size: 16px; font-weight: 700; color: #2ec5b6; margin: 0;">Support ticket closed</p>
                </div>
                
                <p>We're pleased to let you know that your support ticket has been resolved!</p>
                
                <div class="status-box">
                  <h3>Resolution Summary</h3>
                  <p>${reason || 'Your issue has been successfully addressed by our support team.'}</p>
                </div>
                
                <p style="font-size: 14px; color: #666; margin-top: 25px;">If you have any additional questions or concerns related to this ticket, feel free to reopen it in your support dashboard:</p>
                
                <div class="cta-container">
                  <a href="${cmsUrl}/support/tickets/${ticketId}" class="cta-button" style="color: #ffffff !important; text-decoration: none;">View Ticket Details</a>
                </div>
                
                <div class="ticket-ref">Ticket: ${ticketDisplayId}</div>
                
                <p style="font-size: 13px; color: #888; margin-top: 25px; padding-top: 20px; border-top: 1px solid #eee;">We appreciate your patience and feedback. Your input helps us improve ImproveSEO. Thank you for being a valued customer!</p>
              </div>
              
              <div class="footer">
                <p><span class="footer-brand">ImproveSEO Support</span></p>
                <p>© 2026 ImproveSEO. All rights reserved.</p>
                <p style="margin-top: 10px; color: #999; font-size: 11px;">Don't reply to this email. Access your support dashboard for further assistance.</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
Ticket Closed

Hi there,

Your support ticket has been resolved and closed.

Ticket ID: ${ticketDisplayId}
Status: CLOSED
Resolution: ${reason}

View your ticket: ${cmsUrl}/support/tickets/${ticketId}

If the issue returns or you have follow-up questions, you can comment on this ticket or create a new one.

Thank you for choosing ImproveSEO!

© 2026 ImproveSEO
      `
    };
  },

  bulkTaskCreated: (userName: string, taskName: string, totalKeywords: number, websiteDomain: string, projectUrl: string) => {
    return {
      subject: `Bulk Project Created - ${taskName}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #2c3e50; margin: 0; padding: 0; background: #f5f7fa; }
            .wrapper { background: #f5f7fa; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
            .header { background: linear-gradient(135deg, #1c7293 0%, #2ec5b6 100%); padding: 50px 30px; text-align: center; position: relative; overflow: hidden; }
            .header::before { content: ''; position: absolute; top: -50%; right: -10%; width: 300px; height: 300px; background: rgba(255, 122, 89, 0.1); border-radius: 50%; }
            .header::after { content: ''; position: absolute; top: 50%; left: -5%; width: 200px; height: 200px; background: rgba(255, 255, 255, 0.05); border-radius: 50%; }
            .header-content { position: relative; z-index: 1; }
            .logo { max-width: 100px; height: auto; margin-bottom: 15px; }
            .header h1 { margin: 10px 0 0 0; color: white; font-size: 28px; font-weight: 700; letter-spacing: -0.5px; }
            .header-subtext { color: rgba(255,255,255,0.9); font-size: 14px; margin-top: 8px; }
            .content { padding: 45px 30px; }
            .content p { margin: 12px 0; color: #555; font-size: 15px; line-height: 1.7; }
            .content p:first-child { font-size: 16px; font-weight: 500; color: #1c7293; }
            .task-info { background: linear-gradient(135deg, rgba(44, 185, 255, 0.05) 0%, rgba(46, 197, 182, 0.05) 100%); padding: 25px; border-radius: 8px; margin: 30px 0; border-left: 5px solid #ff7a59; }
            .task-info p { margin: 10px 0; font-size: 14px; }
            .task-info strong { color: #1c7293; font-weight: 600; }
            .task-name { color: #ff7a59; font-weight: 700; font-size: 18px; }
            .cta-button { display: inline-block; background: #1c7293; color: white; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 15px; margin: 25px 0; box-shadow: 0 4px 12px rgba(28, 114, 147, 0.3); }
            .cta-container { text-align: center; margin: 35px 0; }
            .footer { background: linear-gradient(135deg, #f8f9fa 0%, #f0f2f5 100%); padding: 30px; text-align: center; border-top: 1px solid #eee; }
            .footer p { margin: 5px 0; font-size: 12px; color: #888; }
            .footer-brand { font-weight: 600; color: #1c7293; }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div class="container">
              <div class="header">
                <div class="header-content">
                  <img src="https://improveseoplugin.com/wp-content/uploads/2025/10/logo.svg" alt="ImproveSEO Logo" class="logo">
                  <h1>Bulk Project Created</h1>
                  <p class="header-subtext">Your content is queued for generation</p>
                </div>
              </div>

              <div class="content">
                <p>Hi ${userName},</p>

                <p>Your bulk content project has been successfully created and is now queued for processing on <strong>${websiteDomain}</strong>.</p>

                <div class="task-info">
                  <p><strong>Project Name:</strong> <span class="task-name">${taskName}</span></p>
                  <p><strong>Total Keywords:</strong> ${totalKeywords}</p>
                  <p><strong>Website:</strong> ${websiteDomain}</p>
                  <p style="font-size: 13px; color: #888; margin-top: 12px; font-style: italic;">Posts will be generated automatically by the cron scheduler</p>
                </div>

                <p>You'll receive another email when all posts have been generated.</p>

                <div class="cta-container">
                  <a href="${projectUrl}" class="cta-button" style="color: #ffffff !important; text-decoration: none;">View Your Project</a>
                </div>
              </div>

              <div class="footer">
                <p><span class="footer-brand">ImproveSEO</span></p>
                <p>© 2026 ImproveSEO. All rights reserved.</p>
                <p style="margin-top: 10px; color: #999; font-size: 11px;">This is an automated notification from your ImproveSEO plugin.</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `Bulk Project Created

Hi ${userName},

Your bulk content project has been created and queued for processing.

Project Name: ${taskName}
Total Keywords: ${totalKeywords}
Website: ${websiteDomain}

Posts will be generated automatically by the cron scheduler. You'll receive another email when all posts have been generated.

View Your Project: ${projectUrl}

© 2026 ImproveSEO
      `
    };
  },

  // ── Billing emails (bug 11) ───────────────────────────────────────────────
  // These did not exist. credits.md guessed the missing upgrade/cancellation
  // emails were an environment artifact (Stripe webhooks not reaching a local
  // site), but there were no billing templates and no send calls anywhere in
  // the Stripe layer — so no email would have gone out on production either.
  //
  // Money emails are deliberately plain: a receipt-style summary with the exact
  // figures, no marketing. A billing email that buries the amount is the thing
  // people open a support ticket about.

  /** Sent after a successful plan change. `amountLine` is pre-formatted money. */
  subscriptionUpgraded: (
    firstName: string,
    planName: string,
    amountLine: string,
    nextBillingDate: string,
    creditsSummary: string,
    billingUrl: string,
  ) => ({
    subject: `Your ImproveSEO plan is now ${planName}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #2c3e50; margin: 0; padding: 0; background: #f5f7fa; }
          .wrapper { background: #f5f7fa; padding: 22px; }
          .container { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
          .header { background: linear-gradient(135deg, #1c7293 0%, #2ec5b6 100%); padding: 36px 30px; text-align: center; }
          .header h1 { margin: 0; color: #fff; font-size: 22px; font-weight: 700; }
          .content { padding: 32px 30px; }
          .content p { margin: 0 0 14px; font-size: 15px; color: #333; }
          .facts { background: #f0f7f9; border-radius: 8px; padding: 16px 18px; margin: 18px 0; }
          .facts p { margin: 6px 0; font-size: 14px; color: #1c7293; }
          .cta { text-align: center; margin: 26px 0 6px; }
          .cta a { display: inline-block; background: #1c7293; color: #fff !important; text-decoration: none; padding: 13px 30px; border-radius: 8px; font-weight: 700; font-size: 15px; }
          .footer { background: #f8f9fa; padding: 22px; text-align: center; border-top: 1px solid #eee; }
          .footer p { margin: 3px 0; font-size: 11px; color: #9aa0a6; }
        </style>
      </head>
      <body><div class="wrapper"><div class="container">
        <div class="header"><h1>Your plan has been updated</h1></div>
        <div class="content">
          <p>Hi ${firstName},</p>
          <p>You're now on the <strong>${planName}</strong> plan.</p>
          <div class="facts">
            <p><strong>Charged today:</strong> ${amountLine}</p>
            <p><strong>Credits added:</strong> ${creditsSummary}</p>
            <p><strong>Next billing date:</strong> ${nextBillingDate}</p>
          </div>
          <p>Your new credits are available right now.</p>
          <div class="cta"><a href="${billingUrl}">View Billing</a></div>
        </div>
        <div class="footer">
          <p>This is an automated billing notification from ImproveSEO.</p>
          <p>© 2026 ImproveSEO. All rights reserved.</p>
        </div>
      </div></div></body>
      </html>
    `,
    text: `Hi ${firstName},\n\nYou're now on the ${planName} plan.\n\nCharged today: ${amountLine}\nCredits added: ${creditsSummary}\nNext billing date: ${nextBillingDate}\n\nYour new credits are available right now.\n\nView billing: ${billingUrl}\n\n© 2026 ImproveSEO`,
  }),

  /** Sent when a subscription is set to cancel at period end. */
  subscriptionCancelled: (
    firstName: string,
    planName: string,
    accessUntil: string,
    billingUrl: string,
  ) => ({
    subject: 'Your ImproveSEO subscription has been cancelled',
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #2c3e50; margin: 0; padding: 0; background: #f5f7fa; }
          .wrapper { background: #f5f7fa; padding: 22px; }
          .container { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
          .header { background: #64748b; padding: 36px 30px; text-align: center; }
          .header h1 { margin: 0; color: #fff; font-size: 22px; font-weight: 700; }
          .content { padding: 32px 30px; }
          .content p { margin: 0 0 14px; font-size: 15px; color: #333; }
          .facts { background: #f4f5f7; border-radius: 8px; padding: 16px 18px; margin: 18px 0; }
          .facts p { margin: 6px 0; font-size: 14px; color: #475569; }
          .cta { text-align: center; margin: 26px 0 6px; }
          .cta a { display: inline-block; background: #1c7293; color: #fff !important; text-decoration: none; padding: 13px 30px; border-radius: 8px; font-weight: 700; font-size: 15px; }
          .footer { background: #f8f9fa; padding: 22px; text-align: center; border-top: 1px solid #eee; }
          .footer p { margin: 3px 0; font-size: 11px; color: #9aa0a6; }
        </style>
      </head>
      <body><div class="wrapper"><div class="container">
        <div class="header"><h1>Subscription cancelled</h1></div>
        <div class="content">
          <p>Hi ${firstName},</p>
          <p>Your <strong>${planName}</strong> subscription has been cancelled. You have not been charged again.</p>
          <div class="facts">
            <p><strong>Access continues until:</strong> ${accessUntil}</p>
            <p>After that date your account moves to the free tier. Any credits you purchased separately remain yours.</p>
          </div>
          <p>Changed your mind? You can resubscribe at any time and pick up where you left off.</p>
          <div class="cta"><a href="${billingUrl}">Manage Subscription</a></div>
        </div>
        <div class="footer">
          <p>This is an automated billing notification from ImproveSEO.</p>
          <p>© 2026 ImproveSEO. All rights reserved.</p>
        </div>
      </div></div></body>
      </html>
    `,
    text: `Hi ${firstName},\n\nYour ${planName} subscription has been cancelled. You have not been charged again.\n\nAccess continues until: ${accessUntil}\nAfter that date your account moves to the free tier. Any credits you purchased separately remain yours.\n\nChanged your mind? You can resubscribe at any time:\n${billingUrl}\n\n© 2026 ImproveSEO`,
  }),

  // ── Lifecycle notifications (round 2, bugs 16 & 17) ───────────────────────
  //
  // ⚠️ PLACEHOLDER COPY — the client marked the wording "coming soon".
  // Everything else is finished: the triggers, the scheduling, the dedupe
  // guards and every dynamic value below are wired and working. To ship the
  // real wording, edit ONLY the marked strings in these two templates; no
  // trigger logic needs to change.
  //
  // The dynamic data available to the copywriter is already interpolated:
  // first name, per-type credit numbers, the total, the "pieces of content"
  // translation, and the relevant date.

  /** Credits approaching their cycle reset. */
  creditsExpiringSoon: (
    firstName: string,
    daysUntilReset: number,
    credits: { content: number; images: number; keywords: number; total: number },
    piecesRemaining: number,
    resetDate: string,
    dashboardUrl: string,
  ) => ({
    // ⚠️ PLACEHOLDER SUBJECT
    subject: `Your ImproveSEO credits reset in ${daysUntilReset} ${daysUntilReset === 1 ? 'day' : 'days'}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #2c3e50; margin: 0; padding: 0; background: #f5f7fa; }
          .wrapper { background: #f5f7fa; padding: 22px; }
          .container { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
          .header { background: linear-gradient(135deg, #1c7293 0%, #2ec5b6 100%); padding: 36px 30px; text-align: center; }
          .header h1 { margin: 0; color: #fff; font-size: 22px; font-weight: 700; }
          .content { padding: 32px 30px; }
          .content p { margin: 0 0 14px; font-size: 15px; color: #333; }
          .facts { background: #f0f7f9; border-radius: 8px; padding: 16px 18px; margin: 18px 0; }
          .facts p { margin: 6px 0; font-size: 14px; color: #1c7293; }
          .cta { text-align: center; margin: 26px 0 6px; }
          .cta a { display: inline-block; background: #1c7293; color: #fff !important; text-decoration: none; padding: 13px 30px; border-radius: 8px; font-weight: 700; font-size: 15px; }
          .footer { background: #f8f9fa; padding: 22px; text-align: center; border-top: 1px solid #eee; }
          .footer p { margin: 3px 0; font-size: 11px; color: #9aa0a6; }
        </style>
      </head>
      <body><div class="wrapper"><div class="container">
        <div class="header"><h1>Your credits reset soon</h1></div>
        <div class="content">
          <!-- ⚠️ PLACEHOLDER COPY BELOW — replace with final wording -->
          <p>Hi ${firstName},</p>
          <p>Your plan credits reset on <strong>${resetDate}</strong>, in ${daysUntilReset} ${daysUntilReset === 1 ? 'day' : 'days'}. Unused plan credits don't roll over, so it's worth putting them to work first.</p>
          <div class="facts">
            <p><strong>Content:</strong> ${credits.content}</p>
            <p><strong>Images:</strong> ${credits.images}</p>
            <p><strong>Keywords:</strong> ${credits.keywords}</p>
            <p><strong>That's roughly ${piecesRemaining} ${piecesRemaining === 1 ? 'piece' : 'pieces'} of SEO content with AI images.</strong></p>
          </div>
          <p>Any credits you purchased separately are unaffected — those stay in your account.</p>
          <!-- ⚠️ END PLACEHOLDER COPY -->
          <div class="cta"><a href="${dashboardUrl}">Generate Content</a></div>
        </div>
        <div class="footer">
          <p>You're receiving this because you have an active ImproveSEO account.</p>
          <p>© 2026 ImproveSEO. All rights reserved.</p>
        </div>
      </div></div></body>
      </html>
    `,
    text: `Hi ${firstName},\n\nYour plan credits reset on ${resetDate}, in ${daysUntilReset} day(s). Unused plan credits don't roll over, so it's worth putting them to work first.\n\nContent: ${credits.content}\nImages: ${credits.images}\nKeywords: ${credits.keywords}\nThat's roughly ${piecesRemaining} piece(s) of SEO content with AI images.\n\nAny credits you purchased separately are unaffected.\n\nGenerate content: ${dashboardUrl}\n\n© 2026 ImproveSEO`,
  }),

  /** No activity for a while; includes what they still have available. */
  inactivityWithCredits: (
    firstName: string,
    daysInactive: number,
    credits: { content: number; images: number; keywords: number; total: number },
    piecesRemaining: number,
    dashboardUrl: string,
  ) => ({
    // ⚠️ PLACEHOLDER SUBJECT
    subject: 'Your ImproveSEO credits are waiting',
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #2c3e50; margin: 0; padding: 0; background: #f5f7fa; }
          .wrapper { background: #f5f7fa; padding: 22px; }
          .container { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
          .header { background: linear-gradient(135deg, #1c7293 0%, #2ec5b6 100%); padding: 36px 30px; text-align: center; }
          .header h1 { margin: 0; color: #fff; font-size: 22px; font-weight: 700; }
          .content { padding: 32px 30px; }
          .content p { margin: 0 0 14px; font-size: 15px; color: #333; }
          .facts { background: #f0f7f9; border-radius: 8px; padding: 16px 18px; margin: 18px 0; }
          .facts p { margin: 6px 0; font-size: 14px; color: #1c7293; }
          .cta { text-align: center; margin: 26px 0 6px; }
          .cta a { display: inline-block; background: #1c7293; color: #fff !important; text-decoration: none; padding: 13px 30px; border-radius: 8px; font-weight: 700; font-size: 15px; }
          .footer { background: #f8f9fa; padding: 22px; text-align: center; border-top: 1px solid #eee; }
          .footer p { margin: 3px 0; font-size: 11px; color: #9aa0a6; }
        </style>
      </head>
      <body><div class="wrapper"><div class="container">
        <div class="header"><h1>Your credits are still here</h1></div>
        <div class="content">
          <!-- ⚠️ PLACEHOLDER COPY BELOW — replace with final wording -->
          <p>Hi ${firstName},</p>
          <p>It's been about ${daysInactive} days since you last generated anything. Your credits are still sitting in your account, ready to use.</p>
          <div class="facts">
            <p><strong>Content:</strong> ${credits.content}</p>
            <p><strong>Images:</strong> ${credits.images}</p>
            <p><strong>Keywords:</strong> ${credits.keywords}</p>
            <p><strong>That's roughly ${piecesRemaining} ${piecesRemaining === 1 ? 'piece' : 'pieces'} of SEO content with AI images.</strong></p>
          </div>
          <p>Picking one service and one location you'd like to rank for is usually enough to get a page out in a few minutes.</p>
          <!-- ⚠️ END PLACEHOLDER COPY -->
          <div class="cta"><a href="${dashboardUrl}">Create a Page</a></div>
        </div>
        <div class="footer">
          <p>You're receiving this because you have an active ImproveSEO account.</p>
          <p>© 2026 ImproveSEO. All rights reserved.</p>
        </div>
      </div></div></body>
      </html>
    `,
    text: `Hi ${firstName},\n\nIt's been about ${daysInactive} days since you last generated anything. Your credits are still sitting in your account, ready to use.\n\nContent: ${credits.content}\nImages: ${credits.images}\nKeywords: ${credits.keywords}\nThat's roughly ${piecesRemaining} piece(s) of SEO content with AI images.\n\nPicking one service and one location you'd like to rank for is usually enough to get a page out in a few minutes.\n\nCreate a page: ${dashboardUrl}\n\n© 2026 ImproveSEO`,
  }),

  bulkTaskCompleted: (userName: string, taskName: string, totalGenerated: number, totalFailed: number, websiteDomain: string, projectUrl: string) => {
    const totalTasks = totalGenerated + totalFailed;
    const allFailed = totalGenerated === 0 && totalFailed > 0;
    const statusText = allFailed ? 'Bulk Project Finished (with issues)' : 'Bulk Project Complete';

    return {
      subject: `${statusText} - ${taskName}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #2c3e50; margin: 0; padding: 0; background: #f5f7fa; }
            .wrapper { background: #f5f7fa; padding: 20px; }
            .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
            .header { background: linear-gradient(135deg, #1c7293 0%, #2ec5b6 100%); padding: 50px 30px; text-align: center; position: relative; overflow: hidden; }
            .header::before { content: ''; position: absolute; top: -50%; right: -10%; width: 300px; height: 300px; background: rgba(255, 122, 89, 0.1); border-radius: 50%; }
            .header::after { content: ''; position: absolute; top: 50%; left: -5%; width: 200px; height: 200px; background: rgba(255, 255, 255, 0.05); border-radius: 50%; }
            .header-content { position: relative; z-index: 1; }
            .logo { max-width: 100px; height: auto; margin-bottom: 15px; }
            .header h1 { margin: 10px 0 0 0; color: white; font-size: 28px; font-weight: 700; letter-spacing: -0.5px; }
            .header-subtext { color: rgba(255,255,255,0.9); font-size: 14px; margin-top: 8px; }
            .content { padding: 45px 30px; }
            .content p { margin: 12px 0; color: #555; font-size: 15px; line-height: 1.7; }
            .content p:first-child { font-size: 16px; font-weight: 500; color: #1c7293; }
            .stats-grid { display: flex; gap: 15px; margin: 30px 0; }
            .stat-card { flex: 1; background: #f8f9fa; border-radius: 8px; padding: 20px; text-align: center; }
            .stat-number { font-size: 28px; font-weight: 700; color: #1c7293; display: block; }
            .stat-label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 5px; display: block; }
            .stat-card.success .stat-number { color: #2ec5b6; }
            .stat-card.failed .stat-number { color: #e74c3c; }
            .task-info { background: linear-gradient(135deg, rgba(44, 185, 255, 0.05) 0%, rgba(46, 197, 182, 0.05) 100%); padding: 25px; border-radius: 8px; margin: 30px 0; border-left: 5px solid #2ec5b6; }
            .task-info p { margin: 10px 0; font-size: 14px; }
            .task-info strong { color: #1c7293; font-weight: 600; }
            .task-name { color: #ff7a59; font-weight: 700; font-size: 18px; }
            .cta-button { display: inline-block; background: #1c7293; color: white; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 15px; margin: 25px 0; box-shadow: 0 4px 12px rgba(28, 114, 147, 0.3); }
            .cta-container { text-align: center; margin: 35px 0; }
            .footer { background: linear-gradient(135deg, #f8f9fa 0%, #f0f2f5 100%); padding: 30px; text-align: center; border-top: 1px solid #eee; }
            .footer p { margin: 5px 0; font-size: 12px; color: #888; }
            .footer-brand { font-weight: 600; color: #1c7293; }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div class="container">
              <div class="header">
                <div class="header-content">
                  <img src="https://improveseoplugin.com/wp-content/uploads/2025/10/logo.svg" alt="ImproveSEO Logo" class="logo">
                  <h1>${statusText}</h1>
                  <p class="header-subtext">All tasks have been processed</p>
                </div>
              </div>

              <div class="content">
                <p>Hi ${userName},</p>

                <p>Your bulk content project on <strong>${websiteDomain}</strong> has finished processing.</p>

                <div class="task-info">
                  <p><strong>Project Name:</strong> <span class="task-name">${taskName}</span></p>
                  <p><strong>Website:</strong> ${websiteDomain}</p>
                </div>

                <!--[if mso]>
                <table role="presentation" width="100%"><tr>
                <td width="33%" align="center" style="background:#f8f9fa;border-radius:8px;padding:20px;">
                  <span style="font-size:28px;font-weight:700;color:#1c7293;">${totalTasks}</span><br>
                  <span style="font-size:12px;color:#888;">TOTAL</span>
                </td>
                <td width="33%" align="center" style="background:#f8f9fa;border-radius:8px;padding:20px;">
                  <span style="font-size:28px;font-weight:700;color:#2ec5b6;">${totalGenerated}</span><br>
                  <span style="font-size:12px;color:#888;">GENERATED</span>
                </td>
                <td width="33%" align="center" style="background:#f8f9fa;border-radius:8px;padding:20px;">
                  <span style="font-size:28px;font-weight:700;color:#e74c3c;">${totalFailed}</span><br>
                  <span style="font-size:12px;color:#888;">FAILED</span>
                </td>
                </tr></table>
                <![endif]-->
                <!--[if !mso]><!-->
                <div class="stats-grid">
                  <div class="stat-card">
                    <span class="stat-number">${totalTasks}</span>
                    <span class="stat-label">Total</span>
                  </div>
                  <div class="stat-card success">
                    <span class="stat-number">${totalGenerated}</span>
                    <span class="stat-label">Generated</span>
                  </div>
                  <div class="stat-card failed">
                    <span class="stat-number">${totalFailed}</span>
                    <span class="stat-label">Failed</span>
                  </div>
                </div>
                <!--<![endif]-->

                <div class="cta-container">
                  <a href="${projectUrl}" class="cta-button" style="color: #ffffff !important; text-decoration: none;">View Your Project</a>
                </div>
              </div>

              <div class="footer">
                <p><span class="footer-brand">ImproveSEO</span></p>
                <p>© 2026 ImproveSEO. All rights reserved.</p>
                <p style="margin-top: 10px; color: #999; font-size: 11px;">This is an automated notification from your ImproveSEO plugin.</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `${statusText}

Hi ${userName},

Your bulk content project has finished processing.

Project Name: ${taskName}
Website: ${websiteDomain}

Results:
- Total Tasks: ${totalTasks}
- Generated: ${totalGenerated}
- Failed: ${totalFailed}

View Your Project: ${projectUrl}

© 2026 ImproveSEO
      `
    };
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Billing and lifecycle templates  (BILL-006, BILL-007, BILL-008)
//
// These take ONE payload object, captured from the billing event at enqueue
// time. They do not query, compute or approximate anything: BILL-006 requires
// that "all amounts, dates, and plan names come from the actual billing event
// record". A template that reaches for current state can contradict the invoice
// it is supposed to be confirming.
//
// Every one returns html AND text. A text part is not optional politeness — a
// receipt that renders as an empty message in a plain-text client is a receipt
// the customer did not get.
// ═══════════════════════════════════════════════════════════════════════════

/** Shared shell. Plain, legible, and safe in clients that strip CSS. */
const billingShell = (heading: string, bodyHtml: string, ctaLabel?: string, ctaUrl?: string): string => `
  <!DOCTYPE html>
  <html>
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
  <body style="margin:0;padding:0;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <div style="padding:24px;">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;padding:32px;">
        <h1 style="margin:0 0 20px;font-size:20px;color:#1a1a1a;">${heading}</h1>
        ${bodyHtml}
        ${ctaLabel && ctaUrl ? `<div style="text-align:center;margin:28px 0 8px;"><a href="${ctaUrl}" style="display:inline-block;background:#1C7C73;color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:8px;font-weight:700;">${ctaLabel}</a></div>` : ''}
      </div>
      <div style="max-width:560px;margin:14px auto 0;text-align:center;color:#9aa0a6;font-size:11px;">
        <p>© 2026 ImproveSEO</p>
      </div>
    </div>
  </body>
  </html>
`;

/** One "label: value" row. */
const row = (label: string, value: string): string =>
  `<tr><td style="padding:6px 0;color:#5a5f55;font-size:14px;">${label}</td>` +
  `<td style="padding:6px 0;text-align:right;color:#1a1a1a;font-size:14px;font-weight:600;">${value}</td></tr>`;

export interface PlanChangedPayload {
  firstName: string;
  oldPlan: string | null;
  newPlan: string;
  /** Pre-formatted by the enqueuer from the billing event. Never recomputed. */
  amountCharged: string;
  lines?: Array<{ description: string; amount: string }>;
  nextAmount: string | null;
  nextBillingDate: string | null;
  /** Brand and last four ONLY. */
  cardBrand: string | null;
  cardLast4: string | null;
  billingUrl: string;
  timezone?: string | null;
}

export interface CancelledPayload {
  firstName: string;
  planName: string;
  accessUntil: string;
  creditsNote: string;
  resubscribeUrl: string;
  billingUrl: string;
  timezone?: string | null;
}

export interface CreditExpiryPayload {
  firstName: string;
  expiringAmount: string;
  expiryDate: string;
  remainingAfter: string;
  ctaUrl: string;
  leadTimeLabel: string;
}

export interface InactivityPayload {
  firstName: string;
  creditBalance: string;
  nearestExpiry: string | null;
  planName: string;
  ctaUrl: string;
}

export const billingEmailTemplates = {
  /**
   * Plan change / upgrade receipt. (BILL-006)
   *
   * The proration breakdown mirrors what BILL-003 showed before the click, so
   * the receipt and the confirmation dialog cannot tell different stories.
   */
  billingPlanChanged: (p: PlanChangedPayload) => {
    const tz = p.timezone ? ` (${p.timezone})` : '';
    const card = p.cardLast4 ? `${(p.cardBrand || 'card').toUpperCase()} ending ${p.cardLast4}` : 'your card on file';

    const lineRows = (p.lines ?? []).map((l) => row(l.description, l.amount)).join('');

    const html = billingShell(
      p.oldPlan ? `Your plan changed to ${p.newPlan}` : `Welcome to ${p.newPlan}`,
      `<p style="font-size:15px;color:#333;">Hi ${p.firstName},</p>
       <p style="font-size:15px;color:#333;">${p.oldPlan
        ? `Your subscription has moved from <strong>${p.oldPlan}</strong> to <strong>${p.newPlan}</strong>.`
        : `Your <strong>${p.newPlan}</strong> subscription is active.`}</p>
       <table style="width:100%;border-collapse:collapse;margin:18px 0;border-top:1px solid #eee;">
         ${lineRows}
         ${row('<strong>Charged today</strong>', `<strong>${p.amountCharged}</strong>`)}
         ${p.nextAmount && p.nextBillingDate ? row('Then', `${p.nextAmount} on ${p.nextBillingDate}${tz}`) : ''}
         ${row('Payment method', card)}
       </table>`,
      'View billing history',
      p.billingUrl,
    );

    const text = [
      `Hi ${p.firstName},`,
      '',
      p.oldPlan
        ? `Your subscription has moved from ${p.oldPlan} to ${p.newPlan}.`
        : `Your ${p.newPlan} subscription is active.`,
      '',
      ...(p.lines ?? []).map((l) => `${l.description}: ${l.amount}`),
      `Charged today: ${p.amountCharged}`,
      ...(p.nextAmount && p.nextBillingDate ? [`Then ${p.nextAmount} on ${p.nextBillingDate}${tz}`] : []),
      `Payment method: ${card}`,
      '',
      `View your billing history: ${p.billingUrl}`,
      '',
      '© 2026 ImproveSEO',
    ].join('\n');

    return {
      subject: p.oldPlan ? `Your plan changed to ${p.newPlan}` : `Your ${p.newPlan} subscription is active`,
      html,
      text,
    };
  },

  /** Cancellation confirmation. (BILL-006) */
  billingCancelled: (p: CancelledPayload) => {
    const tz = p.timezone ? ` (${p.timezone})` : '';

    const html = billingShell(
      'Your subscription is scheduled to end',
      `<p style="font-size:15px;color:#333;">Hi ${p.firstName},</p>
       <p style="font-size:15px;color:#333;">Your <strong>${p.planName}</strong> subscription has been cancelled.
       You keep full access until <strong>${p.accessUntil}${tz}</strong>.</p>
       <p style="font-size:15px;color:#333;">${p.creditsNote}</p>
       <p style="font-size:15px;color:#333;">Changed your mind? You can reactivate any time before that date and nothing will be charged.</p>`,
      'Reactivate my plan',
      p.resubscribeUrl,
    );

    const text = [
      `Hi ${p.firstName},`,
      '',
      `Your ${p.planName} subscription has been cancelled.`,
      `You keep full access until ${p.accessUntil}${tz}.`,
      '',
      p.creditsNote,
      '',
      `Changed your mind? Reactivate any time before that date: ${p.resubscribeUrl}`,
      `Billing history: ${p.billingUrl}`,
      '',
      '© 2026 ImproveSEO',
    ].join('\n');

    return { subject: `Your ${p.planName} subscription ends ${p.accessUntil}`, html, text };
  },

  /**
   * ⚠️ PLACEHOLDER COPY — BILL-007. Final marketing wording is pending.
   *
   * FOR THE COPY OWNER: replace only the strings in this function. Every
   * variable you can use is on the CreditExpiryPayload interface above, and all
   * of them are already computed and passed in. No logic changes are required
   * to swap this text — that is the point of the ticket.
   */
  creditsExpiringPlaceholder: (p: CreditExpiryPayload) => {
    const html = billingShell(
      '[PLACEHOLDER] Your credits expire soon',
      `<p style="font-size:15px;color:#333;">Hi ${p.firstName},</p>
       <p style="font-size:15px;color:#333;">[PLACEHOLDER COPY — awaiting final wording.]</p>
       <table style="width:100%;border-collapse:collapse;margin:18px 0;border-top:1px solid #eee;">
         ${row('Credits expiring', p.expiringAmount)}
         ${row('Expiry date', p.expiryDate)}
         ${row('Balance after expiry', p.remainingAfter)}
       </table>`,
      '[PLACEHOLDER CTA]',
      p.ctaUrl,
    );

    const text = [
      `Hi ${p.firstName},`,
      '',
      '[PLACEHOLDER COPY — awaiting final wording.]',
      '',
      `Credits expiring: ${p.expiringAmount}`,
      `Expiry date: ${p.expiryDate}`,
      `Balance after expiry: ${p.remainingAfter}`,
      '',
      `[PLACEHOLDER CTA]: ${p.ctaUrl}`,
    ].join('\n');

    return { subject: `[PLACEHOLDER] Your credits expire ${p.leadTimeLabel}`, html, text };
  },

  /**
   * ⚠️ PLACEHOLDER COPY — BILL-008. See the note on creditsExpiringPlaceholder;
   * the variables available are on InactivityPayload.
   */
  inactivityPlaceholder: (p: InactivityPayload) => {
    const html = billingShell(
      '[PLACEHOLDER] Your credits are waiting',
      `<p style="font-size:15px;color:#333;">Hi ${p.firstName},</p>
       <p style="font-size:15px;color:#333;">[PLACEHOLDER COPY — awaiting final wording.]</p>
       <table style="width:100%;border-collapse:collapse;margin:18px 0;border-top:1px solid #eee;">
         ${row('Available credits', p.creditBalance)}
         ${row('Current plan', p.planName)}
         ${p.nearestExpiry ? row('Next expiry', p.nearestExpiry) : ''}
       </table>`,
      '[PLACEHOLDER CTA]',
      p.ctaUrl,
    );

    const text = [
      `Hi ${p.firstName},`,
      '',
      '[PLACEHOLDER COPY — awaiting final wording.]',
      '',
      `Available credits: ${p.creditBalance}`,
      `Current plan: ${p.planName}`,
      ...(p.nearestExpiry ? [`Next expiry: ${p.nearestExpiry}`] : []),
      '',
      `[PLACEHOLDER CTA]: ${p.ctaUrl}`,
    ].join('\n');

    return { subject: '[PLACEHOLDER] Your ImproveSEO credits are waiting', html, text };
  },
};

// NOTE: deliberately NOT merged into `emailTemplates` with Object.assign.
// That would work at runtime but leaves the merged members invisible to the
// type checker, so a typo in a template name would only surface as a
// dead-lettered email in production. Callers import billingEmailTemplates
// directly and get compile-time checking.
