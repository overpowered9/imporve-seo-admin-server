import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { startTestApp } from '../test/helpers/http-app.js';
import { requireAdmin } from '../middleware/adminAuth.middleware.js';
import generationsRoutes from './generations.routes.js';

test('/api/v1/generations is mounted behind requireAdmin (it was open to anyone)', () => {
  // index.ts boots the whole server on import, so the wiring is checked from source.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const index = fs.readFileSync(path.join(here, '..', 'index.ts'), 'utf8');
  assert.match(index, /app\.use\('\/api\/v1\/generations', requireAdmin, generationsRoutes\);/);
  assert.doesNotMatch(index, /app\.use\('\/api\/v1\/generations', generationsRoutes\)/);
});

test('without an admin token, list / read / delete are refused before any handler runs', async () => {
  const mounted = Router();
  mounted.use(requireAdmin, generationsRoutes);
  const app = await startTestApp([['/api/v1/generations', mounted]]);
  try {
    for (const [method, url] of [['GET', '/api/v1/generations'], ['GET', '/api/v1/generations/abc'], ['DELETE', '/api/v1/generations/abc'], ['GET', '/api/v1/generations/stats/overview']] as const) {
      const r = await fetch(`${app.baseUrl}${url}`, { method });
      // 401 with ADMIN_PASSWORD set, 503 without: either way refused, and no Mongo query ran.
      assert.ok(r.status === 401 || r.status === 503, `${method} ${url} → ${r.status}`);
    }
    const bad = await fetch(`${app.baseUrl}/api/v1/generations`, { headers: { Authorization: 'Bearer not-a-token' } });
    assert.ok(bad.status === 401 || bad.status === 503, String(bad.status));
  } finally {
    await app.close();
  }
});
