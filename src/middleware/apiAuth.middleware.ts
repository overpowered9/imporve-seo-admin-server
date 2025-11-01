import { Request, Response, NextFunction } from 'express';
import { findUserByApiKey, findWebsiteByCode, getUserCreditBalance } from '../models/user.models.js';

export interface AuthenticatedRequest extends Request {
  user?: any;
  website?: any;
}

export const validateApiAccess = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const api_key = req.headers['x-api-key'] as string;
    const site_code = req.headers['x-site-code'] as string;
    const origin = req.headers.origin || req.headers.referer;

    if (!api_key || !site_code) {
      return res.status(401).json({
        success: false,
        error: 'API key and site code are required'
      });
    }

    // Find user by API key
    const user = await findUserByApiKey(api_key);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid API key'
      });
    }

    // Find website by site code and verify ownership
    const website = await findWebsiteByCode(site_code, user.id);
    if (!website) {
      return res.status(403).json({
        success: false,
        error: 'Website not found or not authorized'
      });
    }

    // Optional: Verify origin matches website domain
    if (origin && !origin.includes(website.domain)) {
      console.warn(`Origin mismatch: ${origin} vs ${website.domain}`);
      // You might want to enforce this check or just log it
    }

    // Attach user and website to request
    req.user = user;
    req.website = website;
    
    next();
  } catch (error) {
    console.error('API validation error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed'
    });
  }
};

export const validateCredits = (creditType: 'images' | 'content' | 'keywords', requiredAmount: number = 1) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: 'User not authenticated'
        });
      }

      const balance = await getUserCreditBalance(req.user.id, creditType);
      
      if (balance < requiredAmount) {
        return res.status(402).json({
          success: false,
          error: `Insufficient ${creditType} credits. Required: ${requiredAmount}, Available: ${balance}`,
          creditType,
          required: requiredAmount,
          available: balance
        });
      }

      next();
    } catch (error) {
      console.error('Credit validation error:', error);
      res.status(500).json({
        success: false,
        error: 'Credit validation failed'
      });
    }
  };
};