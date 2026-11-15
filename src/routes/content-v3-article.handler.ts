/**
 * POST /api/v1/content-v3/article — the paid Content v3 article (plugin auth; W4, OPS4, B9, B12, G6).
 *
 * Billing (decided 14 Nov): exactly what v2 charges for the chosen size, through the same
 * reserve-then-refund path. The credits are debited BEFORE the model runs and refunded if the
 * article cannot be produced (the Writer failing 3 times, a provider outage, anything thrown).
 * Regeneration is priced from server history only: a successful content_v3 or content_v2 row for
 * this wizard slot (target_key = the session key). A second request for the same session while one
 * runs is refused (409), so a double click is charged once.
 *
 * Inputs: everything Approve title produced lives in the wizard session (title, plan, research,
 * the regulated suggestion); step 2's choices come in the body. A session that no longer holds
 * the plan answers 409 session_expired.
 *
 * After success: a user_generations row (type content_v3, the writer model — BUG3 for v3), one
 * content_v3_posts row (picks, fingerprint, headings, validator — B9/B12/V11), and the per-article
 * cost line for every step of the session.
 *
 * Pure handler with injected dependencies; content-v3.routes.ts does the live wiring.
 */
import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { REQUEST_ID_RE, RunNotRunningError, type RunsStore } from '../services/content-v3/runs.js';
import type { QuotaStore } from '../services/content-v3/quota.js';
import type { AuthenticatedRequest } from '../middleware/apiAuth.middleware.js';
import { contentV3Enabled, costCeilingUsd } from '../config/content-v3.config.js';
import type { ContentV3Store, ContentV3PostRow } from '../services/content-v3/store.js';
import { toV3UserError, v3Error, v3ErrorBody } from '../services/content-v3/user-errors.js';
import { sessionKeySchema } from './content-v3-plugin.handler.js';
import type { ArticleV3Input, ArticleV3Result } from '../services/writer/article.js';
import type { PlannerStepOutput } from '../services/content-v3-steps/planner.step.js';
import type { ResearchResult } from '../services/research/research.service.js';
import type { BlueprintPins } from '../services/blueprint/blueprint.js';
import { createCostLedger } from '../services/model-call.js';
import { runContext } from '../services/run-context.js';

const SIZES = ['small', 'medium', 'large'] as const;
export const SIZE_WORDS: Record<(typeof SIZES)[number], string> = { small: '600 to 1200 words', medium: '1200 to 2400 words', large: '2400 to 3600 words' };

const txt = (max: number) => z.string().trim().max(max).optional();

export const articleRequestSchema = z.object({
  session_key: sessionKeySchema,
  /** B-3: one id per click, kept by the plugin until the article arrives; a retry with it replays. */
  request_id: z.string().trim().regex(REQUEST_ID_RE, 'request_id is not valid').optional(),
  article_type: z.enum(['cost', 'decision', 'question', 'topic']).optional(),
  post_size: z.enum(SIZES),
  /** Step 2's Keep (true) / Turn off (false); omitted or null when no regulated line was shown. */
  regulated: z.boolean().nullable().optional(),
  point_of_view: z.enum(['we', 'i', 'business_name']).optional(),
  tone: txt(40),
  language: txt(40),
  business_name: txt(120),
  stand_out: txt(600),
  business_pricing: txt(600),
  cta_text: txt(300),
  cta_url: z.string().trim().max(500).regex(/^(https?:\/\/|mailto:|tel:)/i, 'cta_url must be a web, mailto or tel link').optional().or(z.literal('')),
  cta_phone: txt(40),
  owner_answers: z.array(z.object({ question: z.string().trim().max(400), answer: z.string().trim().max(600) })).max(2).optional(),
  anything_else: txt(1000),
});

export type ArticleRequest = z.infer<typeof articleRequestSchema>;

export interface BillingDeps {
  isRegeneration: (userId: number, targetKey: string) => Promise<boolean>;
  price: (action: 'content' | 'content_regen', variant: (typeof SIZES)[number]) => number;
  reserve: (userId: number, cost: number, reason: string, websiteId?: number) => Promise<{ ok: boolean; balance_after?: number }>;
  refund: (userId: number, cost: number, reason: string, websiteId?: number) => Promise<void>;
  /** The 402 body's numbers (same message as v2). */
  shortfall: (userId: number, cost: number) => Promise<{ available: number; also_affords: string | null }>;
}

export interface GenerationRow {
  user_id: number;
  website_id: number | null;
  parameters: Record<string, unknown>;
  result: Record<string, unknown>;
  metadata: Record<string, unknown>;
  processing_time_ms: number;
  target_key: string;
  custom_instruction: string | null;
}

export interface ContentV3ArticleDeps {
  auth: RequestHandler;
  store: () => Promise<ContentV3Store>;
  billing: BillingDeps;
  generate: (input: ArticleV3Input, opts: { runId: string; deadlineAt?: number }) => Promise<ArticleV3Result>;
  insertGeneration: (row: GenerationRow) => Promise<number | null>;
  /** B-3: the run ledger (migration 024). Absent or unavailable → the in-process lock only. */
  runs?: RunsStore;
  /** B-3: the whole request's budget; below the plugin's 600 s timeout. Default 480 s. */
  deadlineMs?: number;
  /**
   * A3 (decision 14 Nov): the niche and profile keys that have a disclaimer text. A Regulated
   * business whose niche has none stays on v2 (409 v3_regulated_disabled, before any charge).
   */
  disclaimerKeys?: () => Promise<string[]>;
  /** B-5: per-minute limiter per account (none = no limit). */
  rateLimit?: RequestHandler;
  /** M1: false while the v3 tables (migrations 023 and 024) are missing; the article is then refused as v3 off. */
  ready?: () => Promise<boolean>;
  /** B-5: today's counters; a delivered article raises the free steps' daily allowance. */
  quota?: () => Promise<QuotaStore>;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  now?: () => number;
}

export const DEFAULT_ARTICLE_DEADLINE_MS = 480_000;
/** A running ledger row older than the deadline plus this is from a dead process (B-3). */
export const STALE_GRACE_MS = 60_000;
/**
 * The longest article deadline any instance can be configured with (CONTENT_V3_ARTICLE_DEADLINE_MS
 * caps at 570 s). A run counts as stale only past this plus the grace, whatever this instance's own
 * deadline is, so an instance with a shorter one never closes another instance's live run.
 */
export const MAX_ARTICLE_DEADLINE_MS = 570_000;
export const STALE_AFTER_MS = MAX_ARTICLE_DEADLINE_MS + STALE_GRACE_MS;

/**
 * H2: the article generations this process is running. On shutdown (every deploy and the
 * rollback itself) they are failed at once, so each request refunds its credits and answers
 * within the drain window instead of being killed after the charge.
 */
const shutdownHooks = new Set<(err: Error) => void>();
export function abortInFlightArticles(): number {
  const hooks = [...shutdownHooks];
  for (const stop of hooks) stop(Object.assign(new Error('the server is restarting'), { status: 503, shutdown: true }));
  return hooks.length;
}
/** The generation promise gets this long past the deadline before the request gives up on it. */
const DEADLINE_GRACE_MS = 15_000;

/** Rejects with a "timed out" error (a plain timeout message for the user) when `ms` passes first. */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: no article within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** A3: true when a Regulated business may use v3 (its niche or profile has a disclaimer text). */
export function regulatedV3Allowed(keys: readonly string[], nicheKey: string | null | undefined, profileKey: string | null | undefined): boolean {
  return [nicheKey, profileKey].some((k) => !!k && keys.includes(k));
}

interface SessionShape {
  approved?: {
    title: string;
    seed_keyword: string;
    language?: string | null;
    niche?: string | null;
    niche_key?: string | null;
    niche_profile?: string | null;
    reach?: string | null;
    target_town?: string | null;
    proof_level?: string | null;
    featured_service?: string | null;
    business_description?: string | null;
    ideal_client?: string | null;
  };
  plan?: PlannerStepOutput;
  plan_meta?: { minimum_size?: (typeof SIZES)[number] | null };
  regulated?: { suggested?: boolean; by?: string | null };
  research?: { result?: ResearchResult };
  title_step?: { title?: string; form?: string; items?: number | null };
  cost?: Record<string, number>;
  bulk_batch?: string;
}

/** Bulk batches: the picks of the batch's earlier articles count as history too (B5). */
export function historyFor(rows: ContentV3PostRow[]): ArticleV3Input['history'] {
  return rows.map((r) => ({ article_type: r.article_type, picks: r.picks as never, fingerprint: r.fingerprint, headings: r.headings }));
}

export function createContentV3ArticleRouter(deps: ContentV3ArticleDeps): Router {
  const { env = process.env, log = (l) => console.log(l), now = () => Date.now() } = deps;
  const router = Router();
  const inFlight = new Set<string>();

  const pass: RequestHandler = (_req, _res, next) => next();
  router.use(runContext);
  router.post('/article', deps.auth, deps.rateLimit ?? pass, async (req: AuthenticatedRequest, res: Response) => {
    if (!contentV3Enabled(env)) return res.status(409).json(v3ErrorBody(v3Error('v3_disabled')));
    if (deps.ready && !(await deps.ready().catch(() => false))) return res.status(409).json(v3ErrorBody(v3Error('v3_disabled')));
    const parsed = articleRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(v3ErrorBody(v3Error('invalid_request', parsed.error.issues[0]?.message ?? 'The request was not valid.')));
    }
    const b = parsed.data;
    const userId = Number(req.user?.id);
    const websiteId = req.website?.id ? Number(req.website.id) : null;
    const lockKey = `${userId}:${b.session_key}`;
    if (inFlight.has(lockKey)) return res.status(409).json(v3ErrorBody(v3Error('already_generating')));
    // M1: taken before any await, so two near-simultaneous requests cannot both pass the check.
    inFlight.add(lockKey);
    try {

      const store = await deps.store();
      const session = ((await store.getSession(userId, websiteId ?? 0, b.session_key)) ?? {}) as SessionShape;
      if (!session.approved?.title || !session.plan) return res.status(409).json(v3ErrorBody(v3Error('session_expired')));
      const a = session.approved;
      // W8: a numbered title's minimum size holds on the server too (the wizard greys smaller sizes out).
      const minimum = session.plan_meta?.minimum_size;
      if (minimum && SIZES.indexOf(minimum) > SIZES.indexOf(b.post_size)) {
        const name = { small: 'Small', medium: 'Medium', large: 'Large' }[minimum];
        return res.status(400).json(v3ErrorBody(v3Error('invalid_request', `This title needs at least a ${name} post to deliver every item. Choose ${name} or larger.`)));
      }
      if (a.proof_level === 'regulated' && deps.disclaimerKeys) {
        const keys = await deps.disclaimerKeys().catch(() => [] as string[]);
        if (!regulatedV3Allowed(keys, a.niche_key, a.niche_profile)) {
          log(`[content-v3] article refused run=${b.session_key} reason=regulated_without_disclaimer niche=${a.niche_key ?? '-'}`);
          return res.status(409).json(v3ErrorBody(v3Error('v3_regulated_disabled')));
        }
      }

      // B-3: claim this request in the run ledger before any charge. A finished request with the same
      // request_id is answered from the ledger (no second charge); another run of this session → 409.
      const requestId = b.request_id ?? `srv_${randomUUID().replace(/-/g, '')}`;
      const deadlineMs = deps.deadlineMs ?? DEFAULT_ARTICLE_DEADLINE_MS;
      let ledgerId: number | null = null;
      if (deps.runs) {
        try {
          const claim = await deps.runs.claim({ user_id: userId, website_id: websiteId, session_key: b.session_key, request_id: requestId, stale_after_ms: Math.max(deadlineMs + STALE_GRACE_MS, STALE_AFTER_MS) });
          if (claim.kind === 'replay') {
            log(`[content-v3] article replayed run=${b.session_key} request=${requestId} (no charge)`);
            return res.json(claim.response);
          }
          if (claim.kind === 'busy') return res.status(409).json(v3ErrorBody(v3Error('already_generating')));
          ledgerId = claim.id;
        } catch (err) {
          log(`[content-v3] runs ledger unavailable — using the in-process lock: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
        }
      }
      const ledgerWrite = async (what: string, fn: (runs: RunsStore, id: number) => Promise<void>) => {
        if (ledgerId === null || !deps.runs) return;
        // The charge record decides whether a stopped run is refunded (H2), so it gets a second try.
        const tries = what === 'charged' ? 2 : 1;
        for (let t = 1; t <= tries; t++) {
          try {
            await fn(deps.runs, ledgerId);
            return;
          } catch (err) {
            if (t === tries || err instanceof RunNotRunningError) {
              log(`[content-v3] runs ledger ${what} failed id=${ledgerId}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
              return;
            }
          }
        }
      };

      const variant = b.post_size;
      let charged = 0;
      const startedAt = now();
      const deadlineAt = startedAt + deadlineMs;
      // H2: registered before anything is charged, so a shutdown at any point fails this request at
      // once (the catch refunds) instead of the process dying after the charge.
      let stop: (err: Error) => void = () => {};
      const stopped = new Promise<never>((_resolve, reject) => {
        stop = reject;
      });
      stopped.catch(() => {});
      shutdownHooks.add(stop);
      try {
        const regen = await deps.billing.isRegeneration(userId, b.session_key);
        const action = regen ? 'content_regen' : 'content';
        const cost = deps.billing.price(action, variant);
        const reservation = await deps.billing.reserve(userId, cost, `Content v3 (${regen ? 'regen' : 'new'}, ${variant}): ${a.seed_keyword.substring(0, 180)}`, websiteId ?? undefined);
        if (!reservation.ok) {
          await ledgerWrite('failed', (runs, id) => runs.failed(id, { error: 'insufficient_credits', refund_pending: false }));
          const s = await deps.billing.shortfall(userId, cost);
          return res.status(402).json({
            success: false,
            error: 'insufficient_credits',
            message: s.also_affords
              ? `Not enough credits: this needs ${cost} and you have ${s.available}. Your balance is still enough for ${s.also_affords}.`
              : `Not enough credits: this needs ${cost} and you have ${s.available}.`,
            required: cost,
            available: s.available,
            shortfall: Math.max(0, cost - s.available),
            also_affords: s.also_affords,
          });
        }
        charged = cost;
        await ledgerWrite('charged', (runs, id) => runs.charged(id, { cost, action, variant }));

        // C9: the blueprint keeps the last 20 posts of the article's type, so read enough rows to find them.
        const history = historyFor(await store.recentPosts(userId, websiteId ?? 0, 100));
        const started = now();
        const generation = deps.generate(
          {
            title: a.title,
            seed_keyword: a.seed_keyword,
            language: b.language || a.language || undefined,
            niche: a.niche_key || a.niche || undefined,
            niche_profile: a.niche_profile ?? null,
            reach: a.reach === 'nationwide' ? 'nationwide' : 'local',
            target_town: a.target_town || undefined,
            featured_service: a.featured_service || undefined,
            business_description: a.business_description || undefined,
            ideal_client: a.ideal_client || undefined,
            business_name: b.business_name,
            stand_out: b.stand_out,
            business_pricing: b.business_pricing,
            business_proof_level: a.proof_level === 'regulated' ? 'regulated' : 'standard',
            regulated_suggested: !!session.regulated?.suggested,
            regulated_choice: b.regulated ?? null,
            plan: session.plan,
            title_form: session.title_step?.title === a.title ? session.title_step.form : null,
            title_items: session.title_step?.title === a.title ? session.title_step.items ?? null : null,
            research: session.research?.result?.research ?? null,
            article_type: b.article_type,
            post_size: variant,
            point_of_view: b.point_of_view,
            tone: b.tone,
            cta: { text: b.cta_text, url: b.cta_url || undefined, phone: b.cta_phone },
            post_answers: b.owner_answers?.filter((x) => x.answer),
            anything_else: b.anything_else,
            history,
          },
          { runId: b.session_key, deadlineAt },
        );
        // B-3: the model calls stop at the deadline; this bounds anything else that could hang.
        const r = await withDeadline(Promise.race([generation, stopped]), Math.max(1_000, deadlineAt - now()) + DEADLINE_GRACE_MS);
        shutdownHooks.delete(stop);
        const processing = now() - started;

        const generationId = await deps.insertGeneration({
          user_id: userId,
          website_id: websiteId,
          parameters: { seed_keyword: a.seed_keyword, title: a.title, niche: a.niche_key || a.niche, post_size: variant, nos_of_words: SIZE_WORDS[variant], article_type: r.article_type, proof_level: r.proof_level, language: b.language || a.language },
          result: { content: r.content, meta_title: r.meta_title, meta_description: r.meta_description, faq: r.faq, faq_schema: r.faq_schema },
          metadata: {
            method: 'claude-v3',
            model: r.model,
            prompt_version: r.prompt_version,
            prompt_versions: r.prompt_versions,
            picks: r.picks,
            fingerprint: r.fingerprint,
            validator: r.validator,
            needs_review: r.needs_review,
            repaired: r.repaired,
            billed: { action, variant, cost },
          },
          processing_time_ms: processing,
          target_key: b.session_key,
          custom_instruction: b.anything_else || null,
        });

        await store.recordPost({
          user_id: userId,
          website_id: websiteId ?? 0,
          session_key: b.session_key,
          bulk_batch: session.bulk_batch ?? null,
          article_type: r.article_type,
          post_size: variant,
          proof_level: r.proof_level,
          picks: r.picks as unknown as Record<string, unknown>,
          fingerprint: r.fingerprint,
          headings: r.headings,
          validator: r.validator as unknown as Record<string, unknown>,
        });

        const ledger = createCostLedger();
        for (const [step, usd] of Object.entries(session.cost ?? {})) ledger.add(step, Number(usd) || 0);
        ledger.add('writer', r.cost.writer, r.usage.writer as never);
        ledger.add('meta', r.cost.meta, r.usage.meta as never);
        log(ledger.line(b.session_key));
        // D: a warning when one article cost us more than its size's ceiling (billing unchanged).
        const ceiling = costCeilingUsd(env)[variant];
        const spent = ledger.total();
        if (spent !== null && spent > ceiling) {
          log(`[content-v3] cost over ceiling run=${b.session_key} size=${variant} total=${spent.toFixed(4)} ceiling=${ceiling.toFixed(2)} credits=${cost}`);
        }
        log(`[content-v3] latency run=${b.session_key} route=article ms=${now() - startedAt} writer_ms=${r.timings.writer_ms} meta_ms=${r.timings.meta_ms} writer_attempts=${r.writer_attempts}`);
        await store.mergeSession(userId, websiteId ?? 0, b.session_key, {
          last_article: { generation_id: generationId, fingerprint: r.fingerprint, proof_level: r.proof_level, needs_review: r.needs_review },
        });

        const body = {
          success: true,
          data: {
            generation_id: generationId,
            title: a.title,
            content: r.content,
            meta_title: r.meta_title,
            meta_description: r.meta_description,
            faq: r.faq,
            faq_schema: r.faq_schema,
            proof_level: r.proof_level,
            article_type: r.article_type,
            needs_review: r.needs_review,
            review: {
              passed: r.validator.passed,
              word_count: r.validator.word_count,
              issues: r.validator.issues.map((i) => ({ code: i.code, severity: i.severity, message: i.message })),
            },
          },
          metadata: {
            method: 'claude-v3',
            model: r.model,
            prompt_version: r.prompt_version,
            processing_time_ms: processing,
            cost_usd: ledger.total(),
            credits: { charged: cost, action, variant, balance_after: reservation.balance_after ?? null },
          },
        };
        // B-3: the answer is kept, so a retry of this click replays it instead of buying it again.
        await ledgerWrite('succeeded', (runs, id) =>
          runs.succeeded(id, {
            generation_id: generationId,
            response: body,
            step_costs: { ...(session.cost ?? {}), writer: r.cost.writer ?? 0, meta: r.cost.meta ?? 0 },
            timings: { total_ms: now() - startedAt, writer_ms: r.timings.writer_ms, meta_ms: r.timings.meta_ms },
          }),
        );
        // B-5: count the delivered article (raises today's allowance for the free steps).
        if (deps.quota) {
          await deps
            .quota()
            .then((q) => q.countArticle(userId))
            .catch((err) => log(`[content-v3] article not counted run=${b.session_key}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`));
        }
        return res.json(body);
      } catch (err) {
        shutdownHooks.delete(stop);
        let refundFailed = false;
        let refundedHere = false;
        const message = err instanceof Error ? err.message : String(err);
        if (charged > 0) {
          // H2: take the row before refunding (running → refunding). If the stale sweep already took
          // it, the refund queue pays it back instead, so it is never refunded twice.
          let mayRefund = true;
          let ledgerHeld = false;
          if (ledgerId !== null && deps.runs) {
            try {
              await deps.runs.startRefund(ledgerId, message);
              ledgerHeld = true;
            } catch (e) {
              if (e instanceof RunNotRunningError) {
                mayRefund = false;
                log(`[content-v3] article failed run=${b.session_key}: its run was already closed by the stale sweep, which refunds it`);
              }
            }
          }
          if (mayRefund) {
            await deps.billing
              .refund(userId, charged, `Refund — content v3 generation failed: ${a.seed_keyword.substring(0, 160)}`, websiteId ?? undefined)
              .then(() => {
                refundedHere = true;
              })
              .catch((e) => {
                refundFailed = true;
                log(`[content-v3] REFUND FAILED user=${userId} amount=${charged} (${ledgerId !== null ? 'queued for retry' : 'no ledger: refund by hand'}): ${e instanceof Error ? e.message : String(e)}`);
              });
            if (ledgerHeld && deps.runs) {
              await deps.runs.refundDone(ledgerId!, refundedHere).catch((e) => log(`[content-v3] runs ledger refundDone failed id=${ledgerId}: ${e instanceof Error ? e.message : String(e)}`));
            } else {
              await ledgerWrite('failed', (runs, id) => runs.failed(id, { error: message, refund_pending: refundFailed }));
            }
          }
        } else {
          await ledgerWrite('failed', (runs, id) => runs.failed(id, { error: message, refund_pending: false }));
        }
        log(`[content-v3] article failed run=${b.session_key} refunded=${refundedHere ? charged : 0}: ${message}`);
        const e = (err as { shutdown?: boolean }).shutdown
          ? v3Error(
              'service_unavailable',
              refundedHere
                ? 'The server restarted while writing this article. Your credits were refunded. Please try again in a minute.'
                : 'The server restarted while writing this article. Your credits will be refunded automatically. Please try again in a minute.',
            )
          : toV3UserError(err);
        return res.status(e.status).json(v3ErrorBody(e));
      } finally {
        shutdownHooks.delete(stop);
        inFlight.delete(lockKey);
      }
    } finally {
      inFlight.delete(lockKey);
    }
  });

  return router;
}

export type { BlueprintPins };
