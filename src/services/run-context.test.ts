import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTag, runWith } from './run-context.js';
import { createDataForSeoClient } from './keyword-data/dataforseo.client.js';

test('runTag: " run=<key>" inside a run (through awaits), nothing outside or for an invalid key', async () => {
  assert.equal(runTag(), '');
  await runWith('iseo_tk_0123456789abcdef', async () => {
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(runTag(), ' run=iseo_tk_0123456789abcdef');
  });
  runWith('bad key\nwith newline', () => assert.equal(runTag(), ''));
  assert.equal(runTag(), '');
});

test('a shared DataForSEO client tags its lines with the run being served', async () => {
  const lines: string[] = [];
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ status_code: 20000, cost: 0.002, tasks: [{ id: 't', status_code: 20000, status_message: 'Ok.', cost: 0.002, result: [{ items: [] }] }] }), { status: 200 })) as unknown as typeof fetch;
  const client = createDataForSeoClient({ login: 'l', password: 'p', fetchImpl, log: (l: string) => lines.push(l), sleep: async () => {} } as any);
  await runWith('iseo_tk_0123456789abcdef', () => client.keywordOverview({ keywords: ['x'], location_code: 2840, language_code: 'en' } as any).catch(() => {}));
  assert.ok(lines.some((l) => l.startsWith('[dataforseo] run=iseo_tk_0123456789abcdef ')), lines.join('\n'));
});
