/**
 * Seeding for the v3 content prompts.
 *
 * This lives in a tracked service rather than a script on purpose. `src/scripts/*` is gitignored
 * (see the comment block in .gitignore), which is why `npm run seed:content-v2` currently points at
 * a file that is not in the repo and cannot run on a deploy. The v3 equivalent is reachable as an
 * admin endpoint instead, so the documented workflow — deploy, then tune prompts from the
 * dashboard — needs no shell access on the host.
 *
 * Idempotent and non-destructive: a template that already has an active version is left completely
 * alone, so re-running can never overwrite a prompt that was tuned in the panel.
 *
 * REPLACE MODE (Content v3, OPS2 / WR3). The doc-sourced prompts (V3_DOC_PROMPT_DEFS: text taken
 * byte for byte from docs/content-v3-prompt-drafts.md, pinned by the equality tests) must be what
 * production actually runs. `mode: 'replace'` makes each of them the active version when the
 * active text differs from the doc text, after backing up the old active value as a version
 * labelled "pre-v3" (once). Nothing is deleted; the old version stays selectable in the panel.
 * The legacy Writer-chain prompts (V3_PROMPT_DEFS) are never replaced: their in-code text is the
 * OLD text, and replacing would overwrite tuning with it.
 */

import { PromptManagementService, PRE_V3_LABEL } from './prompt-management.service.js';
import type { IPromptTemplate } from '../models/prompt.models.js';
import { V3_PROMPT_DEFS } from './claude-content-generator-v3.service.js';
import { V3_STEP_PROMPT_DEFS } from './content-v3-steps/prompts.js';

export interface SeedReportEntry {
  templateType: string;
  displayName: string;
  template: 'created' | 'existing';
  version: 'seeded' | 'left as-is' | 'replaced' | 'already current';
  activeVersion?: number;
  /** Replace mode: the version number of the "pre-v3" backup, when one exists. */
  backupVersion?: number;
}

interface PromptDef {
  templateType: IPromptTemplate['templateType'];
  displayName: string;
  fallback: string;
}

/**
 * The prompts whose in-code text IS the doc text (equality tests). Later phases add Research,
 * the Writer draft 2 core and the rules blocks here.
 */
export function v3DocPromptDefs(): PromptDef[] {
  return [...Object.values(V3_STEP_PROMPT_DEFS)];
}

export const DOC_VERSION_LABEL = 'content-v3 doc';

export async function seedV3Prompts(
  svc: PromptManagementService = new PromptManagementService(),
  opts: { mode?: 'skip' | 'replace' } = {}
): Promise<SeedReportEntry[]> {
  const report: SeedReportEntry[] = [];
  const mode = opts.mode ?? 'skip';
  const docTypes = new Set(v3DocPromptDefs().map((d) => d.templateType));

  // The Writer-chain prompts (claude-content-generator-v3.service.ts) plus the Title/Planner step
  // prompts (content-v3-steps/prompts.ts), all with the same idempotent, skip-only treatment.
  const seen = new Set<string>();
  const defs: PromptDef[] = [...Object.values(V3_PROMPT_DEFS), ...v3DocPromptDefs()].filter((d) => {
    if (seen.has(d.templateType)) return false;
    seen.add(d.templateType);
    return true;
  });
  for (const def of defs) {
    const entry: SeedReportEntry = {
      templateType: def.templateType,
      displayName: def.displayName,
      template: 'existing',
      version: 'left as-is',
    };

    // The template `name` must equal its templateType. The admin templates listing does not project
    // templateType, so the prompts page can only filter on name — get this wrong and the v3 page
    // renders empty while the templates sit there perfectly well formed.
    const existing = await svc.getTemplateByName(def.templateType);
    let templateId: string;

    if (existing) {
      templateId = existing._id.toString();
    } else {
      const created = await svc.createPromptTemplate(
        def.templateType, // name (unique, and what the prompts page filters on)
        def.displayName,
        def.displayName,
        def.templateType, // templateType (what getPrompt looks up)
        'content_generation',
        [], // no {{variables}} — these are static system blocks
        true // isSystem
      );
      templateId = created._id.toString();
      entry.template = 'created';
    }

    const active = await svc.getActiveVersion(templateId);
    if (active && mode === 'replace' && docTypes.has(def.templateType)) {
      if (active.prompt === def.fallback) {
        entry.version = 'already current';
        entry.activeVersion = active.version;
        report.push(entry);
        continue;
      }
      const [backup] = await svc.backupPreV3([def.templateType], 'system-seed');
      if (backup?.version !== undefined) entry.backupVersion = backup.version;
      const replacement = await svc.createTemplateVersion(templateId, {
        prompt: def.fallback,
        createdBy: 'system-seed',
        label: DOC_VERSION_LABEL,
        metadata: { notes: `Text from docs/content-v3-prompt-drafts.md; the previous active value is kept as "${PRE_V3_LABEL}"` },
      });
      await svc.activateTemplateVersion(templateId, replacement._id.toString());
      entry.version = 'replaced';
      entry.activeVersion = replacement.version;
      report.push(entry);
      continue;
    }
    if (active) {
      entry.activeVersion = active.version;
      report.push(entry);
      continue;
    }

    const version = await svc.createTemplateVersion(templateId, {
      prompt: def.fallback,
      createdBy: 'system-seed',
      label: docTypes.has(def.templateType) ? DOC_VERSION_LABEL : undefined,
      metadata: { notes: 'Seeded from the in-code v3 fallback constant' },
    });
    await svc.activateTemplateVersion(templateId, version._id.toString());
    entry.version = 'seeded';
    entry.activeVersion = version.version;
    report.push(entry);
  }

  return report;
}

export interface PromptCheckEntry {
  templateType: string;
  status: 'equal' | 'differs' | 'missing';
  activeVersion?: number;
  label?: string | null;
  /** First differing character index when status is 'differs'. */
  firstDiffAt?: number;
  dbLength?: number;
  docLength: number;
}

/**
 * Production gate item 2: does every doc-sourced prompt's ACTIVE DB version equal the doc text?
 * Read-only. 'missing' means production runs the in-code text (which equals the doc), but the
 * panel has nothing to tune until /prompts/seed runs.
 */
export async function checkV3Prompts(svc: PromptManagementService = new PromptManagementService()): Promise<PromptCheckEntry[]> {
  const out: PromptCheckEntry[] = [];
  for (const def of v3DocPromptDefs()) {
    try {
      const active = await svc.getPromptWithVersion(def.templateType);
      if (active.text === def.fallback) {
        out.push({ templateType: def.templateType, status: 'equal', activeVersion: active.version, label: active.label, docLength: def.fallback.length, dbLength: active.text.length });
      } else {
        let i = 0;
        while (i < active.text.length && i < def.fallback.length && active.text[i] === def.fallback[i]) i++;
        out.push({ templateType: def.templateType, status: 'differs', activeVersion: active.version, label: active.label, firstDiffAt: i, dbLength: active.text.length, docLength: def.fallback.length });
      }
    } catch {
      out.push({ templateType: def.templateType, status: 'missing', docLength: def.fallback.length });
    }
  }
  return out;
}
