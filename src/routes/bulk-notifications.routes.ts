import { Router, Response } from 'express';
import { validateApiAccess, AuthenticatedRequest } from '../middleware/apiAuth.middleware.js';
import { sendEmail, emailTemplates } from '../services/email.service.js';

const router = Router();

/**
 * Normalize a website domain into a proper base URL.
 * Handles: missing protocol, trailing slashes, whitespace.
 * e.g. "example.com/" → "https://example.com"
 *      "http://example.com" → "http://example.com"
 */
function normalizeBaseUrl(domain: string): string {
  let url = domain.trim();
  if (!url) return '';
  // Add protocol if missing
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  // Strip trailing slash(es)
  url = url.replace(/\/+$/, '');
  return url;
}

/**
 * Build the WP-admin project URL for a bulk task.
 */
function buildProjectUrl(domain: string, projectId: string | number): string {
  const base = normalizeBaseUrl(domain);
  if (!base || !projectId) return base;
  return `${base}/wp-admin/admin.php?page=improveseo_bulkprojects&action=viewAllTasks&id=${projectId}`;
}

/**
 * POST /api/v1/bulk-notifications/status
 * Sends an email notification for bulk task lifecycle events.
 * Auth: X-API-Key + X-Site-Code (resolved server-side to user email).
 */
router.post('/status', validateApiAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { event, task_name, total_tasks, completed_tasks, failed_tasks, project_id } = req.body;

    if (!event || !task_name) {
      return res.status(400).json({ success: false, error: 'event and task_name are required' });
    }

    const userName = req.user?.name || 'there';
    const userEmail = req.user?.email;
    const websiteDomain = req.website?.domain || '';
    const projectUrl = buildProjectUrl(websiteDomain, project_id);

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
          projectUrl
        );
        break;

      case 'task_completed':
        emailData = emailTemplates.bulkTaskCompleted(
          userName,
          task_name,
          Number(completed_tasks) || 0,
          Number(failed_tasks) || 0,
          websiteDomain,
          projectUrl
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
