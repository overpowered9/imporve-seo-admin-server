/**
 * The 10-keyword run (production gate): every case in docs/content-v3-test-keywords.json through the
 * full Content v3 chain — search data → Title → Research → Planner → regulated check → Writer → meta
 * — with the same code as the admin route POST /content-v3/article/test. No credits move and nothing
 * is published; model and DataForSEO costs are real (about $0.25 per keyword without research).
 *
 *   npm run v3:ten-keywords [-- --only <case id>,<case id>] [-- --seed 7]
 *
 * Output (git-ignored, not served): data/v3-runs/<timestamp>/results.jsonl and review.html — the
 * review sheet: a summary table, then per keyword the inputs, search data, title, plan, blueprint
 * picks, the checks, cost and timings, the article and its meta, next to the doc's own
 * "What to check in testing" lists.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { runTestChain, type TestChainParams } from '../services/writer/test-chain.js';
import { lookupSearchData } from '../services/search-data/search-data.service.js';
import { liveSearchDataDeps } from '../services/search-data/search-data.default.js';
import { runTitleStep } from '../services/content-v3-steps/title.step.js';
import { liveTitleDeps, livePlannerDeps } from '../services/content-v3-steps/steps.default.js';
import { runResearch } from '../services/research/research.service.js';
import { liveResearchInstructions } from '../services/research/research.default.js';
import { runPlannerStep } from '../services/content-v3-steps/planner.step.js';
import { liveGenerateArticle } from '../services/writer/article.default.js';
import { DOC_PATH } from '../services/content-v3/doc-blocks.js';

interface Case {
  id: string;
  seed_keyword: string;
  niche: string;
  reach: 'local' | 'nationwide';
  target_town?: string;
  proof_level?: 'standard' | 'regulated';
  post_size: 'small' | 'medium' | 'large';
  business?: { business_name?: string; description?: string; stand_out?: string; featured_service?: string; ideal_client?: string };
  tone?: string;
  cta?: { text?: string; url?: string; phone?: string };
}

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/** The doc's "What to check in testing" bullets, by H2, read from the doc itself. */
export function testingChecklists(md: string): Array<{ section: string; items: string[] }> {
  const out: Array<{ section: string; items: string[] }> = [];
  const lines = md.split('\n');
  let h2 = '';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) h2 = lines[i].slice(3).trim();
    if (lines[i].trim() === '### What to check in testing') {
      const items: string[] = [];
      for (let j = i + 1; j < lines.length && !lines[j].startsWith('#') && !lines[j].startsWith('---'); j++) {
        if (lines[j].startsWith('- ')) items.push(lines[j].slice(2).trim());
      }
      if (items.length) out.push({ section: h2, items });
    }
  }
  return out;
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function main() {
  // --render <run dir> [--findings <html file>]: rebuild review.html from a run's results.jsonl.
  const renderDir = arg('render');
  if (renderDir) {
    const rows = fs.readFileSync(path.join(renderDir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const findings = arg('findings') ? fs.readFileSync(String(arg('findings')), 'utf8') : '';
    fs.writeFileSync(path.join(renderDir, 'review.html'), reviewSheet(rows, testingChecklists(fs.readFileSync(DOC_PATH, 'utf8')), findings));
    console.log(`Wrote ${renderDir}/review.html`);
    process.exit(0);
  }
  const file = path.join(process.cwd(), 'docs', 'content-v3-test-keywords.json');
  const all = (JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: Case[] }).cases;
  const only = arg('only')?.split(',');
  const cases = only ? all.filter((c) => only.includes(c.id)) : all;
  const seed = arg('seed') ? Number(arg('seed')) : undefined;
  if (process.env.MONGODB_URI) {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 }).catch(() => console.warn('Mongo unavailable: in-code prompt texts are used'));
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(process.cwd(), 'data', 'v3-runs', stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const results: Array<Record<string, unknown>> = [];

  for (const c of cases) {
    const started = Date.now();
    console.log(`\n=== ${c.id}: "${c.seed_keyword}" (${c.niche}, ${c.reach}${c.target_town ? `, ${c.target_town}` : ''}, ${c.post_size}${c.proof_level === 'regulated' ? ', regulated' : ''})`);
    const params: TestChainParams = {
      seed_keyword: c.seed_keyword,
      niche: c.niche,
      post_size: c.post_size,
      language: 'US English',
      reach: c.reach,
      target_town: c.target_town,
      business_name: c.business?.business_name,
      business_description: c.business?.description,
      stand_out: c.business?.stand_out,
      ideal_client: c.business?.ideal_client,
      featured_service: c.business?.featured_service,
      proof_level: c.proof_level ?? 'standard',
      tone: c.tone,
      point_of_view: 'we',
      cta: c.cta,
      seed,
    };
    try {
      const r = await runTestChain(params, {
        searchData: (q) => lookupSearchData(q, liveSearchDataDeps()),
        title: (input) => runTitleStep(input, liveTitleDeps()),
        research: (q) => runResearch(q, { resolveInstructions: () => liveResearchInstructions() }),
        planner: (input) => runPlannerStep(input, livePlannerDeps()),
        generate: (input) => liveGenerateArticle(input, { runId: `iseo_ten_${c.id}` }),
      });
      const a = r.article;
      const row = {
        id: c.id,
        case: c,
        ok: true,
        title: r.title,
        search_data: { mode: r.search_data.meta.mode, location: r.search_data.meta.location_used, national_fallback: r.search_data.meta.national_fallback, counts: r.search_data.meta.counts, calls: r.search_data.meta.calls, cost_usd: r.search_data.meta.cost_usd },
        research: r.research,
        plan: r.plan,
        plan_fallback: r.plan_fallback,
        regulated: r.regulated,
        proof_level: a.proof_level,
        picks: a.picks,
        fingerprint: a.fingerprint,
        validator: a.validator,
        needs_review: a.needs_review,
        repaired: a.repaired,
        writer_json: a.writer_json,
        meta_title: a.meta_title,
        meta_description: a.meta_description,
        content: a.content,
        cost: { search_data: r.search_data.meta.cost_usd, title: r.step_cost.title, research: r.research.cost_usd, planner: r.step_cost.planner, writer: a.cost.writer, meta: a.cost.meta },
        timings: { ...r.timings, total_ms: Date.now() - started },
        prompt_version: a.prompt_version,
        model: a.model,
      };
      results.push(row);
      console.log(`→ "${r.title}" | ${a.article_type}/${c.post_size} | ${a.validator.word_count} words | checks ${a.validator.passed ? 'pass' : `fail (${a.validator.issues.filter((i) => i.severity === 'error').map((i) => i.code).join(', ')})`}${a.repaired ? ' | repaired' : ''} | ${Math.round((Date.now() - started) / 1000)} s`);
    } catch (err) {
      results.push({ id: c.id, case: c, ok: false, error: err instanceof Error ? err.message : String(err), timings: { total_ms: Date.now() - started } });
      console.log(`→ FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    fs.appendFileSync(path.join(outDir, 'results.jsonl'), JSON.stringify(results[results.length - 1]) + '\n');
  }

  fs.writeFileSync(path.join(outDir, 'review.html'), reviewSheet(results, testingChecklists(fs.readFileSync(DOC_PATH, 'utf8'))));
  console.log(`\nWrote ${outDir}/results.jsonl and review.html`);
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}

function money(n: unknown) {
  return typeof n === 'number' ? `$${n.toFixed(4)}` : '—';
}

/** Prefix every id and in-page link in one article, so ten articles' tables of contents never collide. */
export function scopeIds(html: string, prefix: string): string {
  return html.replace(/\sid="([^"]+)"/g, (_m, id) => ` id="${prefix}-${id}"`).replace(/\shref="#([^"]+)"/g, (_m, id) => ` href="#${prefix}-${id}"`);
}

const sum = (cost: Record<string, unknown>) => Object.values(cost).reduce((x: number, v) => x + (typeof v === 'number' ? v : 0), 0);

export function reviewSheet(rows: Array<Record<string, any>>, checklists: Array<{ section: string; items: string[] }>, findingsHtml = ''): string {
  const okRows = rows.filter((r) => r.ok);
  const total = okRows.reduce((s, r) => s + sum(r.cost), 0);
  const passed = okRows.filter((r) => r.validator.passed).length;
  const repaired = okRows.filter((r) => r.repaired).length;
  const summary = rows
    .map((r) =>
      r.ok
        ? `<tr><td><a href="#${esc(r.id)}">${esc(r.id)}</a></td><td>${esc(r.case.seed_keyword)}</td><td class="title-cell">${esc(r.title)}</td><td>${esc(r.picks.article_type)}</td><td>${esc(r.case.post_size)}</td><td class="num">${esc(r.validator.word_count)}</td><td>${r.validator.passed ? '<span class="chip ok">pass</span>' : `<span class="chip bad">needs review</span> <span class="codes">${esc(r.validator.issues.filter((i: any) => i.severity === 'error').map((i: any) => i.code).join(', '))}</span>`}</td><td>${r.repaired ? 'yes' : '—'}</td><td>${esc(r.proof_level)}</td><td class="num">${money(sum(r.cost))}</td><td class="num">${Math.round(r.timings.total_ms / 1000)} s</td></tr>`
        : `<tr><td>${esc(r.id)}</td><td>${esc(r.case.seed_keyword)}</td><td colspan="9"><span class="chip bad">failed</span> ${esc(r.error)}</td></tr>`,
    )
    .join('');
  const details = okRows
    .map(
      (r) => `
<section class="case" id="${esc(r.id)}">
  <header class="case-head">
    <p class="eyebrow">${esc(r.case.niche)} · ${esc(r.case.reach)}${r.case.target_town ? ` · ${esc(r.case.target_town)}` : ''} · ${esc(r.case.post_size)} · ${esc(r.proof_level)}</p>
    <h2>${esc(r.case.seed_keyword)}</h2>
    <p class="case-title">${esc(r.title)} <span class="muted">(${esc(r.title.length)} characters)</span></p>
  </header>
  <div class="case-grid">
    <dl class="facts">
      <dt>Search data</dt><dd>${esc(r.search_data.mode)} · ${esc(r.search_data.location)} · national call ${r.search_data.national_fallback ? 'yes' : 'no'} · ${esc(r.search_data.counts.titles)} titles, ${esc(r.search_data.counts.questions)} questions, ${esc(r.search_data.counts.related)} related</dd>
      <dt>Research</dt><dd>${esc(r.research.status)} · ${esc(r.research.facts)} facts · ${esc(r.research.local_conditions)} local conditions</dd>
      <dt>Plan${r.plan_fallback ? ' (fallback)' : ''}</dt><dd>${esc(r.plan.article_type)}, suggested ${esc(r.plan.post_size)}. ${esc(r.plan.size_reason)}</dd>
      <dt>Body questions</dt><dd><ol>${(r.plan.body_questions as string[]).map((q) => `<li>${esc(q)}</li>`).join('')}</ol></dd>
      <dt>FAQ</dt><dd><ol>${(r.plan.faq_questions as string[]).map((q) => `<li>${esc(q)}</li>`).join('') || '<li>none</li>'}</ol></dd>
      <dt>Owner questions</dt><dd><ol>${(r.plan.owner_questions as string[]).map((q) => `<li>${esc(q)}</li>`).join('') || '<li>none</li>'}</ol></dd>
      <dt>Searcher</dt><dd>${esc(r.plan.searcher_profile?.situation)} <span class="muted">· readiness ${esc(r.plan.searcher_profile?.readiness || '—')}</span></dd>
      <dt>Regulated</dt><dd>${r.regulated.suggested ? `suggested by ${esc(r.regulated.by)}${r.regulated.phrase ? ` (${esc(r.regulated.phrase)})` : ''}` : 'no'}</dd>
      <dt>Blueprint</dt><dd><code>${esc(r.fingerprint)}</code> · ${esc(r.picks.summary_form)}${r.picks.takeaway_points ? ` ×${esc(r.picks.takeaway_points)}` : ''} · opening ${esc(r.picks.opening)} · ${esc(r.picks.sections)} sections (${esc((r.picks.word_targets as number[]).join(' / ') || 'items')}) · ${esc(r.picks.length_pattern)} · ${esc(r.picks.accent)} · ${esc(r.picks.order)} · closing ${esc(r.picks.closing_move)}, ${esc(r.picks.firmness)}${(r.picks.optional_elements as string[]).length ? ` · also ${esc((r.picks.optional_elements as string[]).join('; '))}` : ''}</dd>
      <dt>Checks</dt><dd><ul class="checks">${(r.validator.issues as any[]).map((i) => `<li class="${esc(i.severity)}"><span class="chip ${i.severity === 'error' ? 'bad' : 'warn'}">${esc(i.severity)}</span> ${esc(i.message)}${i.detail ? ` <span class="muted">${esc(i.detail)}</span>` : ''}</li>`).join('') || '<li><span class="chip ok">all passed</span></li>'}</ul></dd>
      <dt>Writer flagged</dt><dd><ul>${(r.writer_json.claims_to_check as string[]).map((c) => `<li>${esc(c)}</li>`).join('') || '<li>nothing</li>'}</ul></dd>
      <dt>Meta</dt><dd><strong>${esc(r.meta_title)}</strong> <span class="muted">(${esc(r.meta_title.length)})</span><br>${esc(r.meta_description)} <span class="muted">(${esc(r.meta_description.length)})</span></dd>
      <dt>Cost and time</dt><dd>search ${money(r.cost.search_data)} · title ${money(r.cost.title)} · research ${money(r.cost.research)} · planner ${money(r.cost.planner)} · writer ${money(r.cost.writer)} · meta ${money(r.cost.meta)} · ${Math.round(r.timings.total_ms / 1000)} s</dd>
    </dl>
    <article class="article">${scopeIds(r.content, r.id)}</article>
  </div>
</section>`,
    )
    .join('\n');
  const lists = checklists.map((c) => `<h3>${esc(c.section)}</h3><ul>${c.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`).join('');
  return `<title>Content v3 keyword review</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,400;0,600;0,700;1,400&family=IBM+Plex+Mono:wght@400;500&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<style>
/* Layout: a review ledger — summary table first, then one case per keyword: its plan and checks beside the article as a reader would see it. */
:root {
  --bg: #f6f7f9; --surface: #ffffff; --fg: #17202a; --muted: #5b6876; --line: #d9dee5;
  --accent: #0e7c86; --ok: #1d7a46; --ok-bg: #e3f3e9; --bad: #b4232c; --bad-bg: #fbe6e7; --warn: #8a5a00; --warn-bg: #fdf1d8;
  --font-ui: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-read: "Source Serif 4", Georgia, "Times New Roman", serif;
  --font-data: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #11161c; --surface: #18202a; --fg: #e6ebf0; --muted: #9aa7b4; --line: #2b3643;
  --accent: #46c1c9; --ok: #6fd39a; --ok-bg: #173526; --bad: #ff8a8f; --bad-bg: #3a1c20; --warn: #f2c165; --warn-bg: #3a2d12; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #11161c; --surface: #18202a; --fg: #e6ebf0; --muted: #9aa7b4; --line: #2b3643;
  --accent: #46c1c9; --ok: #6fd39a; --ok-bg: #173526; --bad: #ff8a8f; --bad-bg: #3a1c20; --warn: #f2c165; --warn-bg: #3a2d12; color-scheme: dark }
body { background: var(--bg); color: var(--fg); font: 15px/1.6 var(--font-ui); margin: 0; }
.wrap { max-width: 1320px; margin: 0 auto; padding-block: 32px 64px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: grid; gap: 28px; }
h1, h2, h3 { text-wrap: balance; line-height: 1.25; margin: 0; }
h1 { font-size: 1.9rem; font-weight: 700; }
.lede { color: var(--muted); max-width: 70ch; margin: 6px 0 0; }
.stats { display: flex; flex-wrap: wrap; gap: 8px 24px; font-family: var(--font-data); font-size: .85rem; color: var(--muted); }
.stats b { color: var(--fg); font-weight: 500; }
.table-box { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
table { border-collapse: collapse; width: 100%; font-size: .85rem; }
th, td { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { font-size: .72rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); font-weight: 600; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
td.num { font-family: var(--font-data); font-variant-numeric: tabular-nums; white-space: nowrap; }
td.title-cell { min-width: 220px; }
a { color: var(--accent); }
.chip { display: inline-block; font-size: .72rem; font-weight: 600; letter-spacing: .03em; padding: 1px 8px; border-radius: 999px; white-space: nowrap; }
.chip.ok { color: var(--ok); background: var(--ok-bg); } .chip.bad { color: var(--bad); background: var(--bad-bg); } .chip.warn { color: var(--warn); background: var(--warn-bg); }
.codes { font-family: var(--font-data); font-size: .75rem; color: var(--muted); }
.muted { color: var(--muted); }
.findings { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px 20px; }
.findings h2 { font-size: 1.15rem; margin-bottom: 8px; }
.findings li { margin: 6px 0; }
details { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 12px 18px; }
details summary { cursor: pointer; font-weight: 600; }
details h3 { font-size: .95rem; margin-top: 14px; }
.case { border-top: 3px solid var(--fg); padding-top: 16px; display: grid; gap: 16px; }
.eyebrow { font-family: var(--font-data); font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 4px; }
.case-head h2 { font-size: 1.4rem; }
.case-title { margin: 4px 0 0; font-size: 1.05rem; font-weight: 600; color: var(--accent); }
.case-grid { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 24px; align-items: start; }
.facts { margin: 0; display: grid; grid-template-columns: 9.5rem minmax(0, 1fr); gap: 6px 12px; font-size: .88rem; }
.facts dt { color: var(--muted); font-weight: 600; font-size: .8rem; padding-top: 2px; }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.facts ol, .facts ul { margin: 0; padding-left: 1.2rem; }
.checks { list-style: none; padding-left: 0 !important; }
.checks li { margin-bottom: 4px; }
code { font-family: var(--font-data); font-size: .82rem; }
.article { min-width: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 6px 24px 18px; font-family: var(--font-read); font-size: 1.02rem; line-height: 1.7; overflow-wrap: anywhere; }
.article h2 { font-family: var(--font-ui); font-size: 1.2rem; margin: 22px 0 6px; }
.article h3 { font-family: var(--font-ui); font-size: 1.02rem; margin: 16px 0 4px; }
.article table { font-family: var(--font-ui); display: block; overflow-x: auto; }
.article .iseo-toc { font-family: var(--font-ui); font-size: .85rem; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 14px; }
.article .iseo-disclaimer { color: var(--muted); font-size: .9rem; }
a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 900px) { .case-grid { grid-template-columns: 1fr; } .facts { grid-template-columns: 1fr; } .facts dt { padding-top: 6px; } }
</style>
<div class="wrap">
  <header>
    <h1>Content v3 keyword review</h1>
    <p class="lede">Each keyword went through the full chain (search data, title, research, plan, blueprint, writer, checks, meta) with the same code as the admin test route. No credits were charged and nothing was published. The keyword list is a working list; the real ten are not written down yet.</p>
  </header>
  <div class="stats"><span>run <b>${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC</b></span><span>keywords <b>${rows.length}</b></span><span>passed checks <b>${passed}</b></span><span>needed a second writer run <b>${repaired}</b></span><span>model + data cost <b>${money(total)}</b></span></div>
  ${findingsHtml ? `<section class="findings">${findingsHtml}</section>` : ''}
  <div class="table-box"><table><thead><tr><th>Case</th><th>Keyword</th><th>Title</th><th>Type</th><th>Size</th><th>Words</th><th>Checks</th><th>Second run</th><th>Proof</th><th>Cost</th><th>Time</th></tr></thead><tbody>${summary}</tbody></table></div>
  <details><summary>What to check in testing (from the prompt drafts)</summary>${lists}</details>
  ${details}
</div>`;
}

// Run only when this file itself is the entry point — never when a test imports it (a test file's
// name contains this one's, so a substring match started a real, paid run).
const invoked = !!process.argv[1] && /(?:^|[\\/])content-v3-ten-keywords\.(?:ts|js)$/.test(process.argv[1]);
if (invoked) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
