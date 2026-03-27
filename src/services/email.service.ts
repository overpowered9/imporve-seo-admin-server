import axios from 'axios';
import FormData from 'form-data';

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
            .cta-button { display: inline-block; background: #ff7a59; color: white; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 15px; margin: 25px 0; transition: all 0.3s ease; box-shadow: 0 4px 12px rgba(255, 122, 89, 0.3); }
            .cta-button:hover { background: #ff5f3f; transform: translateY(-2px); box-shadow: 0 6px 16px rgba(255, 122, 89, 0.4); }
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
                  <h1>Ticket Received ✓</h1>
                  <p class="header-subtext">We're on it!</p>
                </div>
              </div>
              
              <div class="content">
                <p>Hi ${userName},</p>
                
                <p>Thank you for reaching out to ImproveSEO support! We've successfully received your support ticket and it's now in our system. Our team will review your request and get back to you shortly.</p>
                
                <div class="ticket-info">
                  <p><strong>Ticket ID:</strong> <span class="ticket-id">${ticketDisplayId}</span></p>
                  <p><strong>Subject:</strong> <span class="ticket-subject">${subject}</span></p>
                  <p class="info-text">💡 Save your ticket ID for future reference</p>
                </div>
                
                <p class="section-title">What happens next?</p>
                <p>✓ Your ticket is queued for review<br>✓ Our team will respond within 24 hours<br>✓ You'll receive email updates on progress<br>✓ Track everything in your support dashboard</p>
                
                <div class="cta-container">
                  <a href="${cmsUrl}/support/tickets/${ticketId}" class="cta-button">View Your Ticket</a>
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
✓ Your ticket is queued for review
✓ Our team will respond within 24 hours
✓ You'll receive email updates on progress

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
            .cta-button { display: inline-block; background: #ff7a59; color: white; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 15px; margin: 25px 0; transition: all 0.3s ease; box-shadow: 0 4px 12px rgba(255, 122, 89, 0.3); }
            .cta-button:hover { background: #ff5f3f; transform: translateY(-2px); box-shadow: 0 6px 16px rgba(255, 122, 89, 0.4); }
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
                  <h1>You've Got a Reply 💬</h1>
                  <p class="header-subtext">Check your support ticket</p>
                </div>
              </div>
              
              <div class="content">
                <p>Hi there,</p>
                
                <p><span class="badge">NEW REPLY</span><span class="sender-highlight">${senderName}</span> has responded to your support ticket:</p>
                
                <div class="message-box">
                  <div class="sender-label">📨 Support Team Response</div>
                  <p>${message.substring(0, 500)}${message.length > 500 ? '...' : ''}</p>
                </div>
                
                <p style="font-size: 14px; color: #666;">To see the full conversation and add your reply, click the button below:</p>
                
                <div class="cta-container">
                  <a href="${cmsUrl}/support/tickets/${ticketId}" class="cta-button">View Conversation</a>
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
            .cta-button { display: inline-block; background: #ff7a59; color: white; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 15px; margin: 25px auto; transition: all 0.3s ease; box-shadow: 0 4px 12px rgba(255, 122, 89, 0.3); }
            .cta-button:hover { background: #ff5f3f; transform: translateY(-2px); box-shadow: 0 6px 16px rgba(255, 122, 89, 0.4); }
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
                  <h1>Ticket Resolved ✅</h1>
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
                  <a href="${cmsUrl}/support/tickets/${ticketId}" class="cta-button">View Ticket Details</a>
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
  }
};
