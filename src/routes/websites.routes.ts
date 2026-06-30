import express from 'express';
import { z } from 'zod';
import {
  createWebsite,
  getUserWebsites,
  deleteWebsite,
  getUserWithPlan,
  findWebsiteByDomain,
} from '../models/user.models.js';
import sql from '../data/db.js';

const router = express.Router();

const addWebsiteSchema = z.object({
  domain: z.string().url(),
  user_id: z.number()
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
    const { domain, user_id } = addWebsiteSchema.parse(req.body);
    
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

    // NOTE: NO free-credit grant here. Adding a domain in the dashboard proves
    // nothing about ownership — anyone can type any domain. Free credits are only
    // awarded through the plugin connect flow (issue-connect-token), which proves
    // the user controls the site (the connect token is minted by the plugin running
    // on that actual WordPress install). This is the "verified domain" requirement.
    res.status(201).json({
      success: true,
      data: website,
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