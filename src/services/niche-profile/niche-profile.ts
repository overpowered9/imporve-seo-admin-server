/**
 * Niche profile (#7), built by code — N1–N5, plus what the proof level and the blueprint need
 * from it. docs/content-v3-prompt-drafts.md "Writer part 3: Niche profile".
 *
 * DATA AS SETTINGS (N1). The eight profiles, the niche list with its mapping, default proof levels
 * and watchlists are one JSON setting (registry template content_v3_niche_profiles; this file's
 * DEFAULT_NICHE_SETTINGS is the fallback). Adding a niche is one row. The table values are the
 * doc's, cell for cell (niche-profile.test.ts reads the doc tables and compares).
 *
 * WORKING VALUES (not in the doc, flagged in the progress doc). The doc gives the provider and the
 * "professional help" phrase per PROFILE (its own example block narrows them to a plumber). Each
 * niche row may override them (`provider`, `help_phrase`); the overrides shipped here are working
 * values for the 10-keyword review, editable in the setting. The next steps are the table's words
 * with an article ("Assessment" → "an assessment").
 *
 * THE BLOCK (N4) follows the doc's example:
 *   NICHE: Plumbing. PROFILE: Trades and repair.
 *   The provider: a licensed plumber. Professional help, in these words: "call a licensed plumber".
 *   Next step: soft = an assessment; medium = an estimate or quote. Firmest allowed: direct.
 *   Pricing in this niche: ranges per job.
 *   Local detail matters a lot here.
 *   PROOF LEVEL: STANDARD … (the Standard piece with the watchlist filled in, or the Regulated piece)
 *   (type adjustment lines, only when the type and niche match a row — N3)
 * A nationwide business gets the profile's nationwide next step instead of the local one.
 */
import { NICHE_REGULATED_PIECE_V1, NICHE_STANDARD_PIECE_V1, TYPE_ADJUSTMENT_LINES } from './pieces.js';

export type ProfileKey = 'trades' | 'health' | 'money_legal' | 'appointment' | 'expertise' | 'food_venues' | 'shops' | 'content_only';
export type Firmness = 'soft' | 'medium' | 'direct';
export type DetailLevel = 'high' | 'medium' | 'low';

export interface ProfileRow {
  key: ProfileKey;
  name: string;
  /** "The provider" column. */
  provider: string;
  /** "Professional help phrase (example)" column. */
  help_phrase: string;
  next_soft: string;
  next_medium: string;
  /** null = "Not usual" in the nationwide column. */
  next_nationwide: { soft: string; medium: string } | null;
  pricing: string;
  local_detail: { local: DetailLevel; nationwide: DetailLevel };
  firmest: Firmness;
}

export interface NicheRow {
  key: string;
  label: string;
  profile: ProfileKey;
  proof_level: 'standard' | 'regulated';
  /** "Standard (open)" in the doc. */
  proof_open?: boolean;
  /** Watchlist cell, as written ('' for "—"). */
  watchlist: string;
  /** Phrases that join the regulated topics check for this niche (G2 "Plus each niche's watchlist"). */
  watch_terms?: string[];
  synonyms?: string[];
  /** The v2 wizard's niche keys this row answers to. */
  v2_keys?: string[];
  provider?: string;
  help_phrase?: string;
  /** "Other …" rows: the profile is chosen by the user (Business details) instead. */
  choose_profile?: boolean;
}

export interface NicheSettings {
  profiles: ProfileRow[];
  niches: NicheRow[];
}

export const DEFAULT_NICHE_SETTINGS: NicheSettings = {
  profiles: [
    { key: 'trades', name: 'Trades and repair', provider: 'contractor, technician', help_phrase: 'call a licensed electrician', next_soft: 'an assessment', next_medium: 'an estimate or quote', next_nationwide: { soft: 'a quote by phone or online', medium: 'a quote by phone or online' }, pricing: 'ranges per job', local_detail: { local: 'high', nationwide: 'high' }, firmest: 'direct' },
    { key: 'health', name: 'Health and care', provider: 'dentist, clinic, therapist', help_phrase: 'see a dentist', next_soft: 'a consultation or check-up', next_medium: 'an appointment', next_nationwide: { soft: 'an online consultation', medium: 'an online consultation' }, pricing: 'per treatment; insurance varies', local_detail: { local: 'high', nationwide: 'high' }, firmest: 'direct' },
    { key: 'money_legal', name: 'Money and legal', provider: 'lawyer, adviser, agent', help_phrase: 'talk to a lawyer about your case', next_soft: 'a free consultation or review', next_medium: 'a consultation or quote', next_nationwide: { soft: 'a consultation by phone or video', medium: 'a consultation by phone or video' }, pricing: 'fees, commissions, premiums, rates', local_detail: { local: 'high', nationwide: 'medium' }, firmest: 'direct' },
    { key: 'appointment', name: 'Appointment services', provider: 'salon, trainer, groomer, photographer', help_phrase: 'book with a professional', next_soft: 'a visit or trial', next_medium: 'a booking or package', next_nationwide: null, pricing: 'menu, per session, package', local_detail: { local: 'high', nationwide: 'high' }, firmest: 'direct' },
    { key: 'expertise', name: 'Expertise and advisory', provider: 'tutor, consultant, coach', help_phrase: 'work with a specialist', next_soft: 'a discovery call', next_medium: 'a consultation or proposal', next_nationwide: { soft: 'a discovery call, demo or proposal', medium: 'a discovery call, demo or proposal' }, pricing: 'packages, projects, hourly', local_detail: { local: 'medium', nationwide: 'medium' }, firmest: 'direct' },
    { key: 'food_venues', name: 'Food, lodging and venues', provider: 'restaurant, hotel, venue', help_phrase: 'ask the venue', next_soft: 'the menu or availability', next_medium: 'a reservation or booking', next_nationwide: null, pricing: 'menus, rates', local_detail: { local: 'high', nationwide: 'high' }, firmest: 'direct' },
    { key: 'shops', name: 'Shops and products', provider: 'store', help_phrase: 'ask the store', next_soft: 'a visit or browse', next_medium: 'buy', next_nationwide: { soft: 'browse', medium: 'buy or download' }, pricing: 'product prices', local_detail: { local: 'high', nationwide: 'low' }, firmest: 'direct' },
    { key: 'content_only', name: 'Content only', provider: 'the author', help_phrase: 'talk to a qualified professional', next_soft: 'a related post', next_medium: 'the newsletter', next_nationwide: { soft: 'a related post', medium: 'the newsletter' }, pricing: 'none', local_detail: { local: 'low', nationwide: 'low' }, firmest: 'soft' },
  ],
  niches: [
    // Trades and repair · Standard · "Safety and code claims (electrical, gas, structural)"
    { key: 'hvac', label: 'HVAC', profile: 'trades', proof_level: 'standard', watchlist: 'Safety and code claims (electrical, gas, structural)', synonyms: ['heating', 'cooling', 'air conditioning', 'furnace', 'ac repair', 'heat pump'], v2_keys: ['hvac'], provider: 'an HVAC technician', help_phrase: 'call a licensed HVAC technician' },
    { key: 'plumbing', label: 'Plumbing', profile: 'trades', proof_level: 'standard', watchlist: 'Safety and code claims (electrical, gas, structural)', synonyms: ['plumber', 'water heater', 'drain', 'pipes'], v2_keys: ['plumbing'], provider: 'a licensed plumber', help_phrase: 'call a licensed plumber' },
    { key: 'electrical', label: 'Electrical', profile: 'trades', proof_level: 'standard', watchlist: 'Safety and code claims (electrical, gas, structural)', synonyms: ['electrician', 'wiring', 'panel'], v2_keys: ['electrical'], provider: 'a licensed electrician', help_phrase: 'call a licensed electrician' },
    { key: 'roofing', label: 'Roofing/Exterior', profile: 'trades', proof_level: 'standard', watchlist: 'Safety and code claims (electrical, gas, structural)', synonyms: ['roofer', 'roof', 'siding', 'gutters', 'exterior'], v2_keys: ['roofing'], provider: 'a roofing contractor', help_phrase: 'call a licensed roofer' },
    { key: 'contractor', label: 'Contractor/Remodeling/Construction', profile: 'trades', proof_level: 'standard', watchlist: 'Safety and code claims (electrical, gas, structural)', synonyms: ['remodel', 'renovation', 'builder', 'construction', 'general contractor', 'handyman'], v2_keys: ['contractor'], provider: 'a licensed contractor', help_phrase: 'call a licensed contractor' },
    { key: 'landscaping', label: 'Landscaping/Tree/Lawn', profile: 'trades', proof_level: 'standard', watchlist: 'Safety and code claims (electrical, gas, structural)', synonyms: ['landscaper', 'tree service', 'lawn care', 'gardening', 'arborist'], v2_keys: ['landscaping'], provider: 'a landscaping contractor', help_phrase: 'call a professional landscaper' },
    { key: 'home_services', label: 'Home Services', profile: 'trades', proof_level: 'standard', watchlist: 'Safety and code claims (electrical, gas, structural)', synonyms: ['pest control', 'cleaning', 'locksmith', 'moving', 'movers', 'garage door'], v2_keys: ['home_services'], provider: 'a technician', help_phrase: 'call a qualified technician' },
    { key: 'auto_repair', label: 'Auto Repair/Body Shop/Car Wash', profile: 'trades', proof_level: 'standard', watchlist: 'Safety and code claims (electrical, gas, structural)', synonyms: ['mechanic', 'auto shop', 'car repair', 'collision', 'car wash', 'body shop'], v2_keys: ['auto_repair'], provider: 'a mechanic', help_phrase: 'take it to a qualified mechanic' },
    // Health and care · Regulated · —
    { key: 'dental', label: 'Dental/Orthodontics', profile: 'health', proof_level: 'regulated', watchlist: '', synonyms: ['dentist', 'orthodontist', 'braces', 'teeth'], provider: 'a dentist', help_phrase: 'see a dentist' },
    { key: 'medical', label: 'Medical/Health Clinic', profile: 'health', proof_level: 'regulated', watchlist: '', synonyms: ['doctor', 'clinic', 'physician', 'urgent care', 'med spa'], v2_keys: ['medical'], provider: 'a doctor or clinic', help_phrase: 'see a doctor' },
    { key: 'mental_health', label: 'Mental Health/Counseling', profile: 'health', proof_level: 'regulated', watchlist: '', synonyms: ['therapist', 'counselor', 'psychologist', 'therapy'], provider: 'a licensed therapist', help_phrase: 'talk to a licensed therapist' },
    { key: 'wellness', label: 'Wellness/Chiropractic/Massage', profile: 'health', proof_level: 'regulated', watchlist: '', synonyms: ['chiro', 'chiropractor', 'massage', 'physical therapy', 'acupuncture'], v2_keys: ['wellness'], provider: 'a licensed practitioner', help_phrase: 'see a licensed practitioner' },
    { key: 'veterinary', label: 'Veterinary', profile: 'health', proof_level: 'regulated', watchlist: '', synonyms: ['vet', 'animal hospital', 'veterinarian'], provider: 'a veterinarian', help_phrase: 'see a vet' },
    { key: 'care', label: 'Child Care/Senior Care/In-Home Care', profile: 'health', proof_level: 'regulated', watchlist: '', synonyms: ['daycare', 'senior care', 'home care', 'assisted living', 'caregiver'], provider: 'a care provider', help_phrase: 'talk to a qualified care provider' },
    // Money and legal · Regulated · —
    { key: 'legal_services', label: 'Legal Services', profile: 'money_legal', proof_level: 'regulated', watchlist: '', synonyms: ['lawyer', 'attorney', 'law firm', 'personal injury', 'family law'], v2_keys: ['legal_services'], provider: 'a lawyer', help_phrase: 'talk to a lawyer about your case' },
    { key: 'financial', label: 'Financial Services', profile: 'money_legal', proof_level: 'regulated', watchlist: '', synonyms: ['mortgage', 'financial adviser', 'financial advisor', 'loans', 'wealth management'], v2_keys: ['mortgage'], provider: 'a financial adviser', help_phrase: 'talk to a financial adviser about your situation' },
    { key: 'insurance', label: 'Insurance Agency', profile: 'money_legal', proof_level: 'regulated', watchlist: '', synonyms: ['insurance agent', 'insurance broker', 'insurance'], provider: 'an insurance agent', help_phrase: 'talk to a licensed insurance agent' },
    { key: 'accounting', label: 'Accounting/Bookkeeping/Tax', profile: 'money_legal', proof_level: 'regulated', watchlist: '', synonyms: ['accountant', 'cpa', 'bookkeeper', 'tax preparer', 'tax prep'], v2_keys: ['accounting'], provider: 'an accountant', help_phrase: 'talk to an accountant about your situation' },
    // Money and legal · Standard (open)
    { key: 'real_estate', label: 'Real Estate Agent/Broker/Property Management', profile: 'money_legal', proof_level: 'standard', proof_open: true, watchlist: 'Rates, returns, market predictions', watch_terms: ['rates', 'returns', 'market predictions'], synonyms: ['realtor', 'real estate', 'property manager', 'broker', 'homes for sale'], v2_keys: ['realestate'], provider: 'a real estate agent', help_phrase: 'talk to a local real estate agent' },
    // Appointment services · Standard
    { key: 'beauty', label: 'Beauty/Salon/Spa/Barber/Nails', profile: 'appointment', proof_level: 'standard', watchlist: 'Health words: non-toxic, safe for pregnancy, cures, detox, weight loss figures', watch_terms: ['non-toxic', 'safe for pregnancy', 'cures', 'detox', 'weight loss'], synonyms: ['salon', 'spa', 'barber', 'nails', 'hair', 'esthetician', 'lashes'], v2_keys: ['beauty'], provider: 'a salon or spa professional', help_phrase: 'book with a professional' },
    { key: 'fitness', label: 'Fitness/Personal Training/Yoga', profile: 'appointment', proof_level: 'standard', watchlist: 'Health words: non-toxic, safe for pregnancy, cures, detox, weight loss figures', watch_terms: ['non-toxic', 'safe for pregnancy', 'cures', 'detox', 'weight loss'], synonyms: ['gym', 'personal trainer', 'yoga', 'pilates', 'crossfit'], v2_keys: ['fitness'], provider: 'a trainer', help_phrase: 'book with a qualified trainer' },
    { key: 'pet_services', label: 'Pet Services (grooming, boarding, training)', profile: 'appointment', proof_level: 'standard', watchlist: 'Health words: non-toxic, safe for pregnancy, cures, detox, weight loss figures', watch_terms: ['non-toxic', 'safe for pregnancy', 'cures', 'detox', 'weight loss'], synonyms: ['groomer', 'grooming', 'dog boarding', 'kennel', 'dog training', 'pet sitter'], v2_keys: ['pet_services'], provider: 'a groomer or trainer', help_phrase: 'book with a professional' },
    { key: 'photography', label: 'Photography/Events/Weddings', profile: 'appointment', proof_level: 'standard', watchlist: 'Health words: non-toxic, safe for pregnancy, cures, detox, weight loss figures', watch_terms: ['non-toxic', 'safe for pregnancy', 'cures', 'detox', 'weight loss'], synonyms: ['photographer', 'wedding', 'events', 'event planner', 'dj'], provider: 'a photographer', help_phrase: 'book with a professional' },
    // Expertise and advisory · Standard
    { key: 'education', label: 'Education/Tutoring/Test Prep/Coaching/Lessons', profile: 'expertise', proof_level: 'standard', watchlist: 'Outcome promises: score gains, admissions, revenue results', watch_terms: ['score gains', 'admissions', 'revenue results'], synonyms: ['tutor', 'tutoring', 'test prep', 'coach', 'lessons', 'music lessons'], v2_keys: ['education'], provider: 'a tutor or coach', help_phrase: 'work with a specialist' },
    { key: 'consulting', label: 'Consulting/Agency/B2B', profile: 'expertise', proof_level: 'standard', watchlist: 'Outcome promises: score gains, admissions, revenue results', watch_terms: ['score gains', 'admissions', 'revenue results'], synonyms: ['consultant', 'agency', 'marketing agency', 'b2b', 'saas'], provider: 'a consultant', help_phrase: 'work with a specialist' },
    // Food, lodging and venues · Standard
    { key: 'restaurant', label: 'Restaurant/Cafe/Bakery/Catering', profile: 'food_venues', proof_level: 'standard', watchlist: 'Allergen and dietary claims', synonyms: ['restaurant', 'cafe', 'coffee shop', 'bakery', 'catering', 'food truck'], v2_keys: ['restaurant'], provider: 'the restaurant', help_phrase: 'ask the venue' },
    { key: 'hotel', label: 'Hotel/B&B/Vacation Rental/Venue', profile: 'food_venues', proof_level: 'standard', watchlist: 'Allergen and dietary claims', synonyms: ['hotel', 'bed and breakfast', 'vacation rental', 'event venue', 'airbnb'], provider: 'the venue', help_phrase: 'ask the venue' },
    // Shops and products · Standard
    { key: 'local_shop', label: 'Local Shop/Retail', profile: 'shops', proof_level: 'standard', watchlist: 'Product health and safety claims', synonyms: ['shop', 'store', 'retail', 'boutique'], provider: 'the store', help_phrase: 'ask the store' },
    { key: 'ecommerce', label: 'Ecommerce/Online Store', profile: 'shops', proof_level: 'standard', watchlist: 'Product health and safety claims', synonyms: ['online store', 'ecommerce', 'e-commerce', 'shopify', 'product reviews'], v2_keys: ['ecommerce'], provider: 'the store', help_phrase: 'ask the store' },
    // Content only · Standard
    { key: 'general_blog', label: 'General Blog/Content Creator', profile: 'content_only', proof_level: 'standard', watchlist: 'Depends on the topic', synonyms: ['blog', 'blogger', 'content creator', 'influencer', 'newsletter'], v2_keys: ['general_blog'], provider: 'the author', help_phrase: 'talk to a qualified professional' },
    // Other …
    { key: 'other_service', label: 'Other service business', profile: 'content_only', proof_level: 'standard', watchlist: '', choose_profile: true, synonyms: ['other service'], v2_keys: ['other'] },
    { key: 'other_shop', label: 'Other shop or product business', profile: 'shops', proof_level: 'standard', watchlist: 'Product health and safety claims', synonyms: ['other shop', 'other products'] },
  ],
};

export const NICHE_SETTINGS_DEF = {
  templateType: 'content_v3_niche_profiles' as const,
  displayName: 'Content v3 — Niche profiles, niche list and watchlists (JSON setting)',
  fallback: JSON.stringify(DEFAULT_NICHE_SETTINGS, null, 2),
};

export function parseNicheSettings(raw: string | null | undefined): NicheSettings | null {
  if (!raw || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw) as NicheSettings;
    if (!v || !Array.isArray(v.profiles) || !Array.isArray(v.niches) || !v.profiles.length || !v.niches.length) return null;
    const keys = new Set(v.profiles.map((p) => p.key));
    if (!v.niches.every((n) => n && typeof n.key === 'string' && typeof n.label === 'string' && keys.has(n.profile))) return null;
    return v;
  } catch {
    return null;
  }
}

const norm = (s: string) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The niche row for what the plugin sent: a v3 niche key or label, a v2 wizard key, the v2 wizard's
 * option label ("Plumbing", "HVAC / Heating & Cooling"), or a synonym. Unknown → null.
 */
export function resolveNiche(input: string | null | undefined, settings: NicheSettings = DEFAULT_NICHE_SETTINGS): NicheRow | null {
  const q = norm(input ?? '');
  if (!q) return null;
  const rows = settings.niches;
  return (
    rows.find((n) => n.key === input || norm(n.key) === q) ??
    rows.find((n) => norm(n.label) === q) ??
    rows.find((n) => (n.v2_keys ?? []).some((k) => norm(k) === q)) ??
    // A v2 wizard label such as "HVAC / Heating & Cooling" or "Pet Services / Vet": its first word.
    rows.find((n) => q.split(' ')[0].length > 2 && norm(n.label).split(' ')[0] === q.split(' ')[0]) ??
    // A synonym, as whole words ("chiro" finds Wellness/Chiropractic/Massage; "vet" never matches "velvet").
    rows.find((n) => (n.synonyms ?? []).some((s) => norm(s) === q || ` ${q} `.includes(` ${norm(s)} `))) ??
    null
  );
}

export interface NicheContext {
  niche: NicheRow | null;
  profile: ProfileRow;
  /** The label shown after "NICHE:". */
  nicheLabel: string;
}

/** Niche + profile, with the "Other" rows' chosen profile and Content only for anything unknown. */
export function nicheContext(nicheInput: string | null | undefined, opts: { profileOverride?: string | null; settings?: NicheSettings } = {}): NicheContext {
  const settings = opts.settings ?? DEFAULT_NICHE_SETTINGS;
  const niche = resolveNiche(nicheInput, settings);
  const byKey = (k: string | null | undefined) => settings.profiles.find((p) => p.key === k);
  let profile = byKey(niche?.profile) ?? byKey('content_only')!;
  if ((niche?.choose_profile || !niche) && opts.profileOverride && byKey(opts.profileOverride)) profile = byKey(opts.profileOverride)!;
  const nicheLabel = niche ? niche.label : String(nicheInput ?? '').trim() || profile.name;
  return { niche, profile, nicheLabel };
}

const DETAIL_SENTENCE: Record<DetailLevel, string> = {
  high: 'Local detail matters a lot here.',
  medium: 'Local detail matters somewhat here.',
  low: 'Local detail matters little here.',
};

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const firstLower = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

export type ArticleType = 'cost' | 'decision' | 'question' | 'topic';

/** N3: the type adjustment lines whose row matches this article. */
export function typeAdjustments(opts: { articleType: ArticleType; profile: ProfileKey; regulated: boolean; taskTrigger: boolean; nationwide: boolean }): string[] {
  const out: string[] = [];
  const { articleType: t, profile: p } = opts;
  if (t === 'cost' && p === 'money_legal') out.push(TYPE_ADJUSTMENT_LINES.cost_money_legal);
  if (t === 'cost' && p === 'health') out.push(TYPE_ADJUSTMENT_LINES.cost_health_care);
  if (t === 'question' && opts.regulated) out.push(TYPE_ADJUSTMENT_LINES.question_regulated);
  if (t === 'topic' && opts.taskTrigger && opts.regulated) out.push(TYPE_ADJUSTMENT_LINES.topic_task_regulated);
  if (t === 'decision' && (p === 'content_only' || p === 'shops')) out.push(TYPE_ADJUSTMENT_LINES.decision_content_or_shops);
  if (p === 'content_only' || (p === 'shops' && opts.nationwide)) out.push(TYPE_ADJUSTMENT_LINES.any_content_or_online_shops);
  return out;
}

/** The topic guide's task trigger (blueprint "TOPIC GUIDE": how to, steps, prepare, set up, apply). */
export function hasTaskTrigger(title: string): boolean {
  return /\b(how to|steps?|prepare|preparing|set up|setting up|apply|applying)\b/i.test(title);
}

export interface NicheProfileInput {
  niche?: string | null;
  profileOverride?: string | null;
  reach?: string | null;
  /** The FINAL proof level for this post (business level, or the post-level Keep/Turn off). */
  proofLevel: 'standard' | 'regulated';
  articleType: ArticleType;
  title: string;
  settings?: NicheSettings;
  standardPiece?: string;
  regulatedPiece?: string;
}

export interface NicheProfileResult {
  block: string;
  context: NicheContext;
  firmest: Firmness;
  adjustments: string[];
}

/** N4: the <niche_profile> block, as in the doc's example. */
export function buildNicheProfile(input: NicheProfileInput): NicheProfileResult {
  const ctx = nicheContext(input.niche, { profileOverride: input.profileOverride, settings: input.settings });
  const p = ctx.profile;
  const nationwide = String(input.reach ?? '').toLowerCase().startsWith('nation');
  const provider = ctx.niche?.provider ?? p.provider;
  const help = ctx.niche?.help_phrase ?? p.help_phrase;
  const lines: string[] = [];
  lines.push(`NICHE: ${ctx.nicheLabel}. PROFILE: ${p.name}.`);
  lines.push(`The provider: ${provider}. Professional help, in these words: "${help}".`);
  if (nationwide) {
    lines.push(
      p.next_nationwide
        ? `Next step (nationwide): soft = ${p.next_nationwide.soft}; medium = ${p.next_nationwide.medium}. Firmest allowed: ${p.firmest}.`
        : `Next step (nationwide): none is usual for this kind of business. Firmest allowed: ${p.firmest}.`,
    );
  } else {
    lines.push(`Next step: soft = ${p.next_soft}; medium = ${p.next_medium}. Firmest allowed: ${p.firmest}.`);
  }
  lines.push(`Pricing in this niche: ${p.pricing}.`);
  lines.push(DETAIL_SENTENCE[nationwide ? p.local_detail.nationwide : p.local_detail.local]);

  const regulated = input.proofLevel === 'regulated';
  if (regulated) {
    lines.push(`PROOF LEVEL: ${input.regulatedPiece ?? NICHE_REGULATED_PIECE_V1}`);
  } else {
    const watch = ctx.niche?.watchlist ? firstLower(ctx.niche.watchlist) : 'none listed for this niche';
    lines.push(`PROOF LEVEL: ${(input.standardPiece ?? NICHE_STANDARD_PIECE_V1).split('[watchlist]').join(watch)}`);
  }
  const adjustments = typeAdjustments({ articleType: input.articleType, profile: p.key, regulated, taskTrigger: hasTaskTrigger(input.title), nationwide });
  lines.push(...adjustments);
  return { block: `<niche_profile>\n${lines.join('\n')}\n</niche_profile>`, context: ctx, firmest: p.firmest, adjustments };
}

/** For the plugin's niche picker: key, label, profile, default proof level, synonyms. */
export function nicheList(settings: NicheSettings = DEFAULT_NICHE_SETTINGS) {
  return settings.niches.map((n) => ({
    key: n.key,
    label: n.label,
    profile: n.profile,
    profile_name: settings.profiles.find((p) => p.key === n.profile)?.name ?? '',
    proof_level: n.proof_level,
    proof_open: !!n.proof_open,
    synonyms: n.synonyms ?? [],
    choose_profile: !!n.choose_profile,
    watch_terms: n.watch_terms ?? [],
  }));
}

export { capitalize };
