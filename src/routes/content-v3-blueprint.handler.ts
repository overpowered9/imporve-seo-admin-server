/**
 * Admin tester: blueprint pins (X1–X7) and a preview.
 *
 *   POST /api/v1/content-v3/blueprint/preview — requireAdmin. Builds the <blueprint> block for the
 *   given article inputs and pins, with no model call (free). `seed` makes the draw repeatable.
 *
 * blueprintPinsSchema is the tester's pin contract, shared with /article/test (phase 8):
 *   article_type, opening, length_pattern, accent, summary {form, points, list}, optional_elements
 *   (multi-select), order (FAQ then closing / closing then FAQ), closing_move, closing_format,
 *   firmness, toc. There is deliberately NO body section count pin (decided 30 Oct) and no
 *   "woven in" FAQ placement. The point of view pin is not a blueprint pin: it travels as the
 *   request's point_of_view (Auto = Business details).
 */
import { Router, type RequestHandler, type Request, type Response } from 'express';
import { z } from 'zod';
import { ACCENTS, CLOSING_FORMATS, CLOSING_MOVES, FIRMNESS, LENGTH_PATTERNS, OPENINGS } from '../services/blueprint/pieces.js';
import { buildBlueprint, mulberry32, optionalPool, priceAvailable, type BlueprintPins } from '../services/blueprint/blueprint.js';
import { BLUEPRINT_PIECES_V1, TYPE_PIECE_KEYS } from '../services/blueprint/pieces.js';
import { buildNicheProfile } from '../services/niche-profile/niche-profile.js';

const ARTICLE_TYPES = ['cost', 'decision', 'question', 'topic'] as const;
const SIZES = ['small', 'medium', 'large'] as const;

export const blueprintPinsSchema = z
  .object({
    article_type: z.enum(ARTICLE_TYPES).optional(),
    opening: z.enum(OPENINGS).optional(),
    length_pattern: z.enum(LENGTH_PATTERNS).optional(),
    accent: z.enum(ACCENTS).optional(),
    summary: z
      .object({
        form: z.enum(['quick_answer', 'takeaways']),
        points: z.union([z.literal(3), z.literal(4), z.literal(5)]).optional(),
        list: z.enum(['bullets', 'numbered']).optional(),
      })
      .optional(),
    optional_elements: z.array(z.string().max(120)).max(10).optional(),
    order: z.enum(['faq_first', 'closing_first']).optional(),
    closing_move: z.enum(CLOSING_MOVES).optional(),
    closing_format: z.enum(CLOSING_FORMATS).optional(),
    firmness: z.enum(FIRMNESS).optional(),
    toc: z.boolean().optional(),
  })
  .strict();

/** Pins → BlueprintPins, dropping empty values. Errors read like the old override parser's. */
export function parseBlueprintPins(raw: unknown): { error?: string; pins?: BlueprintPins } {
  if (raw === undefined || raw === null) return {};
  const r = blueprintPinsSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    return { error: `blueprint_pins.${i.path.join('.')}: ${i.message}` };
  }
  const pins = Object.fromEntries(Object.entries(r.data).filter(([, v]) => v !== undefined)) as BlueprintPins;
  return { pins: Object.keys(pins).length ? pins : undefined };
}

export const previewSchema = z.object({
  article_type: z.enum(ARTICLE_TYPES),
  post_size: z.enum(SIZES),
  suggested_size: z.enum(SIZES).optional(),
  title: z.string().trim().min(1).max(200),
  reach: z.enum(['local', 'nationwide']).default('local'),
  readiness: z.string().max(40).optional(),
  niche: z.string().max(120).optional(),
  proof_level: z.enum(['standard', 'regulated']).default('standard'),
  body_questions: z.array(z.string().max(300)).max(12).default([]),
  faq_questions: z.array(z.string().max(300)).max(5).default([]),
  /** Texts to look for a price in (research facts, Business details pricing). */
  price_texts: z.array(z.string().max(600)).max(30).default([]),
  business_supplied: z.boolean().default(false),
  pins: z.unknown().optional(),
  seed: z.number().int().optional(),
});

export function createBlueprintRouter(deps: { auth: RequestHandler }): Router {
  const router = Router();
  /** The tester's choices: each type's optional pool, read from the pieces so the panel cannot drift. */
  router.get('/blueprint/options', deps.auth, (_req: Request, res: Response) => {
    const pools = Object.fromEntries(
      ARTICLE_TYPES.map((t) => [t, optionalPool(BLUEPRINT_PIECES_V1[TYPE_PIECE_KEYS[t]]).map((e) => ({ label: e.label, local_only: e.localOnly, supplied_only: e.suppliedOnly || e.sourcedOrSupplied }))]),
    );
    res.json({ success: true, data: { pools, openings: OPENINGS, length_patterns: LENGTH_PATTERNS, accents: ACCENTS, closing_moves: CLOSING_MOVES, closing_formats: CLOSING_FORMATS, firmness: FIRMNESS } });
  });
  router.post('/blueprint/preview', deps.auth, (req: Request, res: Response) => {
    const parsed = previewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'invalid_request', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    const b = parsed.data;
    const pins = parseBlueprintPins(b.pins);
    if (pins.error) return res.status(400).json({ success: false, error: 'invalid_request', message: pins.error });
    const niche = buildNicheProfile({ niche: b.niche, reach: b.reach, proofLevel: b.proof_level, articleType: pins.pins?.article_type ?? b.article_type, title: b.title });
    const logs: string[] = [];
    const r = buildBlueprint(
      {
        articleType: b.article_type,
        postSize: b.post_size,
        suggestedSize: b.suggested_size,
        title: b.title,
        reach: b.reach,
        readiness: b.readiness,
        bodyQuestions: b.body_questions,
        faqQuestions: b.faq_questions,
        firmest: niche.firmest,
        priceAvailable: priceAvailable(b.price_texts),
        businessSupplied: b.business_supplied,
        pins: pins.pins,
        rng: b.seed !== undefined ? mulberry32(b.seed) : undefined,
      },
      (l) => logs.push(l),
    );
    return res.json({ success: true, data: { blueprint: r.block, niche_profile: niche.block, picks: r.picks, fingerprint: r.fingerprint, redraws: r.redraws, logs } });
  });
  return router;
}
