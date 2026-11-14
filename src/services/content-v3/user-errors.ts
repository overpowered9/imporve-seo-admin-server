/**
 * Plain, actionable error messages for the Content v3 routes (OPS6).
 *
 * A user never sees a provider's raw error ("529 overloaded_error", "ANTHROPIC_API_KEY is not
 * set", a stack, a JSON body). The route logs the internal detail and answers with one of these
 * codes and messages; the plugin shows `message` as-is and may branch on `code`.
 */
import { StepFailedError } from '../content-v3-steps/attempts.js';
import { ModelCallTimeoutError } from '../model-call.js';

export type V3ErrorCode =
  | 'v3_disabled'
  | 'invalid_request'
  | 'insufficient_credits'
  | 'rate_limited'
  | 'step_failed'
  | 'timeout'
  | 'service_unavailable'
  | 'not_configured'
  | 'session_expired'
  | 'already_generating'
  | 'v3_regulated_disabled'
  | 'server_error';

export interface V3UserError {
  status: number;
  code: V3ErrorCode;
  message: string;
}

const STEP_LABEL: Record<string, string> = {
  title: 'write a title',
  planner: 'plan the article',
  research: 'research the topic',
  writer: 'write the article',
  meta: 'write the meta title and description',
  search_data: 'look up search data',
};

export const V3_MESSAGES = {
  v3_disabled: 'Content v3 is not switched on for this site. Your post will be generated the usual way.',
  insufficient_credits: "You don't have enough credits for this post size. Buy more credits or choose a smaller size.",
  rate_limited: 'Too many requests in a short time. Please wait a minute and try again.',
  timeout: 'This is taking longer than usual. Please try again.',
  service_unavailable: 'The writing service is busy right now. Please try again in a minute.',
  not_configured: 'Content generation is not available right now. Please contact support if this continues.',
  server_error: 'Something went wrong on our side. Please try again. If it keeps happening, contact support.',
  session_expired: "This post's plan is no longer available. Go back to step 1 and approve the title again.",
  already_generating: 'This post is already being generated. Please wait for it to finish.',
  v3_regulated_disabled: 'Content v3 is not available for regulated businesses yet. Your post will be generated the usual way.',
} as const;

export function v3Error(code: V3ErrorCode, message?: string): V3UserError {
  const status: Record<V3ErrorCode, number> = {
    v3_disabled: 409,
    invalid_request: 400,
    insufficient_credits: 402,
    rate_limited: 429,
    step_failed: 502,
    timeout: 504,
    service_unavailable: 503,
    not_configured: 503,
    session_expired: 409,
    already_generating: 409,
    v3_regulated_disabled: 409,
    server_error: 500,
  };
  const fallback = (V3_MESSAGES as Record<string, string>)[code] ?? V3_MESSAGES.server_error;
  return { status: status[code], code, message: message ?? fallback };
}

/** Map anything thrown inside a v3 route to a user-safe error. The caller logs `err` itself. */
export function toV3UserError(err: unknown): V3UserError {
  if (err instanceof StepFailedError) {
    const allTimeouts = err.attempts.length > 0 && err.attempts.every((a) => (a.reason ?? '').includes('timed out after'));
    if (allTimeouts) return v3Error('timeout');
    const what = STEP_LABEL[err.step] ?? 'finish this step';
    return v3Error('step_failed', `We couldn't ${what} this time. Please try again.`);
  }
  if (err instanceof ModelCallTimeoutError) return v3Error('timeout');
  const e = err as { status?: number; message?: string; code?: string } | null;
  const msg = (e?.message ?? '').toLowerCase();
  if (msg.includes('api_key') || msg.includes('api key') || msg.includes('not configured') || msg.includes('is not set')) return v3Error('not_configured');
  if (e?.status === 402 || msg.includes('insufficient credits')) return v3Error('insufficient_credits');
  if (e?.status === 429) return v3Error('rate_limited');
  if (e?.status === 529 || e?.status === 503 || e?.status === 502 || msg.includes('overloaded')) return v3Error('service_unavailable');
  if (msg.includes('timed out') || msg.includes('timeout') || e?.code === 'ETIMEDOUT') return v3Error('timeout');
  return v3Error('server_error');
}

/** The JSON body every v3 route answers an error with. */
export function v3ErrorBody(e: V3UserError): { success: false; error: V3ErrorCode; message: string } {
  return { success: false, error: e.code, message: e.message };
}
