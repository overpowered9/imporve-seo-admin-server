import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export const sendEmail = async (options: EmailOptions): Promise<boolean> => {
  try {
    const mailgunDomain = process.env.MAILGUN_DOMAIN;
    const mailgunApiKey = process.env.MAILGUN_API_KEY;
    const mailgunFromEmail = process.env.MAILGUN_FROM_EMAIL || 'noreply@improveseo.app';

    if (!mailgunDomain || !mailgunApiKey) {
      console.warn('Mailgun configuration missing. Skipping email send.');
      return false;
    }

    const form = new FormData();
    form.append('from', mailgunFromEmail);
    form.append('to', options.to);
    form.append('subject', options.subject);
    form.append('html', options.html);
    if (options.text) {
      form.append('text', options.text);
    }

    // Embed logo if it exists
    const logoPath = path.join(process.cwd(), 'email-assets', 'logo.png');
    if (fs.existsSync(logoPath)) {
      try {
        form.append('inline', fs.createReadStream(logoPath), { filename: 'logo.png' });
      } catch (err) {
        console.warn('Could not attach logo:', err);
      }
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

// Email template generators
export const emailTemplates = {
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
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; background: #ffffff; }
            .header { background: linear-gradient(135deg, #1c7293 0%, #2ec5b6 100%); padding: 40px 20px; text-align: center; }
            .logo { max-width: 120px; height: auto; margin-bottom: 20px; }
            .header h1 { margin: 0; color: white; font-size: 24px; font-weight: 600; }
            .content { padding: 40px 20px; }
            .content p { margin: 15px 0; color: #555; }
            .content p strong { color: #1c7293; }
            .ticket-info { background: linear-gradient(135deg, rgba(255, 122, 89, 0.05) 0%, rgba(46, 197, 182, 0.05) 100%); padding: 20px; border-left: 4px solid #ff7a59; border-radius: 4px; margin: 25px 0; }
            .ticket-info p { margin: 8px 0; font-size: 14px; }
            .ticket-id { font-family: 'Courier New', monospace; font-weight: bold; color: #ff7a59; font-size: 16px; }
            .cta-button { display: inline-block; background: linear-gradient(135deg, #ff7a59 0%, #ff5f3f 100%); color: white; padding: 14px 35px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px; margin: 20px 0; transition: transform 0.2s; }
            .cta-button:hover { transform: translateY(-2px); }
            .cta-container { text-align: center; margin: 30px 0; }
            .divider { border-top: 1px solid #eee; margin: 30px 0; }
            .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #eee; }
            .footer p { margin: 5px 0; }
            .highlight { color: #2ec5b6; font-weight: 600; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <img src="cid:logo" alt="ImproveSEO Logo" class="logo">
              <h1>Ticket Received ✓</h1>
            </div>
            
            <div class="content">
              <p>Hi ${userName},</p>
              
              <p>Thank you for reaching out to ImproveSEO support! We've successfully received your support ticket and logged it in our system. Our team will review and get back to you as soon as possible.</p>
              
              <div class="ticket-info">
                <p><strong>Ticket ID:</strong> <span class="ticket-id">${ticketDisplayId}</span></p>
                <p><strong>Subject:</strong> ${subject}</p>
                <p style="margin-top: 15px; font-size: 13px; color: #777;">You can reference this ticket ID when following up with us.</p>
              </div>
              
              <p>To view your ticket status, messages, and attach additional files, click the button below:</p>
              
              <div class="cta-container">
                <a href="${cmsUrl}/support/tickets/${ticketId}" class="cta-button">View Your Ticket →</a>
              </div>
              
              <div class="divider"></div>
              
              <p style="font-size: 13px; color: #999;">You can reply to your ticket anytime through your dashboard. For faster communication, please keep all correspondence within the ticket thread.</p>
            </div>
            
            <div class="footer">
              <p><strong>ImproveSEO Support</strong></p>
              <p>© 2026 ImproveSEO. All rights reserved.</p>
              <p style="margin-top: 10px; color: #bbb;">Please do not reply to this email. Use your support dashboard instead.</p>
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

You can reply to your ticket anytime through your dashboard.

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
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; background: #ffffff; }
            .header { background: linear-gradient(135deg, #1c7293 0%, #2ec5b6 100%); padding: 40px 20px; text-align: center; }
            .logo { max-width: 120px; height: auto; margin-bottom: 20px; }
            .header h1 { margin: 0; color: white; font-size: 24px; font-weight: 600; }
            .content { padding: 40px 20px; }
            .content p { margin: 15px 0; color: #555; }
            .message-box { background: linear-gradient(135deg, rgba(255, 122, 89, 0.05) 0%, rgba(46, 197, 182, 0.05) 100%); padding: 25px; border-left: 4px solid #2ec5b6; border-radius: 4px; margin: 25px 0; }
            .message-box p { margin: 0; color: #333; white-space: pre-wrap; word-wrap: break-word; }
            .sender { font-size: 13px; color: #ff7a59; font-weight: 600; margin-bottom: 10px; }
            .ticket-ref { display: inline-block; background: #f0f0f0; padding: 8px 12px; border-radius: 4px; font-family: 'Courier New', monospace; color: #1c7293; font-weight: bold; font-size: 13px; margin-top: 15px; }
            .cta-button { display: inline-block; background: linear-gradient(135deg, #ff7a59 0%, #ff5f3f 100%); color: white; padding: 14px 35px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px; margin: 20px 0; transition: transform 0.2s; }
            .cta-button:hover { transform: translateY(-2px); }
            .cta-container { text-align: center; margin: 30px 0; }
            .divider { border-top: 1px solid #eee; margin: 30px 0; }
            .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #eee; }
            .footer p { margin: 5px 0; }
            .highlight { color: #2ec5b6; font-weight: 600; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <img src="cid:logo" alt="ImproveSEO Logo" class="logo">
              <h1>You've Got a Reply 💬</h1>
            </div>
            
            <div class="content">
              <p>Hi there,</p>
              
              <p><span class="highlight">${senderName}</span> has replied to your support ticket:</p>
              
              <div class="message-box">
                <div class="sender">💬 ${senderName}</div>
                <p>${message.substring(0, 500)}${message.length > 500 ? '...' : ''}</p>
              </div>
              
              <p style="font-size: 13px;">View the full conversation and continue the discussion by clicking below:</p>
              
              <div class="cta-container">
                <a href="${cmsUrl}/support/tickets/${ticketId}" class="cta-button">View Conversation →</a>
              </div>
              
              <div class="ticket-ref">Ticket: ${ticketDisplayId}</div>
              
              <div class="divider"></div>
              
              <p style="font-size: 13px; color: #999;">You can reply directly in your support dashboard. All messages stay organized in one place.</p>
            </div>
            
            <div class="footer">
              <p><strong>ImproveSEO Support</strong></p>
              <p>© 2026 ImproveSEO. All rights reserved.</p>
              <p style="margin-top: 10px; color: #bbb;">Please do not reply to this email. Use your support dashboard instead.</p>
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

You can reply directly in your support dashboard.

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
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; background: #ffffff; }
            .header { background: linear-gradient(135deg, #1c7293 0%, #2ec5b6 100%); padding: 40px 20px; text-align: center; }
            .logo { max-width: 120px; height: auto; margin-bottom: 20px; }
            .header h1 { margin: 0; color: white; font-size: 24px; font-weight: 600; }
            .content { padding: 40px 20px; }
            .content p { margin: 15px 0; color: #555; }
            .status-box { background: linear-gradient(135deg, rgba(46, 197, 182, 0.1) 0%, rgba(255, 122, 89, 0.05) 100%); padding: 25px; border-left: 4px solid #2ec5b6; border-radius: 4px; margin: 25px 0; }
            .status-box p { margin: 8px 0; color: #333; }
            .status-label { display: inline-block; background: #2ec5b6; color: white; padding: 6px 12px; border-radius: 4px; font-weight: 600; font-size: 12px; }
            .ticket-id { font-family: 'Courier New', monospace; font-weight: bold; color: #ff7a59; }
            .next-steps { background: #f9f9f9; padding: 20px; border-radius: 4px; margin: 20px 0; }
            .next-steps strong { color: #1c7293; }
            .cta-button { display: inline-block; background: linear-gradient(135deg, #ff7a59 0%, #ff5f3f 100%); color: white; padding: 14px 35px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px; margin: 20px 0; transition: transform 0.2s; }
            .cta-button:hover { transform: translateY(-2px); }
            .secondary-button { display: inline-block; background: transparent; color: #1c7293; padding: 12px 25px; text-decoration: none; border: 2px solid #1c7293; border-radius: 6px; font-weight: 600; font-size: 14px; margin-left: 10px; }
            .button-group { text-align: center; margin: 30px 0; }
            .divider { border-top: 1px solid #eee; margin: 30px 0; }
            .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #eee; }
            .footer p { margin: 5px 0; }
            .highlight { color: #2ec5b6; font-weight: 600; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <img src="cid:logo" alt="ImproveSEO Logo" class="logo">
              <h1>Ticket Closed ✓</h1>
            </div>
            
            <div class="content">
              <p>Hi there,</p>
              
              <p>Your support ticket has been resolved and closed. We appreciate you reaching out to us and giving us the opportunity to help!</p>
              
              <div class="status-box">
                <p><span class="status-label">CLOSED</span></p>
                <p style="margin-top: 15px;"><strong>Ticket ID:</strong> <span class="ticket-id">${ticketDisplayId}</span></p>
                <p><strong>Resolution:</strong> ${reason}</p>
              </div>
              
              <div class="next-steps">
                <strong>📌 What's Next?</strong>
                <p>If the issue returns or you have a follow-up question, you can:</p>
                <ul style="margin: 10px 0; padding-left: 20px;">
                  <li>View this ticket in your dashboard and add a comment</li>
                  <li>Create a new ticket if it's a different issue</li>
                </ul>
              </div>
              
              <p style="font-size: 13px; text-align: center; margin: 20px 0;">We'd love to hear your feedback!</p>
              
              <div class="button-group">
                <a href="${cmsUrl}/support/tickets/${ticketId}" class="cta-button">View Ticket</a>
              </div>
              
              <div class="divider"></div>
              
              <p style="font-size: 13px; color: #999;">Thank you for choosing ImproveSEO. If you have any questions or concerns about this closure, please don't hesitate to reach out.</p>
            </div>
            
            <div class="footer">
              <p><strong>ImproveSEO Support</strong></p>
              <p>© 2026 ImproveSEO. All rights reserved.</p>
              <p style="margin-top: 10px; color: #bbb;">Please do not reply to this email. Use your support dashboard instead.</p>
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
  }
};
