import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disclaimerFor, parseDisclaimers } from './niche-profile.default.js';

test('G4: no disclaimer until a real text exists; never an empty or placeholder one', () => {
  assert.deepEqual(parseDisclaimers('{}'), {});
  assert.deepEqual(parseDisclaimers(null), {});
  assert.deepEqual(parseDisclaimers('{bad json'), {});
  assert.deepEqual(parseDisclaimers('{"dental":"","legal_services":"TBD"}'), {});
  const d = parseDisclaimers('{"dental":"This article is general information, not dental advice for your case.","health":"This article is general information, not medical advice for your situation."}');
  assert.equal(disclaimerFor(d, 'dental', 'health'), 'This article is general information, not dental advice for your case.');
  assert.equal(disclaimerFor(d, 'medical', 'health'), 'This article is general information, not medical advice for your situation.');
  assert.equal(disclaimerFor(d, 'legal_services', 'money_legal'), null);
});
