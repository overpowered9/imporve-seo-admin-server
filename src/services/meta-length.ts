/**
 * Server-side SEO meta length enforcement.
 *
 * Meta fields have hard character budgets:
 *   - meta title:       50-60 characters (never over 60)
 *   - meta description: 150-160 characters (never over 160)
 *
 * Language models drift outside these budgets even when the prompt asks for a
 * specific range, so every server path that produces meta runs the value through
 * enforceMetaLength(): if it's out of range we re-run that field's own prompt a
 * few times, keep the first in-range candidate, and — as a last resort — hard-cap
 * to the max at a word boundary so we never ship an over-length tag.
 *
 * The module is framework-agnostic (no external imports) so it can be shared by
 * the content-v2 generator and the /auxiliary route.
 */

export type MetaKind = 'meta_title' | 'meta_description';

export const META_BOUNDS: Record<MetaKind, { min: number; max: number; label: string }> = {
  meta_title: { min: 50, max: 60, label: 'meta title' },
  meta_description: { min: 150, max: 160, label: 'meta description' },
};

/** Character count used for all budget checks (trimmed, spaces included). */
export function metaLength(text: string): number {
  return (text || '').trim().length;
}

export function isWithinMetaRange(text: string, kind: MetaKind): boolean {
  const { min, max } = META_BOUNDS[kind];
  const len = metaLength(text);
  return len >= min && len <= max;
}

/** How far a value is from the accepted range (0 when inside). Lower is better. */
export function distanceToMetaRange(text: string, kind: MetaKind): number {
  const { min, max } = META_BOUNDS[kind];
  const len = metaLength(text);
  if (len < min) return min - len;
  if (len > max) return len - max;
  return 0;
}

/** Trim to <= max characters at a word boundary, dropping trailing punctuation. */
export function clampMetaToMax(text: string, kind: MetaKind): string {
  const { max } = META_BOUNDS[kind];
  const s = (text || '').trim();
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  // Snap back to a word boundary only if it doesn't butcher the string.
  if (lastSpace > Math.floor(max * 0.6)) cut = cut.slice(0, lastSpace);
  return cut.replace(/[\s.,;:!?\-–—]+$/u, '').trim();
}

export interface EnforceMetaOptions {
  kind: MetaKind;
  /** Value produced by the primary generator (may already be valid). */
  current: string;
  /**
   * Re-run the field's own prompt. `attempt` is 1-based. A returned empty string
   * or a thrown error are both treated as a failed attempt.
   */
  regenerate: (attempt: number) => Promise<string>;
  /** How many re-prompts to try before falling back (default 3). */
  maxAttempts?: number;
  /** Optional per-attempt observer (logging/metrics). */
  onAttempt?: (info: { attempt: number; candidate: string; accepted: boolean }) => void;
}

/**
 * Return an in-range value for a meta field. If `current` already fits, it is
 * returned untouched. Otherwise the field's prompt is re-run up to `maxAttempts`
 * times; the first in-range candidate wins. If none land in range we keep the
 * closest candidate and hard-cap it to the max so the result never exceeds the
 * budget.
 */
export async function enforceMetaLength(opts: EnforceMetaOptions): Promise<string> {
  const { kind, regenerate } = opts;
  const maxAttempts = opts.maxAttempts ?? 3;
  let best = (opts.current || '').trim();

  if (isWithinMetaRange(best, kind)) return best;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let candidate = '';
    try {
      candidate = ((await regenerate(attempt)) || '').trim();
    } catch {
      candidate = '';
    }
    const accepted = candidate !== '' && isWithinMetaRange(candidate, kind);
    if (opts.onAttempt) opts.onAttempt({ attempt, candidate, accepted });
    if (accepted) return candidate;
    if (candidate && (best === '' || distanceToMetaRange(candidate, kind) < distanceToMetaRange(best, kind))) {
      best = candidate;
    }
  }

  // Couldn't land in range after retries — never ship something over the hard max.
  return clampMetaToMax(best, kind);
}
