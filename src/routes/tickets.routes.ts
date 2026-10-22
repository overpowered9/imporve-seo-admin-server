import express from 'express';
import { z } from 'zod';
import multer from 'multer';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import {
  createTicket,
  getUserTickets,
  getTicketById,
  userOwnsTicket,
  addTicketMessage,
  getAllTickets,
  updateTicketStatus,
  updateTicketPriority,
  getTicketStats,
  getRecentTickets,
  updateTicketTags,
  createAttachment,
  getTicketAttachments
} from '../models/ticket.models.js';
import { sendEmail, emailTemplates } from '../services/email.service.js';
import { requireAdmin } from '../middleware/adminAuth.middleware.js';

const router = express.Router();

/**
 * The admin side of this router — the queue, a ticket as an agent sees it, and changing
 * status, priority or tags — needs the admin session, like every other admin route
 * (v1.ts mounts /admin/users behind requireAdmin). These were open: GET /tickets/admin/all
 * returned every customer's tickets, email and name to anyone who asked, and anyone could
 * close a ticket or post a reply that the customer is emailed as coming from Support.
 *
 * The admin panel already sends its token on every call (its axios interceptor), and the
 * CMS never calls these routes, so neither changes. The customer routes — open a ticket,
 * list one's own, reply, upload — are left exactly as they were.
 */
const requireAdminForAgentMessages = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) =>
  // A reply as Support, or an internal note, is an agent's message. A customer's own reply
  // ('user') carries no admin token and is checked for ownership in the handler.
  req.body?.sender_type === 'admin' || req.body?.is_internal_note === true
    ? requireAdmin(req, res, next)
    : next();

// ==================== FILE UPLOAD CONFIG ====================
const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'tickets');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'text/plain', 'text/csv',
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/json', 'application/zip'
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES_PER_MESSAGE = 3;
const COMPRESS_THRESHOLD = 4 * 1024 * 1024; // 4 MB - auto-compress images above this

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const unique = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${unique}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES_PER_MESSAGE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} is not allowed`));
    }
  }
});

// Auto-compress images > 4MB
async function compressImageIfNeeded(filePath: string, mimetype: string): Promise<void> {
  if (!mimetype.startsWith('image/')) return;
  const stat = fs.statSync(filePath);
  if (stat.size <= COMPRESS_THRESHOLD) return;
  
  const tempPath = filePath + '.tmp';
  await sharp(filePath)
    .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toFile(tempPath);
  fs.renameSync(tempPath, filePath);
}

// Validation schemas
const createTicketSchema = z.object({
  user_id: z.number().positive(),
  subject: z.string().min(5, 'Subject must be at least 5 characters').max(255),
  description: z.string().min(20, 'Description must be at least 20 characters'),
  category: z.enum(['general', 'billing', 'technical', 'feature_request']).optional().default('general'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().default('medium'),
  tags: z.array(z.string()).optional(),
  system_info: z.object({
    plugin_version: z.string().optional(),
    wordpress_version: z.string().optional(),
    site_url: z.string().optional(),
    user_email: z.string().optional()
  }).optional()
});

const addMessageSchema = z.object({
  sender_type: z.enum(['user', 'admin']),
  sender_id: z.string().min(1),
  message: z.string().min(1, 'Message cannot be empty'),
  attachments: z.array(z.string()).optional(),
  is_internal_note: z.boolean().optional()
});

const updateStatusSchema = z.object({
  status: z.enum(['open', 'in_progress', 'waiting_on_user', 'resolved', 'closed']),
  admin_id: z.string().optional()
});

const updatePrioritySchema = z.object({
  priority: z.enum(['low', 'medium', 'high', 'urgent'])
});

// ==================== USER ROUTES ====================

/**
 * POST /tickets
 * Create a new support ticket
 */
router.post('/', async (req, res) => {
  try {
    const data = createTicketSchema.parse(req.body);
    const ticket = await createTicket({
      ...data,
      tags: data.tags,
      system_info: data.system_info
    });
    
    // Send email notification to user
    const cmsUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    const emailTemplate = emailTemplates.ticketCreated(
      ticket.id.toString(),
      ticket.ticket_display_id,
      ticket.subject,
      ticket.user_name || 'User',
      cmsUrl
    );
    
    if (ticket.user_email) {
      await sendEmail({
        to: ticket.user_email,
        subject: emailTemplate.subject,
        html: emailTemplate.html,
        text: emailTemplate.text
      });
    }
    
    res.status(201).json({
      success: true,
      data: ticket,
      message: 'Support ticket created successfully. Our team will respond soon.'
    });
  } catch (error) {
    console.error('Create ticket error:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.errors
      });
    }
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create ticket'
    });
  }
});

/**
 * GET /tickets/user/:user_id
 * Get all tickets for a specific user
 */
router.get('/user/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    if (isNaN(user_id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid user ID'
      });
    }
    
    const { status, limit, offset } = req.query;
    
    const tickets = await getUserTickets(user_id, {
      status: status as string,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined
    });
    
    res.json({
      success: true,
      data: tickets,
      count: tickets.length
    });
  } catch (error) {
    console.error('Get user tickets error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch tickets'
    });
  }
});

/**
 * GET /tickets/:ticket_id
 * Get a single ticket with all messages
 */
router.get('/:ticket_id', async (req, res) => {
  try {
    const ticket_id = parseInt(req.params.ticket_id);
    if (isNaN(ticket_id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ticket ID'
      });
    }
    
    const result = await getTicketById(ticket_id, false);
    
    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'Ticket not found'
      });
    }
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Get ticket error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch ticket'
    });
  }
});

/**
 * POST /tickets/:ticket_id/messages
 * Add a message to a ticket
 */
router.post('/:ticket_id/messages', requireAdminForAgentMessages, async (req, res) => {
  try {
    const ticket_id = parseInt(req.params.ticket_id);
    if (isNaN(ticket_id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ticket ID'
      });
    }
    
    // Verify ticket exists
    const ticketData = await getTicketById(ticket_id);
    if (!ticketData) {
      return res.status(404).json({
        success: false,
        error: 'Ticket not found'
      });
    }
    
    // Check if ticket is closed
    if (ticketData.ticket.status === 'closed') {
      return res.status(400).json({
        success: false,
        error: 'Cannot add messages to a closed ticket'
      });
    }
    
    const data = addMessageSchema.parse(req.body);
    
    // If sender is user, verify they own the ticket
    if (data.sender_type === 'user') {
      const owns = await userOwnsTicket(ticket_id, parseInt(data.sender_id));
      if (!owns) {
        return res.status(403).json({
          success: false,
          error: 'You do not have permission to message on this ticket'
        });
      }
    }
    
    const message = await addTicketMessage({ ticket_id, ...data, is_internal_note: data.is_internal_note || false });
    
    // Send email notification only if admin replied (not for internal notes)
    if (data.sender_type === 'admin' && !data.is_internal_note && ticketData.ticket.user_email) {
      const cmsUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
      const emailTemplate = emailTemplates.ticketReplied(
        ticket_id.toString(),
        ticketData.ticket.ticket_display_id,
        data.message,
        'Support Team',
        cmsUrl
      );
      
      await sendEmail({
        to: ticketData.ticket.user_email,
        subject: emailTemplate.subject,
        html: emailTemplate.html,
        text: emailTemplate.text
      });
    }
    
    res.status(201).json({
      success: true,
      data: message,
      message: 'Message added successfully'
    });
  } catch (error) {
    console.error('Add message error:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.errors
      });
    }
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to add message'
    });
  }
});

// ==================== ADMIN ROUTES ====================

/**
 * GET /tickets/admin/stats
 * Get ticket statistics for admin dashboard
 */
router.get('/admin/stats', requireAdmin, async (req, res) => {
  try {
    const stats = await getTicketStats();
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics'
    });
  }
});

/**
 * GET /tickets/admin/recent
 * Get recent active tickets for admin dashboard
 */
router.get('/admin/recent', requireAdmin, async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
    const tickets = await getRecentTickets(limit);
    res.json({
      success: true,
      data: tickets
    });
  } catch (error) {
    console.error('Get recent tickets error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch recent tickets'
    });
  }
});

/**
 * GET /tickets/admin/all
 * Get all tickets with filtering (admin view)
 */
router.get('/admin/all', requireAdmin, async (req, res) => {
  try {
    const { status, priority, category, search, tag, limit, offset } = req.query;
    
    const result = await getAllTickets({
      status: status as string,
      priority: priority as string,
      category: category as string,
      search: search as string,
      tag: tag as string,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined
    });
    
    res.json({
      success: true,
      data: {
        data: result.tickets,
        total: result.total,
        pagination: {
          limit: limit ? parseInt(limit as string) : 50,
          offset: offset ? parseInt(offset as string) : 0,
          total: result.total
        }
      }
    });
  } catch (error) {
    console.error('Get all tickets error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch tickets'
    });
  }
});

/**
 * PATCH /tickets/:ticket_id/status
 * Update ticket status (admin only)
 */
router.patch('/:ticket_id/status', requireAdmin, async (req, res) => {
  try {
    const ticket_id = parseInt(req.params.ticket_id);
    if (isNaN(ticket_id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ticket ID'
      });
    }
    
    const data = updateStatusSchema.parse(req.body);
    const ticket = await updateTicketStatus(ticket_id, data.status, data.admin_id);
    
    if (!ticket) {
      return res.status(404).json({
        success: false,
        error: 'Ticket not found'
      });
    }
    
    // Send email notification if ticket is closed
    if (data.status === 'closed' && ticket.user_email) {
      const cmsUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
      const emailTemplate = emailTemplates.ticketClosed(
        ticket_id.toString(),
        ticket.ticket_display_id,
        'Your issue has been resolved.',
        cmsUrl
      );
      
      await sendEmail({
        to: ticket.user_email,
        subject: emailTemplate.subject,
        html: emailTemplate.html,
        text: emailTemplate.text
      });
    }
    
    res.json({
      success: true,
      data: ticket,
      message: `Ticket status updated to "${data.status}"`
    });
  } catch (error) {
    console.error('Update status error:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.errors
      });
    }
    res.status(500).json({
      success: false,
      error: 'Failed to update ticket status'
    });
  }
});

/**
 * PATCH /tickets/:ticket_id/priority
 * Update ticket priority (admin only)
 */
router.patch('/:ticket_id/priority', requireAdmin, async (req, res) => {
  try {
    const ticket_id = parseInt(req.params.ticket_id);
    if (isNaN(ticket_id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ticket ID'
      });
    }
    
    const data = updatePrioritySchema.parse(req.body);
    const ticket = await updateTicketPriority(ticket_id, data.priority);
    
    if (!ticket) {
      return res.status(404).json({
        success: false,
        error: 'Ticket not found'
      });
    }
    
    res.json({
      success: true,
      data: ticket,
      message: `Ticket priority updated to "${data.priority}"`
    });
  } catch (error) {
    console.error('Update priority error:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.errors
      });
    }
    res.status(500).json({
      success: false,
      error: 'Failed to update ticket priority'
    });
  }
});

/**
 * GET /tickets/admin/:ticket_id
 * Get single ticket with all messages including internal notes (admin view)
 */
router.get('/admin/:ticket_id', requireAdmin, async (req, res) => {
  try {
    const ticket_id = parseInt(req.params.ticket_id);
    if (isNaN(ticket_id)) {
      return res.status(400).json({ success: false, error: 'Invalid ticket ID' });
    }
    
    const result = await getTicketById(ticket_id, true);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Ticket not found' });
    }
    
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Get admin ticket error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch ticket' });
  }
});

/**
 * PATCH /tickets/:ticket_id/tags
 * Update ticket tags (admin only)
 */
router.patch('/:ticket_id/tags', requireAdmin, async (req, res) => {
  try {
    const ticket_id = parseInt(req.params.ticket_id);
    if (isNaN(ticket_id)) {
      return res.status(400).json({ success: false, error: 'Invalid ticket ID' });
    }
    
    const { tags } = z.object({ tags: z.array(z.string()) }).parse(req.body);
    const ticket = await updateTicketTags(ticket_id, tags);
    
    if (!ticket) {
      return res.status(404).json({ success: false, error: 'Ticket not found' });
    }
    
    res.json({ success: true, data: ticket, message: 'Tags updated' });
  } catch (error) {
    console.error('Update tags error:', error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Validation error', details: error.errors });
    }
    res.status(500).json({ success: false, error: 'Failed to update tags' });
  }
});

/**
 * POST /tickets/:ticket_id/upload
 * Upload files to a ticket
 */
router.post('/:ticket_id/upload', upload.array('files', MAX_FILES_PER_MESSAGE), async (req, res) => {
  try {
    const ticket_id = parseInt(req.params.ticket_id);
    if (isNaN(ticket_id)) {
      return res.status(400).json({ success: false, error: 'Invalid ticket ID' });
    }
    
    const ticketData = await getTicketById(ticket_id, true);
    if (!ticketData) {
      return res.status(404).json({ success: false, error: 'Ticket not found' });
    }
    
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }
    
    const { uploaded_by_type, uploaded_by_id, message_id } = req.body;
    const attachments = [];
    
    for (const file of files) {
      await compressImageIfNeeded(file.path, file.mimetype);
      const stat = fs.statSync(file.path);
      
      const attachment = await createAttachment({
        ticket_id,
        message_id: message_id ? parseInt(message_id) : undefined,
        original_name: file.originalname,
        stored_name: file.filename,
        mime_type: file.mimetype,
        size_bytes: stat.size,
        uploaded_by_type: uploaded_by_type || 'user',
        uploaded_by_id: uploaded_by_id || '0'
      });
      attachments.push(attachment);
    }
    
    res.status(201).json({ success: true, data: attachments, message: `${attachments.length} file(s) uploaded` });
  } catch (error) {
    console.error('Upload error:', error);
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ success: false, error: error.message });
    }
    res.status(500).json({ success: false, error: 'Failed to upload files' });
  }
});

/**
 * GET /tickets/attachments/:stored_name
 * Serve uploaded files
 */
router.get('/attachments/:stored_name', (req, res) => {
  const storedName = path.basename(req.params.stored_name);
  const filePath = path.join(UPLOAD_DIR, storedName);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'File not found' });
  }
  
  res.sendFile(filePath);
});

/**
 * GET /tickets/:ticket_id/attachments
 * Get all attachments for a ticket
 */
router.get('/:ticket_id/attachments', async (req, res) => {
  try {
    const ticket_id = parseInt(req.params.ticket_id);
    if (isNaN(ticket_id)) {
      return res.status(400).json({ success: false, error: 'Invalid ticket ID' });
    }
    
    const attachments = await getTicketAttachments(ticket_id);
    res.json({ success: true, data: attachments });
  } catch (error) {
    console.error('Get attachments error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch attachments' });
  }
});

export default router;
