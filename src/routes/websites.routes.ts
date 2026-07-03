import express from 'express';
import { z } from 'zod';
import {
  createWebsite,
  getUserWebsites,
  deleteWebsite,
  getUserWithPlan,
  findWebsiteByDomain,
  grantFreeCreditsWithEmail,
} from '../models/user.models.js';
import { consumeLinkProof } from '../services/link-verification.js';
import sql from '../data/db.js';

const router = express.Router();

const addWebsiteSchema = z.object({
  domain: z.string().url(),
  user_id: z.number(),
  link_proof: z.string().optional(), // single-use proof from verify-link-code; unlocks the grant
});

// Get user websites
router.get('/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    const websites = await getUserWebsites(user_id);
    
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

// Add new website
router.post('/', async (req, res) => {
  try {
    const { domain, user_id, link_proof } = addWebsiteSchema.parse(req.body);
    
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
          error: `Website limit reached. Your plan allows ${userWithPlan.website_limit} websites.`
        });
      }
    }

    // Normalise domain (strip protocol/www, lowercase) to match the connect path.
    let normDomain: string;
    try {
      normDomain = new URL(domain).hostname.replace(/^www\./, '').toLowerCase().trim();
    } catch (_) {
      normDomain = domain.replace(/^www\./, '').toLowerCase().trim();
    }

    // Same hard block as connect: site actively owned by a DIFFERENT account.
    const allRows = await findWebsiteByDomain(normDomain);
    const activeElsewhere = allRows.find((r) => r.active && r.user_id !== user_id);
    if (activeElsewhere) {
      return res.status(409).json({
        success: false,
        error: 'This website is currently connected to another account. Remove it there first.',
        code: 'DOMAIN_CONFLICT',
      });
    }

    // Reuse own active / reactivate own soft-deleted / create fresh.
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

    // Free credits require a verified company email (single-use proof from
    // verify-link-code) — the same gate as the plugin connect flow. Adding a site
    // without a proof still works, but grants nothing.
    const verifiedEmail = await consumeLinkProof(link_proof, user_id, normDomain);
    const trial_status = verifiedEmail
      ? await grantFreeCreditsWithEmail(user_id, website.id, normDomain, verifiedEmail)
      : 'unverified';

    res.status(201).json({
      success: true,
      data: website,
      trial_status, // 'granted' | 'account_used' | 'domain_used' | 'email_used' | 'unverified'
    });
    
  } catch (error) {
    console.error('Add website error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to add website'
    });
  }
});

// Delete website
router.delete('/:website_id', async (req, res) => {
  try {
    const website_id = parseInt(req.params.website_id);
    console.log('Deleting website:', website_id);
    await deleteWebsite(website_id);
    console.log('Website deleted successfully:', website_id);
    
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