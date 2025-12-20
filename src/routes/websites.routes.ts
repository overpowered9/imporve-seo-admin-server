import express from 'express';
import { z } from 'zod';
import { 
  createWebsite, 
  getUserWebsites, 
  deleteWebsite,
  getUserWithPlan 
} from '../models/user.models.js';

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
    
    const website = await createWebsite(user_id, domain);
    
    res.status(201).json({
      success: true,
      data: website
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