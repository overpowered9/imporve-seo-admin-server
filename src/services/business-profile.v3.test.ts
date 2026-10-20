/**
 * The content/schema separation, tested where types cannot reach.
 *
 * The mapped types in business-profile.v3.ts already make `p.address` a compile error inside the
 * prompt builder. What they cannot catch is a value arriving on the wrong side by some route the
 * type system never sees — a whole profile stringified into a block, a spread that widens a view,
 * a field added to the map but forgotten in a projection.
 *
 * So these tests fill every schema-only field with a unique sentinel, render the real business
 * block, and assert none of them appears. The field list is read from V3_PROFILE_FIELDS rather
 * than written out here, which is the point: a field added to the map tomorrow is covered by these
 * tests the same day, without anyone remembering to extend them.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V3_PROFILE_FIELDS,
  BusinessProfileV3,
  auditFields,
  contentOnlyKeys,
  contentView,
  parseBusinessProfile,
  renderBusinessBlock,
  runLeakCheck,
  schemaOnlyKeys,
  schemaView,
  serviceKey,
} from './business-profile.v3.js';
import { buildArticleSchema, buildBusinessEntity } from './schema-builder.v3.js';

/** A profile where every value is traceable to the field it came from. */
function sentinelProfile(): BusinessProfileV3 {
  return {
    business_name: 'ZZCONTENT-business-name Ltd',
    description: 'ZZCONTENT-description of what they do',
    own_words: 'ZZCONTENT-ownwords in their voice',
    niche: 'ZZCONTENT-niche free text detail',
    services: [
      {
        name: 'Root Canal',
        description: 'ZZCONTENT-service-description',
        geo_scope: { type: 'areas', areas: ['ZZSCHEMA-service-area'] },
      },
      { name: 'Teeth Whitening' },
    ],
    is_local: true,
    service_model: 'storefront',
    locations_served: ['Santa Fe'],
    differentiators: ['ZZCONTENT-differentiator'],
    ideal_client: 'ZZCONTENT-idealclient',
    call_to_action: 'ZZCONTENT-cta message',
    cta_url: 'https://example.com/book',
    phone: '+1-505-555-0100',
    // schema-only below
    business_type: 'Dentist',
    address: {
      street: 'ZZSCHEMA-street-address',
      locality: 'ZZSCHEMA-locality',
      region: 'NM',
      postal_code: 'ZZSCHEMA-postcode',
      country: 'US',
      latitude: 35.687,
      longitude: -105.9378,
    },
    hours: [{ days: ['Monday'], opens: '09:00', closes: '17:00' }],
    logo_url: 'https://example.com/ZZSCHEMA-logo.png',
    social_links: ['https://facebook.com/ZZSCHEMA-social'],
    price_range: 'ZZSCHEMA-pricerange',
  };
}

/** Every string buried anywhere in a value, so nested objects are checked too. */
function allStrings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(allStrings);
  if (v && typeof v === 'object') return Object.values(v as object).flatMap(allStrings);
  return [];
}

describe('v3 profile — schema-only fields never reach the writer', () => {
  test('no schema-only value appears in the rendered business block', () => {
    const profile = sentinelProfile();
    const block = renderBusinessBlock(contentView(profile));

    for (const key of schemaOnlyKeys()) {
      for (const value of allStrings((profile as Record<string, unknown>)[key])) {
        assert.ok(
          !block.includes(value),
          `schema-only field "${key}" leaked the value "${value}" into the writer prompt`
        );
      }
    }
  });

  test('the content view has no schema-only keys at all', () => {
    const view = contentView(sentinelProfile()) as Record<string, unknown>;
    for (const key of schemaOnlyKeys()) {
      assert.equal(view[key], undefined, `content view should not carry "${key}"`);
    }
  });

  test('service descriptions reach the writer but their geo scope does not', () => {
    const view = contentView(sentinelProfile());
    const first = view.services?.[0] as Record<string, unknown> | undefined;
    assert.equal(first?.description, 'ZZCONTENT-service-description');
    assert.equal(first?.geo_scope, undefined, 'geo_scope is schema-only');
  });
});

describe('v3 profile — content-only fields never reach the schema', () => {
  test('no content-only value appears in either JSON-LD node', () => {
    const profile = sentinelProfile();
    const view = schemaView(profile);
    const business = buildBusinessEntity(view, { siteUrl: 'https://example.com' });
    const article = buildArticleSchema(
      {
        siteUrl: 'https://example.com',
        headline: 'A headline',
        description: 'A meta description',
        aboutServices: ['Root Canal'],
      },
      (profile.services || []).map((s) => s.name)
    );

    const serialised = JSON.stringify({ business: business.schema, article: article.schema });

    for (const key of contentOnlyKeys()) {
      for (const value of allStrings((profile as Record<string, unknown>)[key])) {
        assert.ok(
          !serialised.includes(value),
          `content-only field "${key}" leaked the value "${value}" into JSON-LD`
        );
      }
    }
  });

  test('the niche free text is absent from the schema — the spec calls this a hard rule', () => {
    const profile = sentinelProfile();
    const business = buildBusinessEntity(schemaView(profile), { siteUrl: 'https://example.com' });
    assert.ok(!JSON.stringify(business.schema).includes('ZZCONTENT-niche free text detail'));
  });

  test('service descriptions are not published in the offer catalog', () => {
    const profile = sentinelProfile();
    const business = buildBusinessEntity(schemaView(profile), { siteUrl: 'https://example.com' });
    assert.ok(!JSON.stringify(business.schema).includes('ZZCONTENT-service-description'));
  });
});

describe('v3 profile — projections stay complete', () => {
  test('every declared field reaches at least one of the two views', () => {
    const profile = sentinelProfile();
    const keys = new Set([
      ...Object.keys(contentView(profile)),
      ...Object.keys(schemaView(profile)),
    ]);
    for (const key of Object.keys(V3_PROFILE_FIELDS)) {
      assert.ok(keys.has(key), `"${key}" is declared but falls out of both views`);
    }
  });

  test('empty values are dropped rather than rendered as blanks', () => {
    const view = contentView({ business_name: '   ', description: 'real', differentiators: [] });
    assert.equal((view as Record<string, unknown>).business_name, undefined);
    assert.equal((view as Record<string, unknown>).differentiators, undefined);
    assert.equal(view.description, 'real');
  });
});

describe('v3 profile — field audit', () => {
  test('reports schema-only fields that were sent as withheld', () => {
    const audit = auditFields(sentinelProfile());
    for (const key of schemaOnlyKeys()) {
      assert.ok(
        audit.schema_only_withheld.includes(key),
        `"${key}" was sent and should be reported as withheld from the prompt`
      );
    }
  });

  test('separates content fields that were supplied from those left blank', () => {
    const audit = auditFields({ description: 'something' });
    assert.ok(audit.content_included.includes('description'));
    assert.ok(audit.content_empty.includes('ideal_client'));
    assert.ok(!audit.content_included.includes('ideal_client'));
  });
});

describe('v3 profile — parsing untrusted bodies', () => {
  test('accepts city/state as aliases for locality/region', () => {
    const { profile } = parseBusinessProfile({ address: { city: 'Phoenix', state: 'AZ' } });
    assert.equal(profile.address?.locality, 'Phoenix');
    assert.equal(profile.address?.region, 'AZ');
  });

  test('accepts a plain string list of services, as v2 sent them', () => {
    const { profile } = parseBusinessProfile({ services: ['Plumbing', '  Drains  ', ''] });
    assert.deepEqual(profile.services, [{ name: 'Plumbing' }, { name: 'Drains' }]);
  });

  test('rejects an unknown service model with a warning rather than failing the request', () => {
    const { profile, warnings } = parseBusinessProfile({ service_model: 'franchise' });
    assert.equal(profile.service_model, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /service_model/);
  });

  test('normalises day names and accepts a singular day key', () => {
    const { profile } = parseBusinessProfile({
      hours: [{ day: 'mon', opens: '09:00', closes: '17:00' }],
    });
    assert.deepEqual(profile.hours, [{ days: ['Monday'], opens: '09:00', closes: '17:00' }]);
  });

  test('infers is_local from the service model when only one was sent', () => {
    assert.equal(parseBusinessProfile({ service_model: 'nationwide' }).profile.is_local, false);
    assert.equal(parseBusinessProfile({ service_model: 'travelling' }).profile.is_local, true);
  });

  test('merges a deprecated v2 brand_profile rather than ignoring it', () => {
    const { profile, warnings } = parseBusinessProfile(undefined, {
      business_name: 'Acme',
      services: ['Roofing'],
      location: { city: 'Tulsa', state: 'OK' },
    });
    assert.equal(profile.business_name, 'Acme');
    assert.deepEqual(profile.services, [{ name: 'Roofing' }]);
    assert.equal(profile.address?.locality, 'Tulsa');
    assert.match(warnings[0], /deprecated/);
  });

  test('a business_profile value wins over the same field from brand_profile', () => {
    const { profile } = parseBusinessProfile(
      { business_name: 'New' },
      { business_name: 'Old' }
    );
    assert.equal(profile.business_name, 'New');
  });
});

describe('v3 profile — leak check', () => {
  test('a schema-only value in the prompt is reported', () => {
    const profile = sentinelProfile();
    const prompt = 'Business block mentioning ZZSCHEMA-street-address somehow.';
    const check = runLeakCheck(profile, prompt, '{}');
    assert.equal(check.passed, false);
    assert.ok(check.schema_values_found_in_prompt.some((s) => s.startsWith('address:')));
  });

  test('a content-only value in the schema is reported', () => {
    const profile = sentinelProfile();
    const check = runLeakCheck(profile, '', JSON.stringify({ x: 'ZZCONTENT-ownwords in their voice' }));
    assert.equal(check.passed, false);
    assert.ok(check.content_values_found_in_schema.some((s) => s.startsWith('own_words:')));
  });

  test('a city shared by the address and the locations served is NOT a leak', () => {
    // The address locality is almost always also one of the areas served, and the areas served are
    // content-feeding. Flagging that was a real false positive: it fired on a perfectly correct
    // request and would have fired on nearly every local business, training everyone to ignore it.
    const profile: BusinessProfileV3 = {
      locations_served: ['Phoenix', 'Scottsdale'],
      address: { locality: 'Phoenix', street: '4120 W Indian School Rd', postal_code: '85019' },
    };
    const prompt = 'Locations served: Phoenix, Scottsdale';
    const check = runLeakCheck(profile, prompt, '{}');
    assert.deepEqual(check.schema_values_found_in_prompt, []);
    assert.equal(check.passed, true);
  });

  test('but the street address in that same prompt still is a leak', () => {
    const profile: BusinessProfileV3 = {
      locations_served: ['Phoenix'],
      address: { locality: 'Phoenix', street: '4120 W Indian School Rd' },
    };
    const prompt = 'Locations served: Phoenix. Visit us at 4120 W Indian School Rd.';
    const check = runLeakCheck(profile, prompt, '{}');
    assert.equal(check.passed, false);
    assert.ok(check.schema_values_found_in_prompt.join(' ').includes('4120 W Indian School Rd'));
  });

  test('a clean request passes both directions', () => {
    const profile = sentinelProfile();
    const check = runLeakCheck(profile, renderBusinessBlock(contentView(profile)), '{}');
    assert.equal(check.passed, true, JSON.stringify(check));
  });

  test('short values are ignored, so a country code cannot trip it', () => {
    const profile: BusinessProfileV3 = { address: { country: 'US' } };
    const check = runLeakCheck(profile, 'A prompt that contains US inside USUAL.', '{}');
    assert.deepEqual(check.schema_values_found_in_prompt, []);
  });
});

describe('v3 profile — service matching', () => {
  test('folds case, spacing and punctuation so a selection is not silently dropped', () => {
    assert.equal(serviceKey('  AC Replacement '), serviceKey('ac replacement'));
    assert.equal(serviceKey('Repair & Service'), 'repair-service');
  });
});
