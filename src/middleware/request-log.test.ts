import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactBody, requestLogBody } from './request-log.js';

test('content v3 bodies: only the field names reach the log (owner answers, phone, business text)', () => {
  const body = { session_key: 'iseo_tk_x', owner_answers: [{ question: 'Typical cost?', answer: 'About $300.' }], cta_phone: '+1 505 555 0100', anything_else: 'Mention our van.' };
  assert.deepEqual(requestLogBody('/api/v1/content-v3/article', body), { fields: ['session_key', 'owner_answers', 'cta_phone', 'anything_else'] });
  assert.deepEqual(requestLogBody('/api/v1/content-v3/wizard/approve', { title: 'T' }), { fields: ['title'] });
  assert.doesNotMatch(JSON.stringify(requestLogBody('/api/v1/content-v3/article', body)), /300|555|van/);
});

test('other routes keep the deep redaction, now including cta_phone', () => {
  assert.deepEqual(requestLogBody('/api/v1/auth/login', { email: 'a@b.c', password: 'x' }), { email: 'a@b.c', password: '[redacted]' });
  assert.deepEqual(redactBody({ profile: { phone: '1', cta_phone: '2', name: 'n' } }), { profile: { phone: '[redacted]', cta_phone: '[redacted]', name: 'n' } });
  assert.equal(requestLogBody('/api/v1/content-v2/article', undefined), undefined);
});
