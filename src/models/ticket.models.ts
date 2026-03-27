import sql from '../data/db.js';

// Types
export interface SupportTicket {
  id: number;
  user_id: number;
  ticket_display_id: string;
  subject: string;
  description: string;
  category: 'general' | 'billing' | 'technical' | 'feature_request';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'open' | 'in_progress' | 'waiting_on_user' | 'resolved' | 'closed';
  tags: string[];
  system_info?: Record<string, string>;
  assigned_admin_id?: string;
  created_at: Date;
  updated_at: Date;
  resolved_at?: Date;
  closed_at?: Date;
}

export interface TicketMessage {
  id: number;
  ticket_id: number;
  sender_type: 'user' | 'admin';
  sender_id: string;
  message: string;
  attachments?: string[];
  is_internal_note: boolean;
  created_at: Date;
}

export interface TicketAttachment {
  id: number;
  ticket_id: number;
  message_id?: number;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by_type: 'user' | 'admin';
  uploaded_by_id: string;
  created_at: Date;
}

export interface TicketWithUser extends SupportTicket {
  user_email: string;
  user_name: string;
}

export interface TicketStats {
  total: number;
  open: number;
  in_progress: number;
  waiting_on_user: number;
  resolved: number;
  closed: number;
  urgent_open: number;
}

// ==================== USER OPERATIONS ====================

/**
 * Create a new support ticket
 */
export const createTicket = async (data: {
  user_id: number;
  subject: string;
  description: string;
  category?: string;
  priority?: string;
  tags?: string[];
  system_info?: Record<string, string>;
}): Promise<TicketWithUser> => {
  const result = await sql`
    INSERT INTO support_tickets (user_id, subject, description, category, priority, tags, system_info)
    VALUES (
      ${data.user_id}, 
      ${data.subject}, 
      ${data.description}, 
      ${data.category || 'general'},
      ${data.priority || 'medium'},
      ${data.tags || []},
      ${data.system_info ? JSON.stringify(data.system_info) : null}
    )
    RETURNING *
  `;
  
  // Fetch user info
  const ticket = result[0] as SupportTicket;
  const userResult = await sql`
    SELECT email as user_email, name as user_name FROM users WHERE id = ${ticket.user_id}
  `;
  
  if (!userResult[0]) {
    return {
      ...ticket,
      user_email: '',
      user_name: ''
    } as TicketWithUser;
  }
  
  return {
    ...ticket,
    user_email: userResult[0].user_email as string,
    user_name: userResult[0].user_name as string
  } as TicketWithUser;
};

/**
 * Get all tickets for a specific user
 */
export const getUserTickets = async (
  user_id: number, 
  options: {
    status?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<SupportTicket[]> => {
  const { status, limit = 50, offset = 0 } = options;
  
  if (status) {
    const result = await sql`
      SELECT * FROM support_tickets 
      WHERE user_id = ${user_id} AND status = ${status}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return result as unknown as SupportTicket[];
  }
  
  const result = await sql`
    SELECT * FROM support_tickets 
    WHERE user_id = ${user_id}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return result as unknown as SupportTicket[];
};

/**
 * Get a single ticket by ID
 */
export const getTicketById = async (ticket_id: number, includeInternalNotes: boolean = false): Promise<{
  ticket: TicketWithUser;
  messages: TicketMessage[];
  attachments: TicketAttachment[];
} | null> => {
  const ticketResult = await sql`
    SELECT t.*, u.email as user_email, u.name as user_name
    FROM support_tickets t
    JOIN users u ON t.user_id = u.id
    WHERE t.id = ${ticket_id}
  `;
  
  if (!ticketResult[0]) return null;
  
  const messages = includeInternalNotes 
    ? await sql`
        SELECT * FROM ticket_messages 
        WHERE ticket_id = ${ticket_id}
        ORDER BY created_at ASC
      `
    : await sql`
        SELECT * FROM ticket_messages 
        WHERE ticket_id = ${ticket_id} AND is_internal_note = false
        ORDER BY created_at ASC
      `;

  const attachments = await sql`
    SELECT * FROM ticket_attachments
    WHERE ticket_id = ${ticket_id}
    ORDER BY created_at ASC
  `;
  
  return {
    ticket: ticketResult[0] as TicketWithUser,
    messages: messages as unknown as TicketMessage[],
    attachments: attachments as unknown as TicketAttachment[]
  };
};

/**
 * Check if user owns a ticket
 */
export const userOwnsTicket = async (ticket_id: number, user_id: number): Promise<boolean> => {
  const result = await sql`
    SELECT id FROM support_tickets 
    WHERE id = ${ticket_id} AND user_id = ${user_id}
    LIMIT 1
  `;
  return result.length > 0;
};

// ==================== MESSAGE OPERATIONS ====================

/**
 * Add a message to a ticket
 */
export const addTicketMessage = async (data: {
  ticket_id: number;
  sender_type: 'user' | 'admin';
  sender_id: string;
  message: string;
  attachments?: string[];
  is_internal_note?: boolean;
}): Promise<TicketMessage> => {
  const result = await sql`
    INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, message, attachments, is_internal_note)
    VALUES (
      ${data.ticket_id},
      ${data.sender_type},
      ${data.sender_id},
      ${data.message},
      ${JSON.stringify(data.attachments || [])},
      ${data.is_internal_note || false}
    )
    RETURNING *
  `;
  
  // Update ticket's updated_at timestamp
  await sql`
    UPDATE support_tickets 
    SET updated_at = NOW()
    WHERE id = ${data.ticket_id}
  `;
  
  // If admin is responding, set status to in_progress if it was open
  if (data.sender_type === 'admin') {
    await sql`
      UPDATE support_tickets 
      SET status = 'in_progress', assigned_admin_id = ${data.sender_id}
      WHERE id = ${data.ticket_id} AND status = 'open'
    `;
  }
  
  // If user is responding and status was waiting_on_user, set back to in_progress
  if (data.sender_type === 'user') {
    await sql`
      UPDATE support_tickets 
      SET status = 'in_progress'
      WHERE id = ${data.ticket_id} AND status = 'waiting_on_user'
    `;
  }
  
  return result[0] as TicketMessage;
};

/**
 * Get messages for a ticket
 */
export const getTicketMessages = async (ticket_id: number): Promise<TicketMessage[]> => {
  const result = await sql`
    SELECT * FROM ticket_messages 
    WHERE ticket_id = ${ticket_id}
    ORDER BY created_at ASC
  `;
  return result as unknown as TicketMessage[];
};

// ==================== ADMIN OPERATIONS ====================

/**
 * Get all tickets (admin view)
 */
export const getAllTickets = async (options: {
  status?: string;
  priority?: string;
  category?: string;
  tag?: string;
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ tickets: TicketWithUser[]; total: number }> => {
  const { status, priority, category, tag, search, limit = 50, offset = 0 } = options;
  
  // Build dynamic query conditions
  let conditions = sql`1=1`;
  
  if (status) {
    conditions = sql`${conditions} AND t.status = ${status}`;
  }
  if (priority) {
    conditions = sql`${conditions} AND t.priority = ${priority}`;
  }
  if (category) {
    conditions = sql`${conditions} AND t.category = ${category}`;
  }
  if (tag) {
    conditions = sql`${conditions} AND ${tag} = ANY(t.tags)`;
  }
  if (search) {
    conditions = sql`${conditions} AND (t.subject ILIKE ${'%' + search + '%'} OR t.description ILIKE ${'%' + search + '%'} OR u.email ILIKE ${'%' + search + '%'} OR t.ticket_display_id ILIKE ${'%' + search + '%'})`;
  }
  
  const ticketsResult = await sql`
    SELECT t.*, u.email as user_email, u.name as user_name
    FROM support_tickets t
    JOIN users u ON t.user_id = u.id
    WHERE ${conditions}
    ORDER BY 
      CASE t.priority 
        WHEN 'urgent' THEN 1 
        WHEN 'high' THEN 2 
        WHEN 'medium' THEN 3 
        ELSE 4 
      END,
      t.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  
  const countResult = await sql`
    SELECT COUNT(*)::int as total
    FROM support_tickets t
    JOIN users u ON t.user_id = u.id
    WHERE ${conditions}
  `;
  
  return {
    tickets: ticketsResult as unknown as TicketWithUser[],
    total: countResult[0]?.total || 0
  };
};

/**
 * Update ticket status (admin)
 */
export const updateTicketStatus = async (
  ticket_id: number, 
  status: string,
  admin_id?: string
): Promise<TicketWithUser | null> => {
  // Build update fields based on status
  let updateFields: any = { status };
  
  if (status === 'resolved') {
    updateFields.resolved_at = new Date();
  } else if (status === 'closed') {
    updateFields.closed_at = new Date();
  }
  
  if (admin_id && (status === 'in_progress' || status === 'waiting_on_user')) {
    updateFields.assigned_admin_id = admin_id;
  }
  
  const result = await sql`
    UPDATE support_tickets 
    SET 
      status = ${status},
      resolved_at = ${status === 'resolved' ? sql`NOW()` : sql`resolved_at`},
      closed_at = ${status === 'closed' ? sql`NOW()` : sql`closed_at`},
      assigned_admin_id = ${admin_id || sql`assigned_admin_id`}
    WHERE id = ${ticket_id}
    RETURNING *
  `;
  
  if (!result[0]) return null;
  
  const ticket = result[0] as SupportTicket;
  const userResult = await sql`
    SELECT email as user_email, name as user_name FROM users WHERE id = ${ticket.user_id}
  `;
  
  if (!userResult[0]) {
    return {
      ...ticket,
      user_email: '',
      user_name: ''
    } as TicketWithUser;
  }
  
  return {
    ...ticket,
    user_email: userResult[0].user_email as string,
    user_name: userResult[0].user_name as string
  } as TicketWithUser;
};

/**
 * Update ticket priority (admin)
 */
export const updateTicketPriority = async (
  ticket_id: number, 
  priority: string
): Promise<SupportTicket> => {
  const result = await sql`
    UPDATE support_tickets 
    SET priority = ${priority}
    WHERE id = ${ticket_id}
    RETURNING *
  `;
  return result[0] as SupportTicket;
};

/**
 * Get ticket statistics for admin dashboard
 */
export const getTicketStats = async (): Promise<TicketStats> => {
  const result = await sql`
    SELECT 
      COUNT(*)::int as total,
      COUNT(CASE WHEN status = 'open' THEN 1 END)::int as open,
      COUNT(CASE WHEN status = 'in_progress' THEN 1 END)::int as in_progress,
      COUNT(CASE WHEN status = 'waiting_on_user' THEN 1 END)::int as waiting_on_user,
      COUNT(CASE WHEN status = 'resolved' THEN 1 END)::int as resolved,
      COUNT(CASE WHEN status = 'closed' THEN 1 END)::int as closed,
      COUNT(CASE WHEN priority = 'urgent' AND status NOT IN ('resolved', 'closed') THEN 1 END)::int as urgent_open
    FROM support_tickets
  `;
  return result[0] as TicketStats;
};

/**
 * Get recent ticket activity for dashboard
 */
export const getRecentTickets = async (limit: number = 10): Promise<TicketWithUser[]> => {
  const result = await sql`
    SELECT t.*, u.email as user_email, u.name as user_name
    FROM support_tickets t
    JOIN users u ON t.user_id = u.id
    WHERE t.status NOT IN ('resolved', 'closed')
    ORDER BY 
      CASE t.priority 
        WHEN 'urgent' THEN 1 
        WHEN 'high' THEN 2 
        WHEN 'medium' THEN 3 
        ELSE 4 
      END,
      t.updated_at DESC
    LIMIT ${limit}
  `;
  return result as unknown as TicketWithUser[];
};

// ==================== TAG OPERATIONS ====================

export const updateTicketTags = async (ticket_id: number, tags: string[]): Promise<SupportTicket> => {
  const result = await sql`
    UPDATE support_tickets
    SET tags = ${tags}, updated_at = NOW()
    WHERE id = ${ticket_id}
    RETURNING *
  `;
  return result[0] as SupportTicket;
};

// ==================== ATTACHMENT OPERATIONS ====================

export const createAttachment = async (data: {
  ticket_id: number;
  message_id?: number;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by_type: 'user' | 'admin';
  uploaded_by_id: string;
}): Promise<TicketAttachment> => {
  const result = await sql`
    INSERT INTO ticket_attachments (ticket_id, message_id, original_name, stored_name, mime_type, size_bytes, uploaded_by_type, uploaded_by_id)
    VALUES (
      ${data.ticket_id},
      ${data.message_id || null},
      ${data.original_name},
      ${data.stored_name},
      ${data.mime_type},
      ${data.size_bytes},
      ${data.uploaded_by_type},
      ${data.uploaded_by_id}
    )
    RETURNING *
  `;
  return result[0] as TicketAttachment;
};

export const getTicketAttachments = async (ticket_id: number): Promise<TicketAttachment[]> => {
  const result = await sql`
    SELECT * FROM ticket_attachments
    WHERE ticket_id = ${ticket_id}
    ORDER BY created_at ASC
  `;
  return result as unknown as TicketAttachment[];
};
