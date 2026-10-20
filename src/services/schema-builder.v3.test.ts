/**
 * JSON-LD shape tests for the three business scenarios and the @id wiring.
 *
 * The thing worth protecting here is the reference pattern: the article points at the business and
 * at the services it covers, and never repeats either. Get that wrong and every page on the site
 * publishes a second, competing copy of the business entity.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { schemaView, type BusinessProfileV3 } from './business-profile.v3.js';
import {
  buildArticleSchema,
  buildBusinessEntity,
  businessId,
  normaliseSiteUrl,
  serviceId,
} from './schema-builder.v3.js';

const SITE = 'https://example.com';

function profile(overrides: Partial<BusinessProfileV3> = {}): BusinessProfileV3 {
  return {
    business_name: 'Desert Cool HVAC',
    phone: '+1-602-555-0184',
    is_local: true,
    service_model: 'storefront',
    locations_served: ['Phoenix', 'Tempe'],
    business_type: 'HVACBusiness',
    address: {
      street: '4120 W Indian School Rd',
      locality: 'Phoenix',
      region: 'AZ',
      postal_code: '85019',
      country: 'US',
      latitude: 33.4949,
      longitude: -112.1489,
    },
    hours: [{ days: ['Monday', 'Tuesday'], opens: '07:00', closes: '18:00' }],
    logo_url: 'https://example.com/logo.png',
    social_links: ['https://facebook.com/example'],
    price_range: '$$',
    services: [
      { name: 'AC replacement', geo_scope: { type: 'areas', areas: ['Phoenix'] } },
      { name: 'Emergency AC repair' },
    ],
    ...overrides,
  };
}

function build(p: BusinessProfileV3) {
  return buildBusinessEntity(schemaView(p), { siteUrl: SITE });
}

describe('business entity — scenario A, storefront', () => {
  test('publishes address, coordinates and opening hours', () => {
    const { schema } = build(profile());
    const s = schema as Record<string, any>;
    assert.deepEqual(s['@type'], ['LocalBusiness', 'HVACBusiness']);
    assert.equal(s['@id'], businessId(SITE));
    assert.equal(s.address.streetAddress, '4120 W Indian School Rd');
    assert.equal(s.address.addressLocality, 'Phoenix');
    assert.equal(s.geo.latitude, 33.4949);
    assert.equal(s.openingHoursSpecification[0].opens, '07:00');
    assert.deepEqual(s.openingHoursSpecification[0].dayOfWeek, ['Monday', 'Tuesday']);
  });

  test('omits coordinates when the address carries none', () => {
    const p = profile();
    delete p.address!.latitude;
    delete p.address!.longitude;
    const s = build(p).schema as Record<string, any>;
    assert.equal(s.geo, undefined);
  });

  test('nests services as an offer catalog with per-service @ids', () => {
    const s = build(profile()).schema as Record<string, any>;
    const items = s.hasOfferCatalog.itemListElement;
    assert.equal(items.length, 2);
    assert.equal(items[0].itemOffered['@id'], serviceId(SITE, 'AC replacement'));
    assert.equal(items[0].itemOffered['@type'], 'Service');
    assert.deepEqual(items[0].itemOffered.areaServed, [{ '@type': 'Place', name: 'Phoenix' }]);
  });
});

describe('business entity — scenario B, travelling', () => {
  test('publishes areas served and withholds the street address', () => {
    const { schema, warnings } = build(profile({ service_model: 'travelling' }));
    const s = schema as Record<string, any>;
    assert.equal(s.address, undefined, 'a service-area business must not publish a storefront address');
    assert.equal(s.geo, undefined);
    assert.deepEqual(s.areaServed, [
      { '@type': 'Place', name: 'Phoenix' },
      { '@type': 'Place', name: 'Tempe' },
    ]);
    assert.ok(s.openingHoursSpecification, 'hours still apply to a travelling business');
    assert.ok(warnings.some((w) => /address supplied for a travelling business/.test(w)));
  });

  test('warns when no areas were supplied', () => {
    const { warnings } = build(profile({ service_model: 'travelling', locations_served: undefined }));
    assert.ok(warnings.some((w) => /no locations_served/.test(w)));
  });
});

describe('business entity — scenario C, nationwide', () => {
  test('is an Organization with no address and no hours', () => {
    const { schema, warnings } = build(
      profile({ service_model: 'nationwide', is_local: false })
    );
    const s = schema as Record<string, any>;
    assert.equal(s['@type'], 'Organization');
    assert.equal(s.address, undefined);
    assert.equal(s.openingHoursSpecification, undefined);
    assert.deepEqual(s.areaServed, { '@type': 'Country', name: 'Nationwide' });
    assert.ok(warnings.some((w) => /Organization, not a LocalBusiness/.test(w)));
  });
});

describe('business entity — business_type allowlist', () => {
  test('an unrecognised type degrades to LocalBusiness with a warning', () => {
    const { schema, warnings } = build(profile({ business_type: 'NotARealSchemaType' }));
    assert.equal((schema as Record<string, any>)['@type'], 'LocalBusiness');
    assert.ok(warnings.some((w) => /not a recognised schema.org LocalBusiness subtype/.test(w)));
  });

  test('a missing type is simply LocalBusiness, with no warning', () => {
    const { schema, warnings } = build(profile({ business_type: undefined }));
    assert.equal((schema as Record<string, any>)['@type'], 'LocalBusiness');
    assert.equal(warnings.length, 0);
  });
});

describe('business entity — site url', () => {
  test('returns nothing when there is no usable site url', () => {
    const { schema, warnings } = buildBusinessEntity(schemaView(profile()), { siteUrl: '' });
    assert.equal(schema, null);
    assert.ok(warnings.some((w) => /site_url missing/.test(w)));
  });

  test('normalises a bare domain and strips a trailing slash', () => {
    assert.equal(normaliseSiteUrl('example.com/'), 'https://example.com');
    assert.equal(normaliseSiteUrl('https://example.com/blog/'), 'https://example.com/blog');
  });
});

describe('article node', () => {
  const base = {
    siteUrl: SITE,
    postUrl: `${SITE}/blog/ac-cost/`,
    headline: 'What AC replacement costs in Phoenix',
    description: 'A meta description of roughly the right length for both purposes.',
    imageUrl: `${SITE}/hero.jpg`,
  };

  test('references the business by @id instead of repeating it', () => {
    const { schema } = buildArticleSchema(base, ['AC replacement']);
    const s = schema as Record<string, any>;
    assert.deepEqual(s.publisher, { '@id': businessId(SITE) });
    assert.equal(s.name, undefined, 'the article must not restate the business name');
    assert.equal(s.address, undefined);
  });

  test('description is the meta description, reused verbatim', () => {
    const { schema } = buildArticleSchema(base, []);
    assert.equal((schema as Record<string, any>).description, base.description);
  });

  test('points about at the selected services, matching loosely on name', () => {
    const { schema, matched, unmatched } = buildArticleSchema(
      { ...base, aboutServices: ['  ac replacement '] },
      ['AC replacement', 'Emergency AC repair']
    );
    assert.deepEqual(matched, ['AC replacement']);
    assert.deepEqual(unmatched, []);
    assert.deepEqual((schema as Record<string, any>).about, {
      '@id': serviceId(SITE, 'AC replacement'),
    });
  });

  test('reports a selection that matched nothing instead of dropping it quietly', () => {
    const { unmatched, warnings } = buildArticleSchema(
      { ...base, aboutServices: ['Pool cleaning'] },
      ['AC replacement']
    );
    assert.deepEqual(unmatched, ['Pool cleaning']);
    assert.ok(warnings.some((w) => /no match on the business profile/.test(w)));
  });

  test('omits publisher and about rather than emitting dangling @ids', () => {
    const { schema, warnings } = buildArticleSchema(
      { ...base, siteUrl: undefined, aboutServices: ['AC replacement'] },
      ['AC replacement']
    );
    const s = schema as Record<string, any>;
    assert.equal(s.publisher, undefined);
    assert.equal(s.about, undefined);
    assert.ok(warnings.some((w) => /dangling @ids/.test(w)));
  });

  test('never invents dates', () => {
    const s = buildArticleSchema(base, []).schema as Record<string, any>;
    assert.equal(s.datePublished, undefined);
    assert.equal(s.dateModified, undefined);
  });

  test('caps an over-long headline so the node stays valid', () => {
    const s = buildArticleSchema({ ...base, headline: 'x'.repeat(200) }, []).schema as Record<
      string,
      any
    >;
    assert.equal(s.headline.length, 110);
  });
});
