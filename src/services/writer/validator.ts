/**
 * Content v3 validator — the checks code runs on every article (docs/content-v3-prompt-drafts.md:
 * Writer "Checks for the validator", <rules_seo> notes, <rules_formatting>, decision D21, C5).
 *
 * ERRORS fail the article: the Writer runs once more (U2), and if it still fails the single wizard
 * shows the issues with "Use anyway" / "Regenerate" and bulk saves a draft with the report (U3).
 * WARNINGS are reported and stored, never block.
 *
 * Errors
 *   data_iseo           every h2 carries a known data-iseo value
 *   intro               an introduction (1 to 3 paragraphs, no heading) comes first
 *   summary             exactly one summary section, directly after the introduction
 *   quick_answer_words  quick answer is one paragraph of 40–60 words
 *   takeaways           heading starts "Key takeaways: " (D21) and has 3–5 points (the blueprint's count)
 *   faq_count           FAQ questions = the blueprint's count; each <h3> followed by a <p>; no "Q:"/"A:"
 *   closing / last_two  a closing exists; FAQ and closing are the last two sections, in the blueprint's order
 *   items_delivered     a numbered title gets exactly its N items (and the Writer's JSON agrees)
 *   question_headings   at most 1 in 3 body headings end with "?"
 *   fixed_label         no heading is a fixed label ("FAQ", "Conclusion", …); "Key takeaways: …" allowed
 *   keyword_first_100   <seed_keyword>, or its closest wording, in the first 100 words
 *   back_reference      no vague pointers ("as mentioned above", "see below", …)
 *   word_count          total words inside the size's range
 *   regulated_sources   a Regulated post links at least 3 sources (C5)
 * Warnings
 *   heading_first_word  two headings start with the same word
 *   recent_heading      a heading repeats one in <recent_headings>
 *   faq_as_heading      a body heading repeats an FAQ question
 *   em_dash             more than one em dash in a paragraph
 *   bold                more than one bold phrase in a paragraph
 *   unknown_tokens      source tokens with no matching source were removed
 *   claims_to_check     the Writer flagged sentences it was unsure about
 * V10 (the Humanizer v1.2 style thresholds) is BLOCKED until that document is provided.
 */
import { load } from 'cheerio';
import type { BlueprintPicks } from '../blueprint/blueprint.js';
import type { PostSize } from '../content-v3-steps/types.js';
import { splitSections } from './postprocess.js';

export type Severity = 'error' | 'warning';

export interface ValidatorIssue {
  code: string;
  severity: Severity;
  /** Plain words, shown to the user in the review notice. */
  message: string;
  detail?: string;
}

export interface ValidatorReport {
  passed: boolean;
  errors: number;
  warnings: number;
  issues: ValidatorIssue[];
  word_count: number;
}

export const SIZE_RANGE: Record<PostSize, [number, number]> = { small: [600, 1200], medium: [1200, 2400], large: [2400, 3600] };

export const FIXED_LABELS = [
  'quick answer', 'summary', 'faq', 'faqs', 'frequently asked questions', "what's next", 'whats next', 'next steps',
  'contact us', 'conclusion', 'final thoughts', 'key takeaways', 'introduction', 'overview', 'in summary', 'wrapping up',
];

export const BACK_REFERENCES = [
  'as mentioned above', 'as mentioned earlier', 'as discussed above', 'as discussed earlier', 'as noted above', 'as noted earlier',
  'see below', 'see above', 'as stated above', 'mentioned above', 'discussed above', 'as we discussed', 'as we mentioned',
];

const text = (html: string) =>
  load(`<div>${html}</div>`, null, false)
    .text()
    .replace(/\s+/g, ' ')
    .trim();

export function countWords(html: string): number {
  const t = text(html);
  return t ? t.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
}

const norm = (s: string) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'my', 'your', 'is', 'are', 'how', 'what', 'near', 'me', 'with', 'vs']);
/** Light stemming: plurals and -ing / -ed forms ("turning" = "turn", "repaired" = "repair"). */
const stem = (w: string) => {
  let x = w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
  if (x.length > 5 && /(ing|ed)$/.test(x)) {
    x = x.replace(/(ing|ed)$/, '');
    if (/([b-df-hj-np-tv-z])\1$/.test(x)) x = x.slice(0, -1);
  }
  return x;
};
/** "won't", "doesn't", "isn't", "can't" all contain "not" (the keyword's closest natural wording). */
const expandNegations = (t: string) => t.replace(/\b(\w+)n['’]t\b/gi, '$1 not').replace(/\bcannot\b/gi, 'can not');

/** The keyword, or its closest natural wording: every content word (light stemming) in the window. */
export function keywordInFirstWords(html: string, keyword: string, n = 100, town?: string | null): boolean {
  const words = norm(expandNegations(text(html))).split(' ').slice(0, n);
  const window = ` ${words.join(' ')} `;
  const kw = norm(expandNegations(keyword));
  if (kw && window.includes(` ${kw} `)) return true;
  const townWords = new Set(norm(town ?? '').split(' ').filter(Boolean));
  const content = kw.split(' ').filter((w) => w && !STOP.has(w));
  const needed = content.filter((w) => !townWords.has(w));
  if (!needed.length) return true;
  const have = new Set(words.map(stem));
  return needed.every((w) => have.has(stem(w)));
}

export interface ValidateInput {
  html: string;
  picks: BlueprintPicks;
  postSize: PostSize;
  seedKeyword: string;
  targetTown?: string | null;
  regulated: boolean;
  linkedSources: number;
  unknownTokens?: string[];
  itemsDelivered?: number | null;
  claimsToCheck?: string[];
  recentHeadings?: string[];
  faqQuestions?: string[];
}

export function validateArticle(i: ValidateInput): ValidatorReport {
  const issues: ValidatorIssue[] = [];
  const err = (code: string, message: string, detail?: string) => issues.push({ code, severity: 'error', message, detail });
  const warn = (code: string, message: string, detail?: string) => issues.push({ code, severity: 'warning', message, detail });
  const { introHtml, sections } = splitSections(i.html);
  const $intro = load(introHtml, null, false);

  // Every h2 has a known data-iseo value.
  const missing = sections.filter((s) => !s.kind);
  if (missing.length) err('data_iseo', 'Some sections are missing their structure tag.', missing.map((s) => s.heading).join(' | '));

  // Introduction: first, 1–3 paragraphs, no heading.
  const introParas = $intro('p').length;
  if (!introParas) err('intro', 'The article does not start with an introduction.');
  else if (introParas > 3) err('intro', 'The introduction is longer than three paragraphs.', `${introParas} paragraphs`);

  // Exactly one summary, directly after the introduction.
  const summaries = sections.filter((s) => s.kind === 'quick-answer' || s.kind === 'takeaways');
  if (summaries.length !== 1) err('summary', 'The article needs exactly one summary right after the introduction.', `${summaries.length} found`);
  else if (sections[0] !== summaries[0]) err('summary', 'The summary is not directly after the introduction.');
  const summary = summaries[0];
  if (summary) {
    const $s = load(summary.html, null, false);
    if (summary.kind === 'quick-answer') {
      const paras = $s('p').toArray();
      const words = paras.length ? countWords($s.html(paras[0]) ?? '') : 0;
      if (i.picks.summary_form !== 'quick_answer') err('summary', 'The summary form differs from the plan.', 'quick answer instead of takeaways');
      if (paras.length !== 1 || words < 40 || words > 60) err('quick_answer_words', 'The quick answer should be one paragraph of 40 to 60 words.', `${paras.length} paragraph(s), ${words} words`);
    } else {
      const points = $s('li').length;
      if (i.picks.summary_form !== 'takeaways') err('summary', 'The summary form differs from the plan.', 'takeaways instead of a quick answer');
      if (!/^key takeaways:\s*\S/i.test(summary.heading)) err('takeaways', 'The takeaways heading must start with "Key takeaways:" and name the topic.', summary.heading);
      if (points < 3 || points > 5) err('takeaways', 'Key takeaways need 3 to 5 points.', `${points} points`);
      else if (i.picks.takeaway_points && points !== i.picks.takeaway_points) err('takeaways', 'The number of takeaways differs from the plan.', `${points} instead of ${i.picks.takeaway_points}`);
    }
  }

  // FAQ count and form.
  const faq = sections.find((s) => s.kind === 'faq');
  const faqSections = sections.filter((s) => s.kind === 'faq');
  if (faqSections.length > 1) err('faq_count', 'There is more than one FAQ section.');
  if (i.picks.faq_count > 0) {
    if (!faq) err('faq_count', 'The FAQ section is missing.');
    else {
      const $f = load(faq.html, null, false);
      const qs = $f('h3').toArray();
      if (qs.length !== i.picks.faq_count) err('faq_count', 'The number of FAQ questions differs from the plan.', `${qs.length} instead of ${i.picks.faq_count}`);
      const noAnswer = qs.filter((h) => !$f(h).nextAll().first().is('p'));
      if (noAnswer.length) err('faq_count', 'Every FAQ question needs a short answer paragraph.');
      if (/(^|>)\s*(Q|A)\s*:/m.test(faq.html)) err('faq_count', 'FAQ answers must not use "Q:" or "A:".');
    }
  } else if (faq) {
    err('faq_count', 'The plan has no FAQ, but the article added one.');
  }

  // Closing, and the last two sections in the blueprint's order.
  const closing = sections.find((s) => s.kind === 'closing');
  if (!closing) err('closing', 'The closing section is missing.');
  if (closing && faq) {
    const last2 = sections.slice(-2).map((s) => s.kind);
    const want = i.picks.order === 'faq_first' ? ['faq', 'closing'] : ['closing', 'faq'];
    if (last2.join() !== want.join()) err('last_two', 'The FAQ and the closing must be the last two sections, in the planned order.', last2.join(' → '));
  } else if (closing && sections[sections.length - 1] !== closing) {
    err('last_two', 'The closing must be the last section.');
  }

  // Numbered titles: exactly N items.
  const body = sections.filter((s) => s.kind === 'body');
  if (i.picks.numbered) {
    const n = i.picks.numbered.items;
    const delivered =
      i.picks.numbered.grouping === 'h2_items'
        ? body.length
        : body.reduce((sum, s) => sum + load(s.html, null, false)('h3').length, 0);
    if (delivered !== n && !(i.picks.numbered.grouping === 'h2_items' && delivered === n + 1)) {
      err('items_delivered', `The title promises ${n} items, but the article has ${delivered}.`);
    }
    if (typeof i.itemsDelivered === 'number' && i.itemsDelivered !== n) err('items_delivered', `The writer reported ${i.itemsDelivered} items for a title that promises ${n}.`);
  }

  // Headings.
  const bodyHeadings = body.map((s) => s.heading);
  const questions = bodyHeadings.filter((h) => /\?\s*$/.test(h));
  if (bodyHeadings.length && questions.length > Math.floor(bodyHeadings.length / 3)) {
    err('question_headings', 'Too many body headings are questions (at most one in three).', `${questions.length} of ${bodyHeadings.length}`);
  }
  const $all = load(i.html, null, false);
  const allHeadings = $all('h2, h3').toArray().map((h) => $all(h).text().replace(/\s+/g, ' ').trim());
  for (const h of allHeadings) {
    const n = norm(h);
    if (FIXED_LABELS.includes(n)) err('fixed_label', 'Headings must name what the section covers, not a fixed label.', h);
  }
  const firstWords = new Map<string, string[]>();
  for (const h of $all('h2').toArray().map((x) => $all(x).text().trim())) {
    const w = norm(h).split(' ')[0];
    if (!w) continue;
    firstWords.set(w, [...(firstWords.get(w) ?? []), h]);
  }
  for (const [w, hs] of firstWords) if (hs.length > 1 && w !== 'key') warn('heading_first_word', 'Two headings start with the same word.', hs.join(' | '));
  const recent = new Set((i.recentHeadings ?? []).map(norm));
  const reused = allHeadings.filter((h) => recent.has(norm(h)));
  if (reused.length) warn('recent_heading', 'A heading repeats one from a recent post.', reused.join(' | '));
  const faqQs = new Set((i.faqQuestions ?? []).map(norm));
  const asHeading = bodyHeadings.filter((h) => faqQs.has(norm(h)));
  if (asHeading.length) warn('faq_as_heading', 'A body heading repeats an FAQ question.', asHeading.join(' | '));

  // Keyword in the first 100 words.
  if (!keywordInFirstWords(i.html, i.seedKeyword, 100, i.targetTown)) err('keyword_first_100', 'The keyword does not appear in the first 100 words.');

  // Vague back-references.
  const plain = norm(text(i.html));
  const backRefs = BACK_REFERENCES.filter((p) => ` ${plain} `.includes(` ${norm(p)} `));
  if (backRefs.length) err('back_reference', 'Sections must stand alone: avoid "as mentioned above" or "see below".', backRefs.join(', '));

  // Word count inside the size's range.
  const words = countWords(i.html);
  const [lo, hi] = SIZE_RANGE[i.postSize];
  if (words < lo || words > hi) err('word_count', `The article has ${words} words; this size needs ${lo} to ${hi}.`);

  // Regulated: at least 3 linked sources (C5).
  if (i.regulated && i.linkedSources < 3) err('regulated_sources', 'A regulated article must cite at least 3 sources.', `${i.linkedSources} linked`);

  // Paragraph-level style (warnings).
  const paras = $all('p').toArray();
  const dashy = paras.filter((p) => ($all(p).text().match(/—/g) ?? []).length > 1).length;
  if (dashy) warn('em_dash', 'Some paragraphs use more than one em dash.', `${dashy} paragraph(s)`);
  const bold = paras.filter((p) => $all(p).find('strong').length > 1).length;
  if (bold) warn('bold', 'Some paragraphs have more than one bold phrase.', `${bold} paragraph(s)`);
  if (i.unknownTokens?.length) warn('unknown_tokens', 'Some source references had no matching source and were removed.', i.unknownTokens.join(', '));
  if (i.claimsToCheck?.length) warn('claims_to_check', 'The writer flagged sentences to check.', i.claimsToCheck.slice(0, 5).join(' | '));

  const errors = issues.filter((x) => x.severity === 'error').length;
  return { passed: errors === 0, errors, warnings: issues.length - errors, issues, word_count: words };
}
