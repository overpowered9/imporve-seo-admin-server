import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployInfo, healthPayload } from './deploy-info.js';

const noEnv = {} as NodeJS.ProcessEnv;

describe('deployInfo', () => {
  test('echoes the branch and commit Render injects', () => {
    const env = { RENDER_GIT_BRANCH: '16-9-26', RENDER_GIT_COMMIT: 'c2a29a4f00' } as NodeJS.ProcessEnv;
    assert.deepEqual(deployInfo(env), { branch: '16-9-26', commit: 'c2a29a4f00' });
  });

  test('is null off Render rather than inventing a value', () => {
    assert.deepEqual(deployInfo(noEnv), { branch: null, commit: null });
    assert.deepEqual(deployInfo({ RENDER_GIT_BRANCH: '  ', RENDER_GIT_COMMIT: '' } as NodeJS.ProcessEnv),
      { branch: null, commit: null });
  });
});

describe('GET /health body', () => {
  test('keeps its existing fields and adds the deploy identity and the keyword-lists flag', () => {
    const now = new Date('2026-10-13T09:00:00Z');
    const body = healthPayload({ RENDER_GIT_BRANCH: 'main', RENDER_GIT_COMMIT: 'd6cc207' } as NodeJS.ProcessEnv, now);
    assert.equal(body.status, 'healthy');
    assert.equal(body.service, 'improveseo-ai-server');
    assert.ok(body.features.includes('Credit System'));
    assert.deepEqual(body.deploy, { branch: 'main', commit: 'd6cc207' });
    assert.equal(body.keyword_lists, 'free');
    assert.equal(body.timestamp, '2026-10-13T09:00:00.000Z');
  });

  test('the route serves this payload', () => {
    // index.ts boots the whole server on import, so the wiring is checked from source.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const index = fs.readFileSync(path.join(here, '..', 'index.ts'), 'utf8');
    assert.match(index, /app\.get\('\/health', \(req, res\) => \{\s*res\.json\(healthPayload\(\)\);/);
  });
});
