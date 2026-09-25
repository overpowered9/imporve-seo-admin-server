/**
 * Site code ↔ domain: how a caller's domain is compared, and when a Settings save may move a
 * site code to the domain that saved it ("claim on save" — see apiAuth.middleware.ts).
 *
 * The pure helpers are exercised directly. The middleware and model are checked as source
 * assertions, for the same reason as models/website-connection.test.ts: their SQL closes over
 * the module-level `sql`, so it cannot run against a fake. The failure modes that matter here
 * are a guard going missing — a claim that no longer needs the header, a move that forgets
 * `active = true`, a mismatch that stops being refused — and a grep catches those precisely.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDomain, isSiteClaim } from './siteDomain.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const models = fs.readFileSync(path.join(SRC, 'models/user.models.ts'), 'utf8');
const middleware = fs.readFileSync(path.join(SRC, 'middleware/apiAuth.middleware.ts'), 'utf8');

/** Source with // and * comment lines dropped, so a clause quoted in prose can't satisfy a check. */
const codeOf = (source: string) =>
  source.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

describe('normalizeDomain', () => {
  test('scheme, www, path, query, port, case and trailing dot all compare equal', () => {
    for (const input of [
      'divineflowliving.com',
      'https://www.divineflowliving.com/',
      'http://divineflowliving.com:8080/wp-admin?x=1',
      'WWW.DivineFlowLiving.COM.',
      '  divineflowliving.com#top  ',
    ]) {
      assert.equal(normalizeDomain(input), 'divineflowliving.com', input);
    }
  });

  test('a different host stays different — no substring matching', () => {
    assert.notEqual(normalizeDomain('evil-example.com'), normalizeDomain('example.com'));
    assert.notEqual(normalizeDomain('abc.com'), normalizeDomain('divineflowliving.com'));
  });

  test('a subdomain is its own website', () => {
    assert.equal(normalizeDomain('https://shop.example.com'), 'shop.example.com');
  });
});

describe('isSiteClaim', () => {
  test('a claim needs the header AND the plugin\'s own x-site-domain', () => {
    assert.equal(isSiteClaim({ 'x-site-claim': '1', 'x-site-domain': 'divineflowliving.com' }), true);
  });

  test('no header, or any other value, is not a claim', () => {
    assert.equal(isSiteClaim({ 'x-site-domain': 'divineflowliving.com' }), false);
    assert.equal(isSiteClaim({ 'x-site-claim': '0', 'x-site-domain': 'divineflowliving.com' }), false);
    assert.equal(isSiteClaim({ 'x-site-claim': 'true', 'x-site-domain': 'divineflowliving.com' }), false);
  });

  test('never inferred from Origin/Referer — the header without x-site-domain does nothing', () => {
    assert.equal(isSiteClaim({ 'x-site-claim': '1', origin: 'https://divineflowliving.com' }), false);
    assert.equal(isSiteClaim({ 'x-site-claim': '1', referer: 'https://divineflowliving.com/wp-admin' }), false);
    assert.equal(isSiteClaim({ 'x-site-claim': '1', 'x-site-domain': '   ' }), false);
  });
});

describe('rebindWebsiteDomain', () => {
  const start = models.indexOf('export const rebindWebsiteDomain = async');
  const rest = models.slice(start + 10);
  const body = codeOf(rest.slice(0, rest.indexOf('\nexport ')));

  test('exists', () => {
    assert.ok(start >= 0, 'rebindWebsiteDomain not found — has it been renamed?');
  });

  test('moves only the domain, only of that one active website', () => {
    assert.match(body, /UPDATE websites/);
    assert.match(body, /SET domain = \$\{domain\}/);
    assert.match(body, /WHERE id = \$\{website_id\} AND active = true/);
    // Nothing else on the row changes: not its site code, owner, trial flag or active state.
    assert.doesNotMatch(body, /site_code\s*=|user_id\s*=|trial_used\s*=|active\s*=\s*false/);
  });
});

describe('apiAuth domain check', () => {
  const code = codeOf(middleware);

  test('uses the shared helpers rather than a private copy', () => {
    assert.match(code, /import \{ normalizeDomain, isSiteClaim \} from '\.\.\/utils\/siteDomain\.js'/);
    assert.doesNotMatch(code, /function normalizeDomain\(/);
  });

  test('a mismatch moves the website ONLY when the request is a claim', () => {
    const claimBranch = code.slice(code.indexOf('if (isSiteClaim(req.headers))'));
    assert.ok(code.includes('if (isSiteClaim(req.headers))'), 'claim branch missing');
    // The move is awaited inside the claim branch, before any refusal can be sent.
    assert.ok(claimBranch.indexOf('await rebindWebsiteDomain(website.id, claimed)') >= 0);
    assert.ok(
      claimBranch.indexOf('await rebindWebsiteDomain') < claimBranch.indexOf('} else if (registered) {'),
      'rebind must sit inside the claim branch'
    );
    // rebindWebsiteDomain is called from nowhere else in the middleware.
    assert.equal(code.split('rebindWebsiteDomain(').length - 1, 1);
  });

  test('without a claim, a mismatch is still refused with 403 in enforce mode', () => {
    const refuse = code.slice(code.indexOf('} else if (registered) {'));
    assert.match(refuse, /DOMAIN_ENFORCEMENT === 'enforce'/);
    assert.match(refuse, /res\.status\(403\)/);
    assert.match(refuse, /code: 'SITE_DOMAIN_MISMATCH'/);
  });

  test('mode "off" still skips the whole check', () => {
    assert.match(code, /if \(DOMAIN_ENFORCEMENT !== 'off' && claimedDomain\)/);
  });
});
