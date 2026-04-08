import { Router, Response } from 'express';
import { validateApiAccess, AuthenticatedRequest } from '../middleware/apiAuth.middleware.js';
import { sendEmail, emailTemplates } from '../services/email.service.js';

const router = Router();

const CMS_URL = process.env.CMS_URL || 'https://app.improveseo.ai';

/**
 * POST /api/v1/bulk-notifications/status
 * Sends an email notification for bulk task lifecycle events.
 * Auth: X-API-Key + X-Site-Code (resolved server-side to user email).
 */
router.post('/status', validateApiAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { event, task_name, total_tasks, completed_tasks, failed_tasks } = req.body;

    if (!event || !task_name) {
      return res.status(400).json({ success: false, error: 'event and task_name are required' });
    }

    const userName = req.user?.name || 'there';
    const userEmail = req.user?.email;
    const websiteDomain = req.website?.domain || '';

    if (!userEmail) {
      return res.status(400).json({ success: false, error: 'User email not found' });
    }

    let emailData: { subject: string; html: string; text?: string } | null = null;

    switch (event) {
      case 'task_created':
        emailData = emailTemplates.bulkTaskCreated(
          userName,
          task_name,
          Number(total_tasks) || 0,
          websiteDomain,
          CMS_URL
        );
        break;

      case 'task_completed':
        emailData = emailTemplates.bulkTaskCompleted(
          userName,
          task_name,
          Number(completed_tasks) || 0,
          Number(failed_tasks) || 0,
          websiteDomain,
          CMS_URL
        );
        break;

      default:
        return res.status(400).json({ success: false, error: `Unknown event: ${event}` });
    }

    // Fire email — don't block the response on delivery
    sendEmail({
      to: userEmail,
      subject: emailData.subject,
      html: emailData.html,
      text: emailData.text
    }).catch(err => console.error('Bulk notification email failed:', err));

    return res.json({ success: true, message: `Notification queued for ${event}` });
  } catch (error) {
    console.error('Bulk notification error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
