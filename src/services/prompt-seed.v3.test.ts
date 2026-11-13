/**
 * seedV3Prompts replace mode and checkV3Prompts against an in-memory prompt registry.
 *
 * What is protected (OPS2, WR3, gate item 2):
 *  - skip mode never touches a template that has an active version;
 *  - replace mode makes the doc text active for DOC-SOURCED prompts only, after backing the old
 *    value up once as "pre-v3"; nothing is deleted; re-running is a no-op;
 *  - legacy Writer-chain prompts are never replaced;
 *  - the check reports equal / differs / missing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkV3Prompts, seedV3Prompts, v3DocPromptDefs, DOC_VERSION_LABEL } from './prompt-seed.v3.js';
import { PRE_V3_LABEL, type PromptManagementService } from './prompt-management.service.js';

interface V { _id: string; templateId: string; version: number; prompt: string; isActive: boolean; label?: string }

function fakeRegistry() {
  const templates: Array<{ _id: string; name: string; templateType: string }> = [];
  const versions: V[] = [];
  let id = 0;
  const nextId = () => `id${++id}`;
  const svc = {
    async getTemplateByName(name: string) {
      const t = templates.find((x) => x.name === name);
      return t ? { ...t, _id: { toString: () => t._id } } : null;
    },
    async createPromptTemplate(name: string, _d: string, _desc: string, templateType: string) {
      const t = { _id: nextId(), name, templateType };
      templates.push(t);
      return { ...t, _id: { toString: () => t._id } };
    },
    async getActiveVersion(templateId: string) {
      return versions.filter((v) => v.templateId === templateId && v.isActive).sort((a, b) => b.version - a.version)[0] ?? null;
    },
    async createTemplateVersion(templateId: string, d: { prompt: string; label?: string }) {
      const n = Math.max(0, ...versions.filter((v) => v.templateId === templateId).map((v) => v.version)) + 1;
      const v: V = { _id: nextId(), templateId, version: n, prompt: d.prompt, isActive: false, label: d.label };
      versions.push(v);
      return { ...v, _id: { toString: () => v._id } };
    },
    async activateTemplateVersion(templateId: string, versionId: string) {
      for (const v of versions) if (v.templateId === templateId) v.isActive = v._id === versionId;
      return versions.find((v) => v._id === versionId);
    },
    async backupPreV3(types: string[]) {
      const out = [];
      for (const type of types) {
        const t = templates.find((x) => x.templateType === type)!;
        const existing = versions.find((v) => v.templateId === t._id && v.label === PRE_V3_LABEL);
        if (existing) {
          out.push({ templateType: type, result: 'already_backed_up', version: existing.version });
          continue;
        }
        const active = await svc.getActiveVersion(t._id);
        const copy = await svc.createTemplateVersion(t._id, { prompt: active!.prompt, label: PRE_V3_LABEL });
        out.push({ templateType: type, result: 'backed_up', version: copy.version });
      }
      return out;
    },
    async getPromptWithVersion(type: string) {
      const t = templates.find((x) => x.templateType === type);
      if (!t) throw new Error('not found');
      const a = await svc.getActiveVersion(t._id);
      if (!a) throw new Error('no active');
      return { text: a.prompt, version: a.version, versionId: a._id, label: a.label ?? null };
    },
  };
  return { svc: svc as unknown as PromptManagementService, templates, versions };
}

const TITLE = 'content_v3_title';

describe('seedV3Prompts', () => {
  test('skip mode seeds missing templates and leaves active ones alone', async () => {
    const r = fakeRegistry();
    const first = await seedV3Prompts(r.svc);
    assert.ok(first.every((e) => e.version === 'seeded'));
    const before = r.versions.length;
    const second = await seedV3Prompts(r.svc);
    assert.ok(second.every((e) => e.version === 'left as-is'));
    assert.equal(r.versions.length, before);
  });

  test('replace mode: tuned doc prompt is backed up as pre-v3, doc text activated, nothing deleted', async () => {
    const r = fakeRegistry();
    await seedV3Prompts(r.svc);
    const t = r.templates.find((x) => x.templateType === TITLE)!;
    const tuned = await (r.svc as any).createTemplateVersion(t._id, { prompt: 'TUNED IN PANEL' });
    await (r.svc as any).activateTemplateVersion(t._id, tuned._id.toString());
    const countBefore = r.versions.length;

    const report = await seedV3Prompts(r.svc, { mode: 'replace' });
    const title = report.find((e) => e.templateType === TITLE)!;
    assert.equal(title.version, 'replaced');
    const titleVersions = r.versions.filter((v) => v.templateId === t._id);
    const backup = titleVersions.find((v) => v.label === PRE_V3_LABEL)!;
    assert.equal(backup.prompt, 'TUNED IN PANEL');
    assert.equal(backup.isActive, false);
    const active = titleVersions.find((v) => v.isActive)!;
    assert.equal(active.label, DOC_VERSION_LABEL);
    assert.equal(active.prompt, v3DocPromptDefs().find((d) => d.templateType === TITLE)!.fallback);
    assert.ok(r.versions.length > countBefore, 'versions only ever added');

    // Other doc prompts were already the doc text: no backup, no new version.
    assert.ok(report.filter((e) => e.templateType !== TITLE && v3DocPromptDefs().some((d) => d.templateType === e.templateType)).every((e) => e.version === 'already current'));
    // Legacy writer-chain prompts are never replaced.
    assert.ok(report.filter((e) => !v3DocPromptDefs().some((d) => d.templateType === e.templateType)).every((e) => e.version === 'left as-is'));

    const again = await seedV3Prompts(r.svc, { mode: 'replace' });
    assert.equal(again.find((e) => e.templateType === TITLE)!.version, 'already current');
  });
});

describe('checkV3Prompts', () => {
  test('equal, differs (with the first differing index) and missing', async () => {
    const r = fakeRegistry();
    const missing = await checkV3Prompts(r.svc);
    assert.ok(missing.every((e) => e.status === 'missing'));
    await seedV3Prompts(r.svc);
    assert.ok((await checkV3Prompts(r.svc)).every((e) => e.status === 'equal'));
    const t = r.templates.find((x) => x.templateType === TITLE)!;
    const doc = v3DocPromptDefs().find((d) => d.templateType === TITLE)!.fallback;
    const v = await (r.svc as any).createTemplateVersion(t._id, { prompt: doc.slice(0, 40) + 'X' + doc.slice(41) });
    await (r.svc as any).activateTemplateVersion(t._id, v._id.toString());
    const row = (await checkV3Prompts(r.svc)).find((e) => e.templateType === TITLE)!;
    assert.equal(row.status, 'differs');
    assert.equal(row.firstDiffAt, 40);
  });
});
