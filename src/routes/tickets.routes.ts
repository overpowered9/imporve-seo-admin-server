import express from 'express';
import { z } from 'zod';
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
  getRecentTickets
} from '../models/ticket.models.js';

const router = express.Router();

// Validation schemas
const createTicketSchema = z.object({
  user_id: z.number().positive(),
  subject: z.string().min(5, 'Subject must be at least 5 characters').max(255),
  description: z.string().min(20, 'Description must be at least 20 characters'),
  category: z.enum(['general', 'billing', 'technical', 'feature_request']).optional().default('general'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().default('medium')
});

const addMessageSchema = z.object({
  sender_type: z.enum(['user', 'admin']),
  sender_id: z.string().min(1),
  message: z.string().min(1, 'Message cannot be empty'),
  attachments: z.array(z.string()).optional()
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
    const ticket = await createTicket(data);
    
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
    
    const result = await getTicketById(ticket_id);
    
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
router.post('/:ticket_id/messages', async (req, res) => {
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
    
    const message = await addTicketMessage({ ticket_id, ...data });
    
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
router.get('/admin/stats', async (req, res) => {
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
router.get('/admin/recent', async (req, res) => {
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
router.get('/admin/all', async (req, res) => {
  try {
    const { status, priority, category, search, limit, offset } = req.query;
    
    const result = await getAllTickets({
      status: status as string,
      priority: priority as string,
      category: category as string,
      search: search as string,
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
router.patch('/:ticket_id/status', async (req, res) => {
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
router.patch('/:ticket_id/priority', async (req, res) => {
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

export default router;
