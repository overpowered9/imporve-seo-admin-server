import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertSameText, docBlock, repoDocBlocks } from '../content-v3/doc-blocks.js';
import {
  RULES_FORMATTING_V1,
  RULES_HUMAN_STYLE_V1,
  RULES_LOCAL_SEO_V1,
  RULES_NO_INVENTION_V1,
  RULES_READER_FIRST_V1,
  RULES_SEO_V1,
  WRITER_CORE_V2,
  buildWriterSystem,
} from './prompt.js';
import { buildWriterUserMessage } from './user-message.js';
import {
  addTableOfContents,
  extractFaq,
  insertDisclaimer,
  linkSourceTokens,
  parseWriterOutput,
  sanitizeArticle,
  splitSections,
  WRITER_MARKER,
} from './postprocess.js';
import { countWords, keywordInFirstWords, validateArticle } from './validator.js';
import { finalProofLevel, generateArticleV3, writerPromptLabel, type ArticleV3Input } from './article.js';
import { buildBlueprint, mulberry32, type BlueprintPicks } from '../blueprint/blueprint.js';
import type { ProviderCall } from '../model-call.js';
import type { MappedResearch } from '../research/research.service.js';

// ---------------------------------------------------------------- fixtures

const words = (n: number, w = 'water heater detail') => Array.from({ length: Math.ceil(n / w.split(' ').length) }, () => w).join(' ').split(' ').slice(0, n).join(' ');

/** A valid article for the picks: intro, summary, body sections, FAQ and closing in order. */
function article(p: BlueprintPicks, opts: { faq: string[]; keyword?: string; bodyWords?: number; tokens?: string[]; extra?: string } = { faq: [] }): string {
  const kw = opts.keyword ?? 'water heater repair cost';
  const intro = `<p>Water heater repair cost in Española depends on the part that failed. ${kw} questions come up every winter.</p><p>${words(40)}</p>`;
  const summary =
    p.summary_form === 'quick_answer'
      ? `<h2 data-iseo="quick-answer">What a water heater repair costs in Española</h2><p>${words(50)}</p>`
      : `<h2 data-iseo="takeaways">Key takeaways: water heater repair prices</h2><ul>${Array.from({ length: p.takeaway_points ?? 4 }, (_, i) => `<li>Point ${i} ${words(12)}</li>`).join('')}</ul>`;
  const sections = p.numbered && p.numbered.grouping === 'h2_items' ? p.numbered.items : p.sections;
  const firsts = ['Thermostat', 'Element', 'Anode', 'Valve', 'Tank', 'Burner', 'Pilot', 'Sediment', 'Permit', 'Venting', 'Pressure', 'Leak', 'Flue', 'Drain', 'Gas'];
  const tokens = opts.tokens ?? [];
  const body = Array.from({ length: sections }, (_, i) => `<h2 data-iseo="body">${firsts[i]} repairs and what they involve</h2><p>${words(opts.bodyWords ?? Math.max(130, Math.round((p.word_targets[i] ?? 200))))}${tokens[i] ? ` [${tokens[i]}]` : ''}</p>`).join('');
  const faq = opts.faq.length ? `<h2 data-iseo="faq">Common questions about water heater repairs</h2>${opts.faq.map((q) => `<h3>${q}</h3><p>${words(30)}</p>`).join('')}` : '';
  const closing = `<h2 data-iseo="closing">Book a water heater repair in Española</h2><p>${words(40)}</p>`;
  const last = p.order === 'faq_first' ? faq + closing : closing + faq;
  return intro + summary + body + (opts.extra ?? '') + last;
}

const PLAN = {
  article_type: 'cost' as const,
  type_reason: '',
  post_size: 'medium' as const,
  size_reason: '',
  body_questions: ['What does a repair cost?', 'What drives the price?', 'Repair or replace?', 'How to avoid overpaying?', 'Do I need a permit?', 'How long does it take?'],
  faq_questions: ['Is it worth repairing an old heater?', 'How long do tanks last?', 'Can I fix it myself?', 'Who should I call?'],
  searcher_profile: { situation: 'No hot water', main_concern: 'price', desired_outcome: 'hot water back', readiness: 'comparing' as const, their_words: ['no hot water', 'leaking'], reassurance: 'most fixes are quick' },
  ideal_client_gap: '',
  owner_questions: [],
  regulated_topic: false,
  regulated_reason: '',
  demand_notes: null,
  overlap: null,
};

const RESEARCH: MappedResearch = {
  facts: [
    { token: 'S1', claim: 'Repairs run $150 to $700.', scope: 'national', conflict: false, source: { url: 'https://www.energy.gov/a', title: 'a', date: null } },
    { token: 'S2', claim: 'Tanks last 8 to 12 years.', scope: 'general', conflict: false, source: { url: 'https://extension.nmsu.edu/b', title: 'b', date: null } },
    { token: 'S3', claim: 'Permits are required.', scope: 'state', conflict: false, source: { url: 'https://nm.gov/c', title: 'c', date: null } },
  ],
  follow_up_questions: [],
  local_conditions: [{ token: 'S4', claim: 'Hard water is common.', source: { url: 'https://espanola.gov/d', title: 'd', date: null } }],
  notes: '',
  sources: {
    S1: { url: 'https://www.energy.gov/a', title: 'a', date: null },
    S2: { url: 'https://extension.nmsu.edu/b', title: 'b', date: null },
    S3: { url: 'https://nm.gov/c', title: 'c', date: null },
    S4: { url: 'https://espanola.gov/d', title: 'd', date: null },
  },
  dropped: { facts: 0, questions: 0, conditions: 0 },
};

// ---------------------------------------------------------------- prompts

describe('Writer prompt texts = the doc (WR1)', () => {
  const b = repoDocBlocks();
  test('core and the six rules blocks, byte for byte', () => {
    assertSameText(WRITER_CORE_V2, docBlock(b, 'PROMPT 4 · Writer (#10), part 1: core', 'System prompt: core'), 'WRITER_CORE_V2');
    assertSameText(RULES_SEO_V1, docBlock(b, 'Writer part 4: SEO rules blocks', '`<rules_seo>`'), 'RULES_SEO_V1');
    assertSameText(RULES_LOCAL_SEO_V1, docBlock(b, 'Writer part 4: SEO rules blocks', '`<rules_local_seo>`'), 'RULES_LOCAL_SEO_V1');
    assertSameText(RULES_NO_INVENTION_V1, docBlock(b, 'Writer part 5: Shared rules blocks', '`<rules_no_invention>`'), 'RULES_NO_INVENTION_V1');
    assertSameText(RULES_READER_FIRST_V1, docBlock(b, 'Writer part 5: Shared rules blocks', '`<rules_reader_first>`'), 'RULES_READER_FIRST_V1');
    assertSameText(RULES_HUMAN_STYLE_V1, docBlock(b, 'Writer part 5: Shared rules blocks', '`<rules_human_style>`'), 'RULES_HUMAN_STYLE_V1');
    assertSameText(RULES_FORMATTING_V1, docBlock(b, 'Writer part 5: Shared rules blocks', '`<rules_formatting>`'), 'RULES_FORMATTING_V1');
  });

  test('system = core, then the blocks in the core\'s order, each in its tag (C1)', () => {
    const s = buildWriterSystem();
    assert.ok(s.startsWith(WRITER_CORE_V2));
    const order = ['rules_no_invention', 'rules_reader_first', 'rules_human_style', 'rules_seo', 'rules_local_seo', 'rules_formatting'];
    let at = 0;
    for (const name of order) {
      const i = s.indexOf(`<${name}>\n`, at);
      assert.ok(i > at, name);
      assert.ok(s.indexOf(`\n</${name}>`, i) > i, `${name} closed`);
      at = i;
    }
    assert.ok(buildWriterSystem({ rules_seo: 'EDITED' }).includes('<rules_seo>\nEDITED\n</rules_seo>'));
  });

  test('the user message follows the doc template order; empty tags left out', () => {
    const u = buildWriterUserMessage({
      nicheProfile: '<niche_profile>\nNP\n</niche_profile>',
      blueprint: '<blueprint>\nBP\n</blueprint>',
      recentHeadings: '',
      title: 'T',
      seed_keyword: 'k',
      language: 'US English',
      post_size: 'medium',
      business_name: 'Acme Plumbing',
      reach: 'local',
      target_town: 'Española',
      tone: 'friendly',
      point_of_view: 'we',
      cta: { text: 'Book a visit', url: 'https://acme.example/book' },
      post_answers: [{ question: 'Typical cost?', answer: 'About $300 with parts.' }],
      searcher_profile: PLAN.searcher_profile,
      research: RESEARCH,
    });
    const order = ['<niche_profile>', '<blueprint>', '<title>T</title>', '<seed_keyword>', '<language>', '<post_size>medium: 1200 to 2400 words</post_size>', '<business_name>', '<reach>', '<target_town>', '<tone>', '<point_of_view>we / our</point_of_view>', '<cta url="https://acme.example/book">Book a visit</cta>', '<post_answers>', '<answer question="Typical cost?">About $300 with parts.</answer>', '<searcher_profile>', '<their_words>no hot water; leaking</their_words>', '<research>', '<fact id="S1" scope="national">', '<local_conditions>', '<condition id="S4">', 'Write the article.'];
    let at = 0;
    for (const part of order) {
      const i = u.indexOf(part, at);
      assert.ok(i >= at, `missing or out of order: ${part}`);
      at = i;
    }
    assert.doesNotMatch(u, /<recent_headings>|<stand_out>|<anything_else>|<follow_up_questions>/);
  });
});

// ---------------------------------------------------------------- post-processing

describe('parse, sanitize, link, TOC, disclaimer, FAQ', () => {
  test('parseWriterOutput: marker + JSON; missing marker, short article and bad JSON throw', () => {
    const body = `<p>${words(80)}</p>`;
    const r = parseWriterOutput(`${body}\n${WRITER_MARKER}\n{"facts_used":[{"claim":"x","from":"S1"}],"claims_to_check":[],"items_delivered":null}`);
    assert.equal(r.html, body);
    assert.equal(r.json.facts_used[0].from, 'S1');
    assert.throws(() => parseWriterOutput(body), /marker/);
    assert.throws(() => parseWriterOutput(`<p>short</p>\n${WRITER_MARKER}\n{}`), /too short/);
    assert.throws(() => parseWriterOutput(`${body}\n${WRITER_MARKER}\nnot json`), /unreadable/);
    assert.equal(parseWriterOutput(`${body}\n${WRITER_MARKER}\n\`\`\`json\n{"items_delivered":7}\n\`\`\``).json.items_delivered, 7);
  });

  test('sanitizer keeps only the allowlist (WR10)', () => {
    const { html } = sanitizeArticle('```html\n<h1>T</h1><div><p class="a" style="b">x <b>y</b> <i>z</i></p></div><h2 data-iseo="body" id="q">H</h2><h2 data-iseo="bogus">H2</h2><h4>sub</h4><script>bad()</script><hr><a href="javascript:x">j</a><a href="tel:+1505">call</a>\n```');
    assert.equal(html, '<h2>T</h2><p>x <strong>y</strong> <em>z</em></p><h2 data-iseo="body">H</h2><h2>H2</h2><h3>sub</h3>j<a href="tel:+1505">call</a>');
  });

  test('tokens: first use of up to 4 sources linked, repeats and extras removed, unknown logged, none in headings', () => {
    const src = { ...RESEARCH.sources, S5: { url: 'https://e.com/5', title: '', date: null } };
    const { html, report } = linkSourceTokens('<h2 data-iseo="body">Costs [S1]</h2><p>A [S1]. B [S2]. A again [S1]. C [S3]. D [S4]. E [S5]. F [S9].</p>', src);
    assert.equal(report.linked.length, 4);
    assert.deepEqual(report.unknown, ['S9']);
    assert.match(html, /<h2 data-iseo="body">Costs<\/h2>/);
    assert.match(html, /A \(<a href="https:\/\/www\.energy\.gov\/a" target="_blank" rel="noopener">energy\.gov<\/a>\)\. B/);
    assert.match(html, /A again\. C/);
    assert.match(html, /E\. F\./);
    assert.doesNotMatch(html, /\[S\d\]/);
  });

  test('TOC (C3): a nav after the summary, ids on the h2s; omitted when not picked', () => {
    const p = buildBlueprint({ articleType: 'cost', postSize: 'medium', title: 't', reach: 'local', bodyQuestions: PLAN.body_questions, faqQuestions: PLAN.faq_questions, firmest: 'direct', priceAvailable: true, businessSupplied: true, rng: mulberry32(1) }).picks;
    const a = article(p, { faq: PLAN.faq_questions });
    const withToc = addTableOfContents(a, { include: true });
    const { sections } = splitSections(withToc);
    assert.ok(/^<h2[^>]* id="[a-z0-9-]+"/.test(sections[0].html));
    const summaryEnd = withToc.indexOf('<nav class="iseo-toc"');
    assert.ok(summaryEnd > withToc.indexOf(sections[0].heading) && summaryEnd < withToc.indexOf('data-iseo="body"'));
    assert.doesNotMatch(addTableOfContents(a, { include: false }), /iseo-toc/);
  });

  test('disclaimer (G4): before the last two sections; never with an empty text', () => {
    const html = '<p>i</p><h2 data-iseo="body">B</h2><p>b</p><h2 data-iseo="faq">F</h2><p>f</p><h2 data-iseo="closing">C</h2><p>c</p>';
    assert.equal(insertDisclaimer(html, ''), html);
    const out = insertDisclaimer(html, 'This is general information, not advice for your case.');
    assert.ok(out.indexOf('iseo-disclaimer') < out.indexOf('data-iseo="faq"') && out.indexOf('iseo-disclaimer') > out.indexOf('data-iseo="body"'));
  });

  test('FAQ from the HTML (WR6, BUG2 server side)', () => {
    const faq = extractFaq('<h2 data-iseo="faq">Questions about heaters</h2><h3>How long?</h3><p>About a day.</p><h3>Cost?</h3><p>Varies.</p><h2 data-iseo="closing">Book</h2><p>x</p>');
    assert.deepEqual(faq, [{ question: 'How long?', answer: 'About a day.' }, { question: 'Cost?', answer: 'Varies.' }]);
  });
});

// ---------------------------------------------------------------- validator

describe('validator (V1–V9, V11)', () => {
  const picksFor = (over: Partial<Parameters<typeof buildBlueprint>[0]> = {}) =>
    buildBlueprint({ articleType: 'cost', postSize: 'medium', title: 'Water heater repair cost in Española', reach: 'local', bodyQuestions: PLAN.body_questions, faqQuestions: PLAN.faq_questions, firmest: 'direct', priceAvailable: true, businessSupplied: true, rng: mulberry32(3), ...over }).picks;
  const base = (p: BlueprintPicks, html: string, extra: Partial<Parameters<typeof validateArticle>[0]> = {}) =>
    validateArticle({ html, picks: p, postSize: 'medium', seedKeyword: 'water heater repair cost', targetTown: 'Española', regulated: false, linkedSources: 0, ...extra });

  test('a well-formed article passes', () => {
    const p = picksFor();
    const r = base(p, article(p, { faq: PLAN.faq_questions.slice(0, p.faq_count) }));
    assert.equal(r.passed, true, JSON.stringify(r.issues));
  });

  test('each structural rule fails on its own', () => {
    const p = { ...picksFor(), summary_form: 'quick_answer' as const, takeaway_points: null, takeaway_list: null, order: 'faq_first' as const };
    const good = article(p, { faq: PLAN.faq_questions.slice(0, p.faq_count) });
    const codes = (html: string, extra = {}) => base(p, html, extra).issues.filter((i) => i.severity === 'error').map((i) => i.code);
    assert.deepEqual(codes(good), []);
    assert.ok(codes(good.replace('data-iseo="closing"', '')).includes('data_iseo'));
    assert.ok(codes(good.replace(/^<p>[\s\S]*?<\/p><p>[\s\S]*?<\/p>/, '')).includes('intro'));
    assert.ok(codes(good.replace(/<h3>[^<]*<\/h3><p>[^<]*<\/p>/, '')).includes('faq_count'));
    assert.ok(codes(good.replace('Book a water heater', 'Conclusion').replace(/<h2 data-iseo="closing">[^<]*<\/h2>/, '<h2 data-iseo="closing">Conclusion</h2>')).includes('fixed_label'));
    assert.ok(codes(good.replace('as mentioned', '').replace('</p><h2 data-iseo="faq">', ' As mentioned above, check it.</p><h2 data-iseo="faq">')).includes('back_reference'));
    assert.ok(codes(good, { regulated: true, linkedSources: 2 }).includes('regulated_sources'));
    const reordered = good.replace(/(<h2 data-iseo="faq">[\s\S]*?)(<h2 data-iseo="closing">[\s\S]*$)/, '$2$1');
    assert.ok(codes(reordered).includes('last_two'));
    const shortQa = good.replace(/(<h2 data-iseo="quick-answer">[^<]*<\/h2>)<p>[^<]*<\/p>/, '$1<p>Too short.</p>');
    assert.ok(codes(shortQa).includes('quick_answer_words'));
  });

  test('takeaways heading needs the "Key takeaways:" prefix (D21) and the planned count', () => {
    const p = { ...picksFor(), summary_form: 'takeaways' as const, takeaway_points: 4 as const, takeaway_list: 'bullets' as const };
    const html = article(p, { faq: PLAN.faq_questions.slice(0, p.faq_count) });
    assert.equal(base(p, html).passed, true, JSON.stringify(base(p, html).issues));
    assert.ok(base(p, html.replace('Key takeaways: water heater repair prices', 'Water heater prices')).issues.some((i) => i.code === 'takeaways'));
    assert.ok(base({ ...p, takeaway_points: 5 }, html).issues.some((i) => i.code === 'takeaways'));
  });

  test('question headings: at most 1 in 3', () => {
    const p = picksFor();
    let html = article(p, { faq: PLAN.faq_questions.slice(0, p.faq_count) });
    html = html.replace(/(<h2 data-iseo="body">)([^<]*)(<\/h2>)/g, '$1$2?$3');
    assert.ok(base(p, html).issues.some((i) => i.code === 'question_headings'));
  });

  test('numbered titles: exactly N items (or N + one leftover section)', () => {
    const p = picksFor({ title: '6 signs your water heater is failing', titleForm: 'numbered', titleItems: 6 });
    const html = article(p, { faq: PLAN.faq_questions.slice(0, p.faq_count), keyword: 'water heater repair cost' });
    assert.equal(base(p, html).issues.filter((i) => i.code === 'items_delivered').length, 0);
    assert.ok(base(p, html, { itemsDelivered: 5 }).issues.some((i) => i.code === 'items_delivered'));
    const fewer = html.replace(/<h2 data-iseo="body">Thermostat[\s\S]*?(?=<h2 data-iseo="body">)/, '').replace(/<h2 data-iseo="body">Element[\s\S]*?(?=<h2 data-iseo="body">)/, '');
    assert.ok(base(p, fewer).issues.some((i) => i.code === 'items_delivered'));
  });

  test('keyword in the first 100 words: exact, or every content word (town optional)', () => {
    assert.equal(keywordInFirstWords('<p>Fixing a water heater? Repair costs vary.</p>', 'water heater repair cost'), true);
    assert.equal(keywordInFirstWords('<p>Fixing a water heater? Repair costs vary.</p>', 'water heater repair cost española', 100, 'Española'), true);
    assert.equal(keywordInFirstWords(`<p>${'filler '.repeat(120)} water heater repair cost</p>`, 'water heater repair cost'), false);
    // 10-keyword run, 14 Nov: "If your furnace won't turn on" is the closest natural wording of "furnace not turning on".
    assert.equal(keywordInFirstWords("<p>If your furnace won't turn on, start with the simplest checks.</p>", 'furnace not turning on'), true);
    assert.equal(keywordInFirstWords('<p>A furnace that is not heating needs a look.</p>', 'furnace not turning on'), false);
  });

  test('word count within the size range; warnings never fail', () => {
    const p = picksFor();
    const html = article(p, { faq: PLAN.faq_questions.slice(0, p.faq_count), bodyWords: 600 });
    assert.ok(countWords(html) > 2400);
    assert.ok(base(p, html).issues.some((i) => i.code === 'word_count'));
    const warnOnly = base(p, article(p, { faq: PLAN.faq_questions.slice(0, p.faq_count) }), { unknownTokens: ['S9'], claimsToCheck: ['x'] });
    assert.equal(warnOnly.passed, true);
    assert.equal(warnOnly.warnings, 2);
  });
});

// ---------------------------------------------------------------- pipeline

function scripted(texts: Array<string | Error>): { call: ProviderCall; systems: string[]; users: string[] } {
  const state = { systems: [] as string[], users: [] as string[], i: 0, call: undefined as unknown as ProviderCall };
  state.call = async ({ system, user }) => {
    if (system.startsWith('You write SEO metadata')) {
      return { text: '{"meta_title":"Water heater repair cost in Española: what to expect","meta_description":"No hot water and a leaking tank? Here is what a water heater repair costs in Española, what drives the price, and when replacing makes more sense for you."}', usage: { input_tokens: 100, output_tokens: 50 } };
    }
    state.systems.push(system);
    state.users.push(user);
    const t = texts[Math.min(state.i++, texts.length - 1)];
    if (t instanceof Error) throw t;
    return { text: t, usage: { input_tokens: 9000, output_tokens: 3000, cache_read_input_tokens: state.i > 1 ? 7000 : 0, cache_creation_input_tokens: state.i > 1 ? 0 : 7000 } };
  };
  return state;
}

const INPUT = (over: Partial<ArticleV3Input> = {}): ArticleV3Input => ({
  title: 'Water heater repair cost in Española',
  seed_keyword: 'water heater repair cost',
  language: 'US English',
  niche: 'plumbing',
  reach: 'local',
  target_town: 'Española',
  business_name: 'Acme Plumbing',
  business_proof_level: 'standard',
  regulated_suggested: false,
  regulated_choice: null,
  plan: PLAN,
  research: RESEARCH,
  post_size: 'medium',
  point_of_view: 'we',
  tone: 'friendly',
  history: [],
  rng: mulberry32(7),
  ...over,
});

const DEPS = (call: ProviderCall, logs: string[] = []) => ({ call, writerModel: 'claude-sonnet-5', metaModel: 'claude-sonnet-5', writerTimeoutMs: 1000, metaTimeoutMs: 1000, log: (l: string) => logs.push(l) });

/** The article the scripted writer returns: valid for the picks the same seed will draw. */
function writerText(input: ArticleV3Input, mutate: (html: string) => string = (h) => h): string {
  const bp = buildBlueprint({ articleType: 'cost', postSize: input.post_size, suggestedSize: PLAN.post_size, title: input.title, reach: input.reach, readiness: 'comparing', bodyQuestions: PLAN.body_questions, faqQuestions: PLAN.faq_questions, firmest: 'direct', priceAvailable: true, businessSupplied: false, history: input.history, rng: mulberry32(7) });
  const html = mutate(article(bp.picks, { faq: PLAN.faq_questions.slice(0, bp.picks.faq_count), tokens: ['S1', 'S2', 'S3', 'S1'] }));
  return `${html}\n${WRITER_MARKER}\n{"facts_used":[{"claim":"Repairs run $150 to $700.","from":"S1"}],"claims_to_check":[],"items_delivered":null}`;
}

describe('generateArticleV3', () => {
  test('happy path: one Writer call, links, TOC, meta, FAQ, fingerprint; proof level standard', async () => {
    const input = INPUT();
    const s = scripted([writerText(input)]);
    const logs: string[] = [];
    const r = await generateArticleV3(input, DEPS(s.call, logs));
    assert.equal(s.systems.length, 1);
    assert.equal(r.validator.passed, true, JSON.stringify(r.validator.issues));
    assert.equal(r.needs_review, false);
    assert.equal(r.repaired, false);
    assert.equal(r.linked_sources.length, 3);
    assert.match(r.content, /iseo-toc/);
    assert.doesNotMatch(r.content, /\[S\d\]/);
    assert.equal(r.faq.length, r.picks.faq_count);
    assert.ok(r.meta_title.length >= 50 && r.meta_title.length <= 60, r.meta_title);
    assert.equal(r.proof_level, 'standard');
    assert.match(r.prompt_version, /^content_v3_writer@code#[0-9a-f]{8}$/);
    assert.match(logs.join('\n'), /\[content-v3\] article run=- type=cost size=medium proof=standard words=\d+ validator=pass repaired=no links=3/);
    assert.match(s.users[0], /^<niche_profile>\nNICHE: Plumbing\. PROFILE: Trades and repair\./);
    assert.match(s.users[0], /<blueprint>\nARTICLE TYPE: Cost guide\./);
  });

  test('U2: a failing article is written once more; still failing → needs_review with the report', async () => {
    const input = INPUT();
    const bad = writerText(input, (h) => h.replace(/data-iseo="closing"/, ''));
    const s1 = scripted([bad, writerText(input)]);
    const r1 = await generateArticleV3(input, DEPS(s1.call));
    assert.equal(s1.systems.length, 2);
    assert.equal(r1.repaired, true);
    assert.equal(r1.needs_review, false);
    const s2 = scripted([bad, bad]);
    const r2 = await generateArticleV3(INPUT(), DEPS(s2.call));
    assert.equal(r2.needs_review, true);
    assert.ok(r2.validator.issues.some((i) => i.code === 'data_iseo'));
  });

  test('the Writer failing 3 times throws (the route refunds)', async () => {
    const s = scripted([new Error('overloaded')]);
    await assert.rejects(generateArticleV3(INPUT(), DEPS(s.call)), /writer/);
  });

  test('WR9: the system prompt is byte-identical across articles (cacheable)', async () => {
    const a = scripted([writerText(INPUT())]);
    const b = scripted([writerText(INPUT({ title: 'Other title' }))]);
    await generateArticleV3(INPUT(), DEPS(a.call));
    await generateArticleV3(INPUT({ title: 'Other title', seed_keyword: 'tankless heater' }), DEPS(b.call)).catch(() => {});
    assert.equal(a.systems[0], b.systems[0]);
    assert.equal(writerPromptLabel(a.systems[0], {}), writerPromptLabel(b.systems[0], {}));
  });

  test('G6 final proof level: Keep / Turn off at both levels', () => {
    assert.equal(finalProofLevel('regulated', false, null), 'regulated');
    assert.equal(finalProofLevel('regulated', false, false), 'standard');
    assert.equal(finalProofLevel('standard', true, null), 'regulated');
    assert.equal(finalProofLevel('standard', true, true), 'regulated');
    assert.equal(finalProofLevel('standard', true, false), 'standard');
    assert.equal(finalProofLevel('standard', false, null), 'standard');
  });

  test('regulated: Regulated piece in the niche profile; no disclaimer while no text exists; one when it does', async () => {
    const input = INPUT({ business_proof_level: 'regulated', niche: 'dental' });
    const s = scripted([writerText(input)]);
    const r = await generateArticleV3(input, DEPS(s.call));
    assert.match(s.users[0], /PROOF LEVEL: REGULATED \(health, legal, financial, insurance\)/);
    assert.doesNotMatch(r.content, /iseo-disclaimer/);
    const s2 = scripted([writerText(input)]);
    const r2 = await generateArticleV3(INPUT({ business_proof_level: 'regulated', niche: 'dental' }), { ...DEPS(s2.call), niche: { settings: (await import('../niche-profile/niche-profile.js')).DEFAULT_NICHE_SETTINGS, disclaimers: { dental: 'This article is general information, not dental advice for your situation.' } } });
    assert.match(r2.content, /iseo-disclaimer/);
  });
});
