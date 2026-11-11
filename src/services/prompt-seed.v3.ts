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
 */

import { PromptManagementService } from './prompt-management.service.js';
import { V3_PROMPT_DEFS } from './claude-content-generator-v3.service.js';
import { V3_STEP_PROMPT_DEFS } from './content-v3-steps/prompts.js';

export interface SeedReportEntry {
  templateType: string;
  displayName: string;
  template: 'created' | 'existing';
  version: 'seeded' | 'left as-is';
  activeVersion?: number;
}

export async function seedV3Prompts(
  svc: PromptManagementService = new PromptManagementService()
): Promise<SeedReportEntry[]> {
  const report: SeedReportEntry[] = [];

  // The Writer-chain prompts (claude-content-generator-v3.service.ts) plus the Title/Planner step
  // prompts (content-v3-steps/prompts.ts), all with the same idempotent, skip-only treatment.
  const defs = [...Object.values(V3_PROMPT_DEFS), ...Object.values(V3_STEP_PROMPT_DEFS)];
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
    if (active) {
      entry.activeVersion = active.version;
      report.push(entry);
      continue;
    }

    const version = await svc.createTemplateVersion(templateId, {
      prompt: def.fallback,
      createdBy: 'system-seed',
      metadata: { notes: 'Seeded from the in-code v3 fallback constant' },
    });
    await svc.activateTemplateVersion(templateId, version._id.toString());
    entry.version = 'seeded';
    entry.activeVersion = version.version;
    report.push(entry);
  }

  return report;
}
