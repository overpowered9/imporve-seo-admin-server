import express from 'express';
import { z } from 'zod';
import {
  createWebsite,
  getUserWebsites,
  deleteWebsite,
  getUserWithPlan,
  findWebsiteByDomain,
} from '../models/user.models.js';
import { requireSupabaseUser, type SupabaseAuthedRequest } from '../middleware/supabaseAuth.middleware.js';
import sql from '../data/db.js';

const router = express.Router();

// All /websites routes require a valid Supabase JWT. Identity comes from the
// token (req.appUser), never from the request body/params — previously these
// endpoints were unauthenticated and took user_id from the caller, letting
// anyone list/add/delete websites for arbitrary accounts.
router.use(requireSupabaseUser);

const addWebsiteSchema = z.object({
  domain: z.string().url(),
  // Legacy field — still sent by older clients. If present it must match the
  // authenticated user; it is never used as the identity.
  user_id: z.number().optional(),
});

// Get the authenticated user's websites. The :user_id path segment is kept for
// backward compatibility but must match the token identity.
router.get('/:user_id', async (req: SupabaseAuthedRequest, res) => {
  try {
    const requested = parseInt(req.params.user_id);
    if (!Number.isNaN(requested) && requested !== req.appUser!.id) {
      return res.status(403).json({ success: false, error: 'Not authorized for this account.' });
    }
    const websites = await getUserWebsites(req.appUser!.id);

    res.json({
      success: true,
      data: websites
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch websites'
    });
  }
});

// Add new website (for the authenticated user)
router.post('/', async (req: SupabaseAuthedRequest, res) => {
  try {
    const { domain, user_id: bodyUserId } = addWebsiteSchema.parse(req.body);
    const user_id = req.appUser!.id;
    if (bodyUserId !== undefined && bodyUserId !== user_id) {
      return res.status(403).json({ success: false, error: 'Not authorized for this account.' });
    }

    // Check user's website limit
    const userWithPlan = await getUserWithPlan(user_id);
    if (!userWithPlan) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Check website limit (null = unlimited)
    if (userWithPlan.website_limit !== null) {
      const currentWebsites = await getUserWebsites(user_id);
      if (currentWebsites.length >= userWithPlan.website_limit) {
        return res.status(400).json({
          success: false,
          // The CMS shows its own dialog for this rather than the sentence
          // below, and it needs to recognise the refusal to do so. The code is
          // the stable contract — the same one the plugin connect flow returns
          // — so the client is not left matching English prose. The sentence
          // stays for callers that only read `error`.
          code: 'WEBSITE_LIMIT_REACHED',
          error: `Website limit reached. Your plan allows ${userWithPlan.website_limit} websites.`
        });
      }
    }

    // Normalise domain (trim + lowercase, then strip www) to match the connect path.
    let normDomain: string;
    try {
      normDomain = new URL(domain).hostname.trim().toLowerCase().replace(/^www\./, '');
    } catch (_) {
      normDomain = domain.trim().toLowerCase().replace(/^www\./, '');
    }

    // Any number of accounts may add the same domain — other accounts' rows are
    // ignored. Reuse own active / reactivate own soft-deleted / create fresh.
    const allRows = await findWebsiteByDomain(normDomain);
    const ownActive = allRows.find((r) => r.active && r.user_id === user_id);
    const ownSoftDeleted = allRows.find((r) => !r.active && r.user_id === user_id);
    let website: any;
    if (ownActive) {
      website = ownActive;
    } else if (ownSoftDeleted) {
      await sql`UPDATE websites SET active = true, deleted_at = NULL WHERE id = ${ownSoftDeleted.id}`;
      website = ownSoftDeleted;
    } else {
      website = await createWebsite(user_id, normDomain, false);
    }

    res.status(201).json({
      success: true,
      data: website,
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, error: 'Invalid request data' });
    }
    console.error('Add website error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to add website'
    });
  }
});

// Delete (soft) one of the authenticated user's websites — ownership enforced.
router.delete('/:website_id', async (req: SupabaseAuthedRequest, res) => {
  try {
    const website_id = parseInt(req.params.website_id);
    if (Number.isNaN(website_id)) {
      return res.status(400).json({ success: false, error: 'Invalid website id' });
    }

    const rows = await sql`SELECT user_id FROM websites WHERE id = ${website_id} LIMIT 1`;
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Website not found' });
    }
    if (rows[0].user_id !== req.appUser!.id) {
      return res.status(403).json({ success: false, error: 'Not authorized to delete this website.' });
    }

    await deleteWebsite(website_id);

    res.json({
      success: true,
      message: 'Website deleted successfully'
    });
  } catch (error) {
    console.error('Delete website error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete website',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
