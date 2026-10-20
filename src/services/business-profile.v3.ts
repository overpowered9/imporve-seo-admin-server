/**
 * Business profile for the v3 content route — and the enforceable split between what feeds the
 * WRITING and what feeds the STRUCTURED DATA.
 *
 * The product spec's rule is: anything chosen from a fixed list feeds the search-engine data,
 * anything typed freely feeds the writing, and a few fields do both. A comment saying "never put
 * the address in the prompt" gets violated the first time someone adds a field, so the rule lives
 * here as data, declared exactly once:
 *
 *   V3_PROFILE_FIELDS — every field and what it feeds
 *   ContentView       — what the writer prompt may see (no address, hours, logo, socials, type)
 *   SchemaView        — what the schema builder may see (no niche, own words, description)
 *
 * Both views are derived from that map with mapped types, so `buildGenerationUserV3(p: ContentView)`
 * cannot reference `p.address` — that is a compile error, not something a reviewer has to catch.
 * Adding a field with use: 'schema' removes it from ContentView on the same edit.
 *
 * Types protect code that names a field. They do not protect against a stray JSON.stringify of the
 * whole profile, so business-profile.v3.test.ts drives sentinel values through the real prompt and
 * schema builders and asserts neither side leaks. The two mechanisms together are the guarantee.
 */

export type FieldUse = 'content' | 'schema' | 'both';

interface FieldSpec {
  use: FieldUse;
  /** The label this field is given when rendered into the writer prompt. */
  label: string;
  /** Per-subfield use, for fields whose parts are split across the two jobs. */
  subfields?: Record<string, FieldUse>;
}

/**
 * The single source of truth. Order here is the order fields appear in the prompt's business block.
 *
 * `niche` carries a hard rule from the schema spec: the free-text niche description feeds content
 * generation only, has no schema.org property, and must never appear in any JSON-LD output.
 */
export const V3_PROFILE_FIELDS = {
  // ---- identity ----
  business_name: { use: 'both', label: 'Business name' },
  description: { use: 'content', label: 'What the business does' },
  own_words: { use: 'content', label: 'In their own words' },
  niche: { use: 'content', label: 'Niche' },

  // ---- offer ----
  services: {
    use: 'both',
    label: 'Services',
    subfields: { name: 'both', description: 'content', geo_scope: 'schema' },
  },

  // ---- reach ----
  is_local: { use: 'both', label: 'Local business' },
  service_model: { use: 'both', label: 'How they serve customers' },
  locations_served: { use: 'both', label: 'Locations served' },

  // ---- positioning ----
  differentiators: { use: 'content', label: 'What makes them stand out' },
  ideal_client: { use: 'content', label: 'Ideal client' },

  // ---- action ----
  call_to_action: { use: 'content', label: 'Call to action' },
  cta_url: { use: 'both', label: 'Call-to-action link' },

  // ---- contact ----
  phone: { use: 'both', label: 'Phone' },

  // ---- schema-only: accepted, used for JSON-LD, never shown to the writer ----
  business_type: { use: 'schema', label: 'Schema business type' },
  address: { use: 'schema', label: 'Address' },
  hours: { use: 'schema', label: 'Opening hours' },
  logo_url: { use: 'schema', label: 'Logo' },
  social_links: { use: 'schema', label: 'Social profiles' },
  price_range: { use: 'schema', label: 'Price range' },
} as const satisfies Record<string, FieldSpec>;

type Spec = typeof V3_PROFILE_FIELDS;
export type ProfileFieldKey = keyof Spec;

type KeysFor<U extends FieldUse> = {
  [K in ProfileFieldKey]: Spec[K]['use'] extends U ? K : never;
}[ProfileFieldKey];

export type ContentKey = KeysFor<'content'> | KeysFor<'both'>;
export type SchemaKey = KeysFor<'schema'> | KeysFor<'both'>;

// ---------- value shapes ----------

export type ServiceModel = 'storefront' | 'travelling' | 'nationwide';

export interface ServiceGeoScope {
  type: 'radius' | 'areas' | 'national';
  radius_km?: number;
  areas?: string[];
}

export interface ServiceEntry {
  name: string;
  description?: string;
  geo_scope?: ServiceGeoScope;
}

export type ContentService = Pick<ServiceEntry, 'name' | 'description'>;
export type SchemaService = Pick<ServiceEntry, 'name' | 'geo_scope'>;

export interface PostalAddressInput {
  street?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
}

/** One opening-hours rule. Closed days are simply omitted rather than given empty times. */
export interface HoursEntry {
  days: string[];
  opens: string;
  closes: string;
}

export interface BusinessProfileV3 {
  business_name?: string;
  description?: string;
  own_words?: string;
  niche?: string;
  services?: ServiceEntry[];
  is_local?: boolean;
  service_model?: ServiceModel;
  locations_served?: string[];
  differentiators?: string[];
  ideal_client?: string;
  call_to_action?: string;
  cta_url?: string;
  phone?: string;
  // schema-only
  business_type?: string;
  address?: PostalAddressInput;
  hours?: HoursEntry[];
  logo_url?: string;
  social_links?: string[];
  price_range?: string;
}

/** What the writer prompt is allowed to see. Has no address, hours, logo, socials or schema type. */
export type ContentView = Omit<Pick<BusinessProfileV3, ContentKey>, 'services'> & {
  services?: ContentService[];
};

/** What the schema builder is allowed to see. Has no niche, own words or description. */
export type SchemaView = Omit<Pick<BusinessProfileV3, SchemaKey>, 'services'> & {
  services?: SchemaService[];
};

// ---------- projections ----------

const FIELD_ENTRIES = Object.entries(V3_PROFILE_FIELDS) as Array<[ProfileFieldKey, FieldSpec]>;

function feeds(spec: FieldSpec, side: 'content' | 'schema'): boolean {
  return spec.use === side || spec.use === 'both';
}

/** True for a value worth rendering: not undefined/null, not an empty string, array or object. */
export function isPresent(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

function projectServices(
  services: ServiceEntry[] | undefined,
  side: 'content' | 'schema'
): ServiceEntry[] | undefined {
  if (!services?.length) return undefined;
  const sub = V3_PROFILE_FIELDS.services.subfields as Record<string, FieldUse>;
  return services.map((svc) => {
    const out: Record<string, unknown> = {};
    for (const [key, use] of Object.entries(sub)) {
      const value = (svc as unknown as Record<string, unknown>)[key];
      if (!isPresent(value)) continue;
      if (use === side || use === 'both') out[key] = value;
    }
    return out as unknown as ServiceEntry;
  });
}

function project(profile: BusinessProfileV3, side: 'content' | 'schema'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of FIELD_ENTRIES) {
    if (!feeds(spec, side)) continue;
    if (key === 'services') {
      const svc = projectServices(profile.services, side);
      if (svc) out.services = svc;
      continue;
    }
    const value = (profile as Record<string, unknown>)[key];
    if (isPresent(value)) out[key] = value;
  }
  return out;
}

/**
 * The profile as the writer may see it. Built by walking V3_PROFILE_FIELDS rather than by hand, so
 * it cannot drift from the declaration above.
 */
export function contentView(profile: BusinessProfileV3): ContentView {
  return project(profile, 'content') as ContentView;
}

/** The profile as the schema builder may see it. Same guarantee, opposite side. */
export function schemaView(profile: BusinessProfileV3): SchemaView {
  return project(profile, 'schema') as SchemaView;
}

// ---------- field audit (surfaced in the test endpoint's diagnostics) ----------

export interface FieldAudit {
  /** Content-feeding fields that carried a value and reached the prompt. */
  content_included: string[];
  /** Content-feeding fields the caller left blank. */
  content_empty: string[];
  /** Schema-only fields the caller DID send, deliberately kept out of the prompt. */
  schema_only_withheld: string[];
  /** Schema-feeding fields that carried a value and reached the JSON-LD. */
  schema_included: string[];
}

export function auditFields(profile: BusinessProfileV3): FieldAudit {
  const audit: FieldAudit = {
    content_included: [],
    content_empty: [],
    schema_only_withheld: [],
    schema_included: [],
  };
  for (const [key, spec] of FIELD_ENTRIES) {
    const present = isPresent((profile as Record<string, unknown>)[key]);
    if (feeds(spec, 'content')) {
      (present ? audit.content_included : audit.content_empty).push(key);
    }
    if (feeds(spec, 'schema') && present) {
      audit.schema_included.push(key);
      if (spec.use === 'schema') audit.schema_only_withheld.push(key);
    }
  }
  return audit;
}

/** Every field declared schema-only. Drives the leak tests and the tester UI's "withheld" panel. */
export function schemaOnlyKeys(): ProfileFieldKey[] {
  return FIELD_ENTRIES.filter(([, s]) => s.use === 'schema').map(([k]) => k);
}

/** Every field declared content-only. These values must never reach JSON-LD. */
export function contentOnlyKeys(): ProfileFieldKey[] {
  return FIELD_ENTRIES.filter(([, s]) => s.use === 'content').map(([k]) => k);
}

export function labelFor(key: ProfileFieldKey): string {
  return V3_PROFILE_FIELDS[key].label;
}

// ---------- service identity ----------

/**
 * The matching key for a service name. `services_selected` arrives as free text from a form, so a
 * trailing space or different casing must not silently drop an `about` reference from the schema.
 */
export function serviceKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');
}

// ---------- rendering for the writer ----------

/**
 * The business block as it appears in the writer's prompt.
 *
 * Lives here, beside the declaration of what the writer may see, and takes a ContentView rather
 * than a profile. That is what makes it impossible to render the address: the parameter type does
 * not have one. It also keeps the function free of the generator's import chain, so the leak tests
 * can drive it without a database.
 */
export function renderBusinessBlock(p: ContentView): string {
  const line = (key: ProfileFieldKey, value: string) => `  - ${labelFor(key)}: ${value}`;
  const lines: string[] = [];

  if (p.business_name) lines.push(line('business_name', p.business_name));
  if (p.description) lines.push(line('description', p.description));
  if (p.own_words) lines.push(line('own_words', `"${p.own_words}"`));
  if (p.niche) lines.push(line('niche', p.niche));

  if (p.services?.length) {
    const rendered = p.services
      .map((s) => (s.description ? `${s.name} (${s.description})` : s.name))
      .join('; ');
    lines.push(line('services', rendered));
  }

  if (p.service_model) {
    const how =
      p.service_model === 'storefront'
        ? 'customers come to them'
        : p.service_model === 'travelling'
          ? 'they travel to the customer'
          : 'they serve customers nationwide, not a local area';
    lines.push(line('service_model', how));
  }

  if (p.locations_served?.length) lines.push(line('locations_served', p.locations_served.join(', ')));
  if (p.differentiators?.length) lines.push(line('differentiators', p.differentiators.join('; ')));
  if (p.ideal_client) lines.push(line('ideal_client', p.ideal_client));
  if (p.phone) lines.push(line('phone', p.phone));

  return lines.length ? lines.join('\n') : '  (none provided)';
}

// ---------- leak check ----------

export interface LeakCheck {
  /** Schema-only values that reached the writer prompt and are carried by no content field. */
  schema_values_found_in_prompt: string[];
  /** Content-only values that reached the JSON-LD and are carried by no schema field. */
  content_values_found_in_schema: string[];
  passed: boolean;
}

/** Every string buried anywhere in a value, so nested objects and arrays are covered too. */
function allStrings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(allStrings);
  if (v && typeof v === 'object') return Object.values(v as object).flatMap(allStrings);
  return [];
}

/**
 * Short values match by accident. "US" as a country code would hit any word containing it, and a
 * two-digit house number appears in half the prices on the page.
 */
function distinctive(v: unknown): string[] {
  return allStrings(v)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
}

/**
 * Check the separation against the strings a request actually produced.
 *
 * The types stop a developer naming a withheld field; this catches a value arriving on the wrong
 * side by a route the type system never saw, such as a whole profile being stringified into a block.
 *
 * The subtlety that makes this useful rather than noisy: a value only counts as leaked if the
 * opposite side carries it AND no legitimate field on that side does. The address locality is
 * almost always also one of the locations served, and the locations served are content-feeding —
 * so finding the city in the prompt proves nothing. Without this exclusion the check fires on
 * virtually every real local business and gets ignored, which is worse than not having it.
 */
export function runLeakCheck(
  profile: BusinessProfileV3,
  promptText: string,
  schemaJson: string
): LeakCheck {
  const haystackPrompt = promptText.toLowerCase();
  const haystackSchema = schemaJson.toLowerCase();

  // What each side is legitimately allowed to carry.
  const okInPrompt = new Set(distinctive(contentView(profile)).map((s) => s.toLowerCase()));
  const okInSchema = new Set(distinctive(schemaView(profile)).map((s) => s.toLowerCase()));

  const collect = (keys: ProfileFieldKey[], haystack: string, allowed: Set<string>): string[] => {
    const found: string[] = [];
    for (const key of keys) {
      for (const value of distinctive((profile as Record<string, unknown>)[key])) {
        const needle = value.toLowerCase();
        if (allowed.has(needle)) continue; // a permitted field carries this same value
        if (haystack.includes(needle)) found.push(`${key}: ${value}`);
      }
    }
    return found;
  };

  const schemaInPrompt = collect(schemaOnlyKeys(), haystackPrompt, okInPrompt);
  const contentInSchema = collect(contentOnlyKeys(), haystackSchema, okInSchema);

  return {
    schema_values_found_in_prompt: schemaInPrompt,
    content_values_found_in_schema: contentInSchema,
    passed: schemaInPrompt.length === 0 && contentInSchema.length === 0,
  };
}

// ---------- parsing untrusted request bodies ----------

const SERVICE_MODELS: ServiceModel[] = ['storefront', 'travelling', 'nationwide'];

const DAY_NAMES: Record<string, string> = {
  mon: 'Monday',
  monday: 'Monday',
  tue: 'Tuesday',
  tues: 'Tuesday',
  tuesday: 'Tuesday',
  wed: 'Wednesday',
  weds: 'Wednesday',
  wednesday: 'Wednesday',
  thu: 'Thursday',
  thur: 'Thursday',
  thurs: 'Thursday',
  thursday: 'Thursday',
  fri: 'Friday',
  friday: 'Friday',
  sat: 'Saturday',
  saturday: 'Saturday',
  sun: 'Sunday',
  sunday: 'Sunday',
  publicholidays: 'PublicHolidays',
};

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function strArray(v: unknown): string[] | undefined {
  if (typeof v === 'string') {
    const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  }
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
  return out.length ? out : undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function parseAddress(raw: unknown): PostalAddressInput | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  // `city`/`state` are accepted as aliases so a v2-shaped body (and the plugin's existing
  // brand_profile.location) maps across without the caller rewriting it.
  const addr: PostalAddressInput = {
    street: str(r.street) ?? str(r.streetAddress) ?? str(r.street_address),
    locality: str(r.locality) ?? str(r.city),
    region: str(r.region) ?? str(r.state),
    postal_code: str(r.postal_code) ?? str(r.postalCode) ?? str(r.zip),
    country: str(r.country) ?? str(r.addressCountry),
    latitude: num(r.latitude ?? r.lat),
    longitude: num(r.longitude ?? r.lng ?? r.lon),
  };
  const kept = Object.fromEntries(Object.entries(addr).filter(([, v]) => v !== undefined));
  return Object.keys(kept).length ? (kept as PostalAddressInput) : undefined;
}

function parseHours(raw: unknown): HoursEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: HoursEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    // Accept either `day: "Monday"` or `days: ["Mon","Tue"]`.
    const rawDays = strArray(r.days) ?? strArray(r.day) ?? strArray(r.dayOfWeek);
    const opens = str(r.opens);
    const closes = str(r.closes);
    if (!rawDays || !opens || !closes) continue;
    const days = rawDays
      .map((d) => DAY_NAMES[d.toLowerCase().replace(/[^a-z]/g, '')] ?? undefined)
      .filter((d): d is string => Boolean(d));
    if (days.length) out.push({ days, opens, closes });
  }
  return out.length ? out : undefined;
}

function parseServices(raw: unknown): ServiceEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ServiceEntry[] = [];
  for (const item of raw) {
    // A plain string list is accepted: it is what the v2 brand_profile carried.
    if (typeof item === 'string') {
      const name = item.trim();
      if (name) out.push({ name });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = str(r.name);
    if (!name) continue;
    const svc: ServiceEntry = { name };
    const desc = str(r.description);
    if (desc) svc.description = desc;
    const scope = r.geo_scope;
    if (scope && typeof scope === 'object') {
      const s = scope as Record<string, unknown>;
      const type = str(s.type);
      if (type === 'radius' || type === 'areas' || type === 'national') {
        svc.geo_scope = { type };
        const km = num(s.radius_km);
        if (km !== undefined) svc.geo_scope.radius_km = km;
        const areas = strArray(s.areas);
        if (areas) svc.geo_scope.areas = areas;
      }
    }
    out.push(svc);
  }
  return out.length ? out : undefined;
}

export interface ParsedProfile {
  profile: BusinessProfileV3;
  warnings: string[];
}

/**
 * Build a BusinessProfileV3 from an untrusted request body.
 *
 * Tolerant by design: unknown keys are dropped, malformed sub-objects are skipped with a warning
 * rather than failing the request, and a v2-shaped `brand_profile` is accepted as a deprecated
 * alias so an older Postman body or a copy-pasted v2 payload still produces a populated business
 * block instead of a silent "(none provided)".
 */
export function parseBusinessProfile(raw: unknown, legacyBrandProfile?: unknown): ParsedProfile {
  const warnings: string[] = [];
  const source: Record<string, unknown> =
    raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};

  if (legacyBrandProfile && typeof legacyBrandProfile === 'object') {
    const bp = legacyBrandProfile as Record<string, unknown>;
    warnings.push('brand_profile is deprecated; its values were merged into business_profile');
    const loc = (bp.location ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = {
      business_name: bp.business_name,
      services: bp.services,
      differentiators: bp.differentiators,
      address: { city: loc.city, state: loc.state },
      locations_served: loc.city ? [loc.city] : undefined,
    };
    for (const [k, v] of Object.entries(merged)) {
      if (source[k] === undefined && isPresent(v)) source[k] = v;
    }
  }

  const profile: BusinessProfileV3 = {};

  const assign = <K extends keyof BusinessProfileV3>(key: K, value: BusinessProfileV3[K]) => {
    if (value !== undefined) profile[key] = value;
  };

  assign('business_name', str(source.business_name));
  assign('description', str(source.description));
  assign('own_words', str(source.own_words));
  assign('niche', str(source.niche));
  assign('services', parseServices(source.services));

  if (typeof source.is_local === 'boolean') profile.is_local = source.is_local;

  const model = str(source.service_model);
  if (model) {
    if (SERVICE_MODELS.includes(model as ServiceModel)) {
      profile.service_model = model as ServiceModel;
    } else {
      warnings.push(`service_model "${model}" is not one of ${SERVICE_MODELS.join(', ')}; ignored`);
    }
  }

  assign('locations_served', strArray(source.locations_served));
  assign('differentiators', strArray(source.differentiators));
  assign('ideal_client', str(source.ideal_client));
  assign('call_to_action', str(source.call_to_action));
  assign('cta_url', str(source.cta_url));
  assign('phone', str(source.phone));

  // schema-only
  assign('business_type', str(source.business_type));
  assign('address', parseAddress(source.address));
  const hours = parseHours(source.hours);
  if (source.hours !== undefined && !hours) {
    warnings.push('hours could not be parsed; expected [{ days: [...], opens, closes }]');
  }
  assign('hours', hours);
  assign('logo_url', str(source.logo_url) ?? str(source.logo));
  assign('social_links', strArray(source.social_links) ?? strArray(source.sameAs));
  assign('price_range', str(source.price_range));

  // `is_local` is what the spec's first question answers, and everything downstream reads it.
  // Infer it from the service model rather than leaving it undefined when only one was sent.
  if (profile.is_local === undefined && profile.service_model) {
    profile.is_local = profile.service_model !== 'nationwide';
  }

  return { profile, warnings };
}
