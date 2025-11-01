import express from 'express';
import { z } from 'zod';
import { 
  findUserByEmail,
  findUserByApiKey,
  getUserCreditBalances,
  getUserWebsites,
  getUserWithPlan,
  getUserAnalytics,
  getUserGenerations,
  getUserWebsiteStats,
  addUserWebsite,
  deleteUserWebsite,
  getUserSubscription
} from '../models/user.models.js';

const router = express.Router();

// Get user by email (for frontend auth context)
router.post('/by-email', async (req, res) => {
  try {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    
    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Get user with plan details
    const userWithPlan = await getUserWithPlan(user.id);
    
    // Get credit balances
    const credits = await getUserCreditBalances(user.id);
    
    // Get websites
    const websites = await getUserWebsites(user.id);
    
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        api_key: user.api_key,
        plan_id: user.plan_id,
        plan_name: userWithPlan?.plan_name,
        plan_slug: userWithPlan?.plan_slug,
        website_limit: userWithPlan?.website_limit,
        scheduled_publishing: userWithPlan?.scheduled_publishing,
        course_access: userWithPlan?.course_access,
        credits,
        websites_count: websites.length,
        created_at: user.created_at
      }
    });
    
  } catch (error) {
    console.error('Get user by email error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get user'
    });
  }
});

// Get user profile (authenticated route)
router.get('/profile/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    
    const user = await getUserWithPlan(user_id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const credits = await getUserCreditBalances(user_id);
    const websites = await getUserWebsites(user_id);
    
    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          api_key: user.api_key,
          plan_id: user.plan_id,
          plan_name: user.plan_name,
          plan_slug: user.plan_slug,
          website_limit: user.website_limit,
          scheduled_publishing: user.scheduled_publishing,
          course_access: user.course_access,
          created_at: user.created_at
        },
        credits,
        websites,
        statistics: {
          websites_count: websites.length,
          active_websites: websites.filter(w => w.active).length
        }
      }
    });
    
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user profile'
    });
  }
});

// Get user websites
router.get('/websites/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    const websites = await getUserWebsites(user_id);
    
    res.json({
      success: true,
      data: websites
    });
  } catch (error) {
    console.error('Get user websites error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user websites'
    });
  }
});

// Add user website
router.post('/websites', async (req, res) => {
  try {
    const { user_id, url, name } = z.object({
      user_id: z.number(),
      url: z.string().url(),
      name: z.string()
    }).parse(req.body);
    
    const website = await addUserWebsite(user_id, url, name);
    
    res.json({
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

// Delete user website
router.delete('/websites/:website_id', async (req, res) => {
  try {
    const website_id = parseInt(req.params.website_id);
    
    await deleteUserWebsite(website_id);
    
    res.json({
      success: true,
      message: 'Website deleted successfully'
    });
  } catch (error) {
    console.error('Delete website error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete website'
    });
  }
});

// Get user credits
router.get('/credits/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    const credits = await getUserCreditBalances(user_id);
    
    res.json({
      success: true,
      data: credits
    });
  } catch (error) {
    console.error('Get user credits error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user credits'
    });
  }
});

// Get user subscription
router.get('/subscription/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    const subscription = await getUserSubscription(user_id);
    
    res.json({
      success: true,
      data: subscription
    });
  } catch (error) {
    console.error('Get user subscription error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user subscription'
    });
  }
});

// Get user analytics
router.get('/analytics/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    const analytics = await getUserAnalytics(user_id);
    
    res.json({
      success: true,
      data: analytics
    });
  } catch (error) {
    console.error('Get user analytics error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user analytics'
    });
  }
});

// Get user website stats
router.get('/website-stats/:user_id', async (req, res) => {
  try {
    const user_id = parseInt(req.params.user_id);
    const stats = await getUserWebsiteStats(user_id);
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Get website stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get website stats'
    });
  }
});

export default router;