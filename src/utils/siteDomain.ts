import type { IncomingHttpHeaders } from 'node:http';

/**
 * Strips scheme, "www.", path, query, trailing dot and port so "https://www.example.com/" and
 * "example.com:443" compare equal. The same shape POST /websites stores (bare host, no www).
 */
export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

/**
 * True when the plugin is saving these credentials on its Settings screen and asks to connect
 * THIS website with them: `x-site-claim: 1` together with an explicit `x-site-domain`.
 *
 * A claim moves the site code's website to the calling domain (see apiAuth.middleware.ts), so
 * it only counts with the plugin's own `x-site-domain` — never inferred from Origin/Referer.
 * The plugin sends the header on its Settings save check only; generation, heartbeat and the
 * "Confirm website connection" button never do, so background traffic from two sites holding
 * the same code cannot flip it back and forth.
 */
export function isSiteClaim(headers: IncomingHttpHeaders): boolean {
  const claim = String(headers['x-site-claim'] ?? '').trim();
  const domain = String(headers['x-site-domain'] ?? '').trim();
  return claim === '1' && domain !== '';
}
