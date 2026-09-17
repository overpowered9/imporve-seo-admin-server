import { Router, type Request, type Response } from 'express';
import { creditsPerPiece, piecesForCredits } from '../config/credits.config.js';

const router = Router();

/** Enough for a pricing grid plus a balance; anything longer is not a UI asking. */
const MAX_VALUES = 20;

/**
 * How many pieces of content a number of credits buys.
 * GET /api/v1/credits/estimate?credits=100
 * GET /api/v1/credits/estimate?credits=100,200,600
 *
 * The ONE place the "≈ N pieces" figure is calculated. The CMS and the plugin
 * both ask here instead of dividing on their own, so the same credits always
 * show the same number of pieces everywhere.
 *
 * Public: it is arithmetic over the published price table, nothing account-specific.
 */
router.get('/estimate', (req: Request, res: Response) => {
  const raw = String(req.query.credits ?? '').trim();
  const parts = raw === '' ? [] : raw.split(',').map((s) => s.trim());

  if (parts.length === 0 || parts.length > MAX_VALUES) {
    return res.status(400).json({
      success: false,
      error: `Pass 1-${MAX_VALUES} comma-separated credit amounts as ?credits=`,
    });
  }

  const values = parts.map(Number);
  if (values.some((v) => !Number.isFinite(v) || v < 0)) {
    return res.status(400).json({ success: false, error: 'Credit amounts must be non-negative numbers' });
  }

  res.json({
    success: true,
    data: {
      credits_per_piece: creditsPerPiece(),
      estimates: values.map((credits) => ({ credits, pieces: piecesForCredits(credits) })),
    },
  });
});

export default router;
