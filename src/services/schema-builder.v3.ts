/**
 * JSON-LD construction for the v3 content route.
 *
 * Two building blocks, per the schema spec:
 *
 *   buildBusinessEntity — the site-wide business, injected on every page by the plugin. Returned by
 *                         the route as a PREVIEW so the operator can see what the profile produces.
 *   buildArticleSchema  — the per-post node, which references the business by @id rather than
 *                         repeating it, and points `about` at the services the post covers.
 *
 * Both take a SchemaView, not a BusinessProfileV3. That is the enforcement: the free-text niche,
 * the "in their own words" blurb and the business description are absent from the type, so the
 * spec's hard rule ("the niche free-text field never appears in any JSON-LD output") cannot be
 * broken here without a compile error.
 *
 * Everything is driven off a single stable @id (`<site>/#business`). When no site URL is supplied
 * the publisher and about references are OMITTED rather than emitted relative: a dangling @id is
 * worse than a missing property, because it silently splits the entity graph.
 */

import type { SchemaView, ServiceGeoScope } from './business-profile.v3.js';
import { serviceKey } from './business-profile.v3.js';

/**
 * schema.org LocalBusiness subtypes we are willing to emit.
 *
 * An arbitrary string in @type invalidates the whole node for Google, and `business_type` comes
 * from a user-facing dropdown that can drift, so unknown values degrade to plain LocalBusiness and
 * raise a warning instead of poisoning the output.
 */
export const LOCAL_BUSINESS_TYPES = [
  'AccountingService',
  'AutoBodyShop',
  'AutoRepair',
  'BeautySalon',
  'ChildCare',
  'Dentist',
  'DaySpa',
  'DryCleaningOrLaundry',
  'Electrician',
  'EmergencyService',
  'EntertainmentBusiness',
  'EventVenue',
  'FinancialService',
  'Florist',
  'FoodEstablishment',
  'GeneralContractor',
  'HVACBusiness',
  'HairSalon',
  'HealthAndBeautyBusiness',
  'HomeAndConstructionBusiness',
  'HousePainter',
  'InsuranceAgency',
  'LegalService',
  'Locksmith',
  'LodgingBusiness',
  'MedicalBusiness',
  'MedicalClinic',
  'MovingCompany',
  'NailSalon',
  'Notary',
  'Optician',
  'Pharmacy',
  'Physician',
  'PhysicalTherapy',
  'Plumber',
  'ProfessionalService',
  'RealEstateAgent',
  'Restaurant',
  'RoofingContractor',
  'SelfStorage',
  'ShoppingCenter',
  'SportsActivityLocation',
  'Store',
  'TravelAgency',
  'VeterinaryCare',
] as const;

export type LocalBusinessType = (typeof LOCAL_BUSINESS_TYPES)[number];

const LOCAL_BUSINESS_TYPE_SET = new Set<string>(LOCAL_BUSINESS_TYPES);

export interface SchemaBuildResult {
  schema: Record<string, unknown> | null;
  warnings: string[];
}

/** Trim a site URL to a stable origin-ish base with no trailing slash. */
export function normaliseSiteUrl(raw?: string): string | undefined {
  const s = (raw || '').trim();
  if (!s) return undefined;
  const withProtocol = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withProtocol);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

export function businessId(siteUrl: string): string {
  return `${siteUrl}/#business`;
}

export function serviceId(siteUrl: string, name: string): string {
  return `${siteUrl}/#service-${serviceKey(name)}`;
}

function imageObject(url: string): Record<string, unknown> {
  return { '@type': 'ImageObject', url };
}

function placeList(names: string[]): Record<string, unknown>[] {
  return names.map((name) => ({ '@type': 'Place', name }));
}

function areaServedFromScope(scope: ServiceGeoScope): unknown {
  if (scope.type === 'national') return { '@type': 'Country', name: 'Nationwide' };
  if (scope.type === 'areas' && scope.areas?.length) return placeList(scope.areas);
  if (scope.type === 'radius' && scope.radius_km !== undefined) {
    // GeoCircle needs a centre point; without one, the radius alone is not expressible, so we
    // describe the scope rather than emit a malformed node.
    return { '@type': 'GeoShape', description: `Within ${scope.radius_km} km` };
  }
  return undefined;
}

/**
 * The site-wide business entity.
 *
 * Scenario handling, straight from the spec:
 *   storefront  — address + geo + opening hours + areaServed
 *   travelling  — NO address (a service-area business publishing a street address is the classic
 *                 local-SEO mistake), areaServed from the locations served, plus hours
 *   nationwide  — Organization, no address, no hours, a Country areaServed
 */
export function buildBusinessEntity(
  p: SchemaView,
  opts: { siteUrl?: string }
): SchemaBuildResult {
  const warnings: string[] = [];
  const siteUrl = normaliseSiteUrl(opts.siteUrl);
  if (!siteUrl) {
    warnings.push('site_url missing or unparseable — business entity cannot be anchored by @id');
    return { schema: null, warnings };
  }

  const model = p.service_model ?? (p.is_local === false ? 'nationwide' : 'storefront');
  const isLocal = p.is_local ?? model !== 'nationwide';

  // @type: a combined array for local businesses with a recognised subtype, per the spec's
  // ["LocalBusiness", "Dentist"] pattern; Organization for anything not geographically tied.
  let type: string | string[];
  if (!isLocal) {
    type = 'Organization';
    if (p.business_type) {
      warnings.push(
        `business_type "${p.business_type}" ignored: a nationwide business is an Organization, not a LocalBusiness`
      );
    }
  } else if (p.business_type && LOCAL_BUSINESS_TYPE_SET.has(p.business_type)) {
    type = ['LocalBusiness', p.business_type];
  } else {
    type = 'LocalBusiness';
    if (p.business_type) {
      warnings.push(
        `business_type "${p.business_type}" is not a recognised schema.org LocalBusiness subtype — emitted as LocalBusiness`
      );
    }
  }

  const entity: Record<string, unknown> = {
    '@type': type,
    '@id': businessId(siteUrl),
    url: siteUrl,
  };

  if (p.business_name) entity.name = p.business_name;
  if (p.phone) entity.telephone = p.phone;
  if (p.logo_url) entity.logo = imageObject(p.logo_url);
  if (p.social_links?.length) entity.sameAs = p.social_links;
  if (p.price_range) entity.priceRange = p.price_range;

  if (model === 'storefront') {
    const a = p.address;
    if (a && (a.street || a.locality)) {
      const address: Record<string, unknown> = { '@type': 'PostalAddress' };
      if (a.street) address.streetAddress = a.street;
      if (a.locality) address.addressLocality = a.locality;
      if (a.region) address.addressRegion = a.region;
      if (a.postal_code) address.postalCode = a.postal_code;
      if (a.country) address.addressCountry = a.country;
      entity.address = address;
    } else {
      warnings.push('service_model is storefront but no usable address was supplied');
    }
    // Coordinates are geocoded from the address, never typed by the user — so they are emitted
    // only when actually present rather than guessed from the locality.
    if (a?.latitude !== undefined && a?.longitude !== undefined) {
      entity.geo = { '@type': 'GeoCoordinates', latitude: a.latitude, longitude: a.longitude };
    }
    if (p.locations_served?.length) entity.areaServed = placeList(p.locations_served);
  } else if (model === 'travelling') {
    if (p.address) {
      warnings.push(
        'address supplied for a travelling business — omitted from schema, since there is no public storefront to describe'
      );
    }
    if (p.locations_served?.length) {
      entity.areaServed = placeList(p.locations_served);
    } else {
      warnings.push('service_model is travelling but no locations_served were supplied');
    }
  } else {
    entity.areaServed = { '@type': 'Country', name: 'Nationwide' };
    if (p.address) warnings.push('address omitted: a nationwide business has no service address');
    if (p.hours?.length) warnings.push('hours omitted: a nationwide business publishes no opening hours');
  }

  if (model !== 'nationwide' && p.hours?.length) {
    entity.openingHoursSpecification = p.hours.map((h) => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: h.days,
      opens: h.opens,
      closes: h.closes,
    }));
  }

  if (p.services?.length) {
    entity.hasOfferCatalog = {
      '@type': 'OfferCatalog',
      name: 'Services',
      itemListElement: p.services.map((svc) => {
        const offered: Record<string, unknown> = {
          '@type': 'Service',
          '@id': serviceId(siteUrl, svc.name),
          name: svc.name,
        };
        // No description here by design: ServiceEntry.description is declared content-only, so it
        // is not even present on SchemaView.
        if (svc.geo_scope) {
          const area = areaServedFromScope(svc.geo_scope);
          if (area) offered.areaServed = area;
        }
        return { '@type': 'Offer', itemOffered: offered };
      }),
    };
  }

  return { schema: entity, warnings };
}

export interface ArticleSchemaParams {
  siteUrl?: string;
  postUrl?: string;
  headline: string;
  /** The final meta description. Reused verbatim — no separate summary is generated. */
  description: string;
  imageUrl?: string;
  authorName?: string;
  datePublished?: string;
  dateModified?: string;
  language?: string;
  articleType?: 'Article' | 'BlogPosting';
  /** Service names this post is about, already matched against the profile. */
  aboutServices?: string[];
}

export interface ArticleSchemaResult extends SchemaBuildResult {
  /** Names that matched a service on the profile and became an @id reference. */
  matched: string[];
  /** Names that matched nothing — reported rather than silently dropped. */
  unmatched: string[];
}

/**
 * The per-post node.
 *
 * `description` is the article's existing meta description rather than a freshly generated summary:
 * it is already written to 150-160 characters, which sits inside the range Google weighs for
 * structured data, so one value serves both purposes.
 */
export function buildArticleSchema(
  params: ArticleSchemaParams,
  availableServices: string[] = []
): ArticleSchemaResult {
  const warnings: string[] = [];
  const siteUrl = normaliseSiteUrl(params.siteUrl);

  const article: Record<string, unknown> = {
    '@type': params.articleType || 'BlogPosting',
    // Google truncates long headlines; keeping the node valid matters more than the full string,
    // which the reader sees as the H1 anyway.
    headline: params.headline.slice(0, 110),
    description: params.description,
  };

  if (params.postUrl) {
    article.url = params.postUrl;
    article.mainEntityOfPage = { '@type': 'WebPage', '@id': params.postUrl };
  }
  if (params.imageUrl) article.image = imageObject(params.imageUrl);
  if (params.authorName) article.author = { '@type': 'Person', name: params.authorName };
  // Dates are WordPress's to own. Inventing a publish date here would put a claim in the markup
  // that the page itself contradicts.
  if (params.datePublished) article.datePublished = params.datePublished;
  if (params.dateModified) article.dateModified = params.dateModified;
  if (params.language) article.inLanguage = params.language;

  const availableKeys = new Map(availableServices.map((n) => [serviceKey(n), n]));
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const wanted of params.aboutServices || []) {
    const hit = availableKeys.get(serviceKey(wanted));
    if (hit) matched.push(hit);
    else unmatched.push(wanted);
  }
  if (unmatched.length) {
    warnings.push(
      `services_selected had no match on the business profile: ${unmatched.join(', ')}`
    );
  }

  if (siteUrl) {
    article.publisher = { '@id': businessId(siteUrl) };
    if (matched.length) {
      const refs = matched.map((name) => ({ '@id': serviceId(siteUrl, name) }));
      article.about = refs.length === 1 ? refs[0] : refs;
    }
  } else {
    warnings.push(
      'site_url missing — publisher and about references omitted rather than emitted as dangling @ids'
    );
  }

  return { schema: article, warnings, matched, unmatched };
}
