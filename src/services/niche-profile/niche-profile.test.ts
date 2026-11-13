import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DOC_PATH, docBlock, repoDocBlocks, assertSameText } from '../content-v3/doc-blocks.js';
import {
  DEFAULT_NICHE_SETTINGS,
  buildNicheProfile,
  hasTaskTrigger,
  nicheContext,
  parseNicheSettings,
  resolveNiche,
  typeAdjustments,
} from './niche-profile.js';
import { NICHE_REGULATED_PIECE_V1, NICHE_STANDARD_PIECE_V1, TYPE_ADJUSTMENT_LINES } from './pieces.js';

const md = fs.readFileSync(DOC_PATH, 'utf8');
const section = (from: string, to: string) => md.slice(md.indexOf(from), md.indexOf(to, md.indexOf(from)));
const rows = (text: string) =>
  text
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('|---') && !l.startsWith('| Profile |') && !l.startsWith('| Niche |') && !l.startsWith('| When |'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
const stripArticle = (s: string) => s.replace(/^(an|a|the)\s+/i, '').toLowerCase();

describe('doc tables = the settings', () => {
  test('Part 1: eight profiles, cell for cell', () => {
    const table = rows(section('### Part 1: eight profiles', '### Part 2: proof level'));
    assert.equal(table.length, 8);
    for (const [name, provider, help, softMedium, nationwide, pricing, detail, firmest] of table) {
      const p = DEFAULT_NICHE_SETTINGS.profiles.find((x) => x.name === name);
      assert.ok(p, name);
      assert.equal(p!.provider, provider, name);
      assert.equal(`"${p!.help_phrase}"`, help, name);
      const [soft, medium] = softMedium.split(' / ');
      assert.equal(stripArticle(p!.next_soft), soft.toLowerCase(), `${name} soft`);
      assert.equal(stripArticle(p!.next_medium), medium.toLowerCase(), `${name} medium`);
      if (nationwide === 'Not usual') assert.equal(p!.next_nationwide, null, name);
      else if (nationwide.includes(' / ')) {
        const [ns, nm] = nationwide.split(' / ');
        assert.equal(stripArticle(p!.next_nationwide!.soft), ns.toLowerCase());
        assert.equal(stripArticle(p!.next_nationwide!.medium), nm.toLowerCase());
      } else assert.ok(nationwide.toLowerCase().includes(stripArticle(p!.next_nationwide!.soft)), `${name} nationwide`);
      assert.equal(p!.pricing, pricing.toLowerCase(), `${name} pricing`);
      assert.equal(p!.local_detail.local, detail.split(/[;\s]/)[0].toLowerCase(), `${name} local detail`);
      if (/medium for online|low online/.test(detail)) assert.notEqual(p!.local_detail.nationwide, 'high', `${name} online detail`);
      assert.equal(p!.firmest, firmest.toLowerCase(), `${name} firmest`);
    }
  });

  test('Niche list: every niche has its row with the doc\'s profile, proof level and watchlist', () => {
    const table = rows(section('### Niche list, mapped', '### What the Writer receives: an example'));
    const splitNiches = (cell: string) => cell.split(/,\s(?![^()]*\))/).map((s) => s.replace(/\s*\(described\)$/, '').trim());
    for (const [niches, profileCell, proofCell, watch] of table) {
      for (const label of splitNiches(niches)) {
        const n = DEFAULT_NICHE_SETTINGS.niches.find((x) => x.label === label);
        assert.ok(n, `niche row for "${label}"`);
        if (!n!.choose_profile) {
          const profile = DEFAULT_NICHE_SETTINGS.profiles.find((p) => p.key === n!.profile)!;
          assert.equal(profile.name, profileCell, label);
        }
        assert.equal(n!.proof_level, proofCell.toLowerCase().startsWith('regulated') ? 'regulated' : 'standard', label);
        if (proofCell === 'Standard (open)') assert.equal(n!.proof_open, true);
        assert.equal(n!.watchlist, watch === '—' ? '' : watch, label);
      }
    }
  });

  test('Part 2 pieces verbatim; Part 3 lines verbatim', () => {
    const blocks = repoDocBlocks();
    const all = docBlock(blocks, 'Writer part 3: Niche profile', 'Part 2: proof level');
    assertSameText(`${NICHE_STANDARD_PIECE_V1}\n\n${NICHE_REGULATED_PIECE_V1}`, all, 'Standard + Regulated pieces');
    const lines = rows(section('### Part 3: type adjustments', '### Niche list, mapped')).map((r) => r[1]);
    assert.deepEqual([...Object.values(TYPE_ADJUSTMENT_LINES)].sort(), [...lines].sort());
  });
});

describe('resolveNiche', () => {
  test('v3 keys and labels, v2 keys, v2 option labels, synonyms; never a wrong word-part match', () => {
    assert.equal(resolveNiche('plumbing')!.label, 'Plumbing');
    assert.equal(resolveNiche('Dental/Orthodontics')!.key, 'dental');
    assert.equal(resolveNiche('realestate')!.key, 'real_estate');
    assert.equal(resolveNiche('mortgage')!.key, 'financial');
    assert.equal(resolveNiche('HVAC / Heating & Cooling')!.key, 'hvac');
    assert.equal(resolveNiche('Pet Services / Vet')!.key, 'pet_services');
    assert.equal(resolveNiche('Home Services (Pest Control, Cleaning, Locksmith, Moving, etc.)')!.key, 'home_services');
    assert.equal(resolveNiche('chiro')!.key, 'wellness');
    assert.equal(resolveNiche('velvet upholstery'), null);
    assert.equal(resolveNiche(''), null);
  });

  test('unknown or "Other" → Content only, unless the user picked the closest profile', () => {
    assert.equal(nicheContext('boat rentals').profile.key, 'content_only');
    assert.equal(nicheContext('boat rentals', { profileOverride: 'appointment' }).profile.key, 'appointment');
    assert.equal(nicheContext('other', { profileOverride: 'expertise' }).profile.key, 'expertise');
    assert.equal(nicheContext('plumbing', { profileOverride: 'expertise' }).profile.key, 'trades', 'a known niche keeps its profile');
  });

  test('an edited settings JSON is used when valid', () => {
    const edited = JSON.parse(JSON.stringify(DEFAULT_NICHE_SETTINGS));
    edited.niches.push({ key: 'boats', label: 'Boat Rentals', profile: 'appointment', proof_level: 'standard', watchlist: '' });
    const parsed = parseNicheSettings(JSON.stringify(edited))!;
    assert.equal(resolveNiche('Boat Rentals', parsed)!.profile, 'appointment');
    assert.equal(parseNicheSettings('{"profiles":[],"niches":[]}'), null);
    assert.equal(parseNicheSettings('{"profiles":[{"key":"x"}],"niches":[{"key":"n","label":"N","profile":"missing"}]}'), null);
  });
});

describe('<niche_profile> block (N4)', () => {
  test('Plumbing, local, Standard: the doc example\'s shape, watchlist filled in', () => {
    const r = buildNicheProfile({ niche: 'plumbing', reach: 'local', proofLevel: 'standard', articleType: 'cost', title: 'Water heater repair cost in Española' });
    assert.equal(
      r.block,
      [
        '<niche_profile>',
        'NICHE: Plumbing. PROFILE: Trades and repair.',
        'The provider: a licensed plumber. Professional help, in these words: "call a licensed plumber".',
        'Next step: soft = an assessment; medium = an estimate or quote. Firmest allowed: direct.',
        'Pricing in this niche: ranges per job.',
        'Local detail matters a lot here.',
        'PROOF LEVEL: STANDARD',
        'Claims follow the shared rules. Watch these words in this niche: safety and code claims (electrical, gas, structural).',
        'A sentence that uses one of them needs a source token or a business detail',
        'behind it, and promises nothing.',
        '</niche_profile>',
      ].join('\n'),
    );
    assert.equal(r.firmest, 'direct');
  });

  test('Regulated post: the Regulated piece verbatim; nationwide next step; type adjustment lines', () => {
    const r = buildNicheProfile({ niche: 'legal_services', reach: 'nationwide', proofLevel: 'regulated', articleType: 'cost', title: 'How much does a divorce lawyer cost' });
    assert.ok(r.block.includes(`PROOF LEVEL: ${NICHE_REGULATED_PIECE_V1}`));
    assert.match(r.block, /Next step \(nationwide\): soft = a consultation by phone or video; medium = a consultation by phone or video\. Firmest allowed: direct\./);
    assert.match(r.block, /Local detail matters somewhat here\./);
    assert.deepEqual(r.adjustments, [TYPE_ADJUSTMENT_LINES.cost_money_legal]);
    assert.ok(r.block.trimEnd().endsWith(`${TYPE_ADJUSTMENT_LINES.cost_money_legal}\n</niche_profile>`));
  });

  test('"Not usual" nationwide; Content only gets soft firmness and its adjustment', () => {
    const a = buildNicheProfile({ niche: 'restaurant', reach: 'nationwide', proofLevel: 'standard', articleType: 'topic', title: 'x' });
    assert.match(a.block, /Next step \(nationwide\): none is usual for this kind of business\./);
    const b = buildNicheProfile({ niche: 'general_blog', reach: 'local', proofLevel: 'standard', articleType: 'decision', title: 'x' });
    assert.equal(b.firmest, 'soft');
    assert.deepEqual(b.adjustments, [TYPE_ADJUSTMENT_LINES.decision_content_or_shops, TYPE_ADJUSTMENT_LINES.any_content_or_online_shops]);
  });

  test('N3 rows: question/topic need Regulated; topic needs the task trigger; online shops', () => {
    assert.deepEqual(typeAdjustments({ articleType: 'question', profile: 'trades', regulated: false, taskTrigger: false, nationwide: false }), []);
    assert.deepEqual(typeAdjustments({ articleType: 'question', profile: 'trades', regulated: true, taskTrigger: false, nationwide: false }), [TYPE_ADJUSTMENT_LINES.question_regulated]);
    assert.deepEqual(typeAdjustments({ articleType: 'topic', profile: 'health', regulated: true, taskTrigger: true, nationwide: false }), [TYPE_ADJUSTMENT_LINES.topic_task_regulated]);
    assert.deepEqual(typeAdjustments({ articleType: 'cost', profile: 'health', regulated: true, taskTrigger: false, nationwide: false }), [TYPE_ADJUSTMENT_LINES.cost_health_care]);
    assert.deepEqual(typeAdjustments({ articleType: 'topic', profile: 'shops', regulated: false, taskTrigger: false, nationwide: true }), [TYPE_ADJUSTMENT_LINES.any_content_or_online_shops]);
    assert.deepEqual(typeAdjustments({ articleType: 'topic', profile: 'shops', regulated: false, taskTrigger: false, nationwide: false }), []);
    assert.equal(hasTaskTrigger('How to prepare for a root canal'), true);
    assert.equal(hasTaskTrigger('Root canal cost'), false);
  });

  test('a Standard niche with no watchlist says so instead of an empty gap', () => {
    const r = buildNicheProfile({ niche: 'dental', reach: 'local', proofLevel: 'standard', articleType: 'topic', title: 'x' });
    assert.match(r.block, /Watch these words in this niche: none listed for this niche\./);
  });
});
