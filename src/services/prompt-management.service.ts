import { Types } from 'mongoose';
import { 
  PromptTemplate, 
  PromptVersion, 
  IPromptTemplate, 
  IPromptVersion
} from '../models/prompt.models.js';

export interface ActivePromptVersion {
  text: string;
  version: number;
  versionId: string;
  label: string | null;
}

/** The label that marks the backup of an old content_v3_* value (OPS2, WR3). */
export const PRE_V3_LABEL = 'pre-v3';

export class PromptManagementService {

  /**
   * The active version's text AND which version it is, so a run can log exactly which prompt it
   * used (model-call.ts). Same lookup and errors as getPrompt.
   */
  async getPromptWithVersion(templateType: string): Promise<ActivePromptVersion> {
    const template = await PromptTemplate.findOne({ templateType: templateType as any });
    if (!template) {
      throw new Error(`Template '${templateType}' not found`);
    }
    const activeVersion = await PromptVersion.findOne({ templateId: template._id, isActive: true }).sort({ version: -1 });
    if (!activeVersion) {
      throw new Error(`No active version found for template '${templateType}'`);
    }
    return {
      text: activeVersion.prompt,
      version: activeVersion.version,
      versionId: activeVersion._id.toString(),
      label: activeVersion.label ?? null,
    };
  }

  /**
   * Get a specific prompt by template type (simplified for focused approach)
   */
  async getPrompt(templateType: string): Promise<string> {
    const template = await PromptTemplate.findOne({ 
      templateType: templateType as any
    });
    
    if (!template) {
      throw new Error(`Template '${templateType}' not found`);
    }

    // Get the active version for this template. While a version is being activated two are briefly
    // active (the target is switched on before the others are switched off); the highest version
    // wins, as in the other active-version reads in this file.
    const activeVersion = await PromptVersion.findOne({
      templateId: template._id,
      isActive: true
    }).sort({ version: -1 });

    if (!activeVersion) {
      throw new Error(`No active version found for template '${templateType}'`);
    }

    return activeVersion.prompt;
  }

  /**
   * Get all templates
   */
  async getAllTemplates(): Promise<IPromptTemplate[]> {
    return await PromptTemplate.find().sort({ orderIndex: 1, name: 1 });
  }

  /**
   * Get template by name
   */
  async getTemplateByName(name: string): Promise<IPromptTemplate | null> {
    return await PromptTemplate.findOne({ name });
  }

  /**
   * Get active version for a template
   */
  async getActiveVersion(templateId: string): Promise<IPromptVersion | null> {
    return await PromptVersion.findOne({ templateId, isActive: true }).sort({ version: -1 });
  }

  /**
   * Get all versions for a template
   */
  async getTemplateVersions(templateId: string): Promise<IPromptVersion[]> {
    return await PromptVersion.find({ templateId }).sort({ version: -1 });
  }

  /**
   * Process prompt template variables (replace {{variable}} with actual values)
   */
  processPromptVariables(prompt: string, variables: Record<string, string>): string {
    let processedPrompt = prompt;
    
    Object.entries(variables).forEach(([key, value]) => {
      const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      processedPrompt = processedPrompt.replace(placeholder, value || '');
    });

    return processedPrompt;
  }

  /**
   * Extract variables from a prompt template
   */
  extractVariables(prompt: string): string[] {
    const variableRegex = /\{\{([^}]+)\}\}/g;
    const variables: string[] = [];
    let match;

    while ((match = variableRegex.exec(prompt)) !== null) {
      if (!variables.includes(match[1])) {
        variables.push(match[1]);
      }
    }

    return variables;
  }

  // ===== VERSION MANAGEMENT METHODS =====

  /**
   * Create a new prompt template (for system seeding only)
   */
  async createPromptTemplate(
    name: string,
    displayName: string,
    description: string,
    templateType: IPromptTemplate['templateType'],
    category: IPromptTemplate['category'],
    variables: string[] = [],
    isSystem: boolean = false
  ): Promise<IPromptTemplate> {
    const template = new PromptTemplate({
      name,
      displayName,
      description,
      templateType,
      category,
      variables,
      isSystem
    });

    return await template.save();
  }

  /**
   * Create a new version for a template
   */
  async createTemplateVersion(
    templateId: string, 
    versionData: {
      prompt: string;
      createdBy: string;
      label?: string;
      metadata?: {
        notes?: string;
        expectedOutput?: string;
      };
    }
  ): Promise<IPromptVersion> {
    // Get the highest version number for this template
    const latestVersion = await PromptVersion.findOne({ templateId })
      .sort({ version: -1 })
      .exec();
    
    const nextVersion = latestVersion ? latestVersion.version + 1 : 1;

    const newVersion = new PromptVersion({
      templateId: new Types.ObjectId(templateId),
      version: nextVersion,
      prompt: versionData.prompt,
      isActive: false, // New versions start as inactive
      createdBy: versionData.createdBy,
      ...(versionData.label ? { label: versionData.label.slice(0, 120) } : {}),
      metadata: versionData.metadata
    });

    return await newVersion.save();
  }

  /**
   * Activate a specific version (deactivates all other versions for this template)
   */
  async activateTemplateVersion(templateId: string, versionId: string): Promise<IPromptVersion> {
    // Activate the target FIRST, then deactivate the others. The old order (deactivate all, then
    // activate one) left a window with no active version, in which every getPrompt threw and the
    // pipelines silently fell back to their in-code text. Now the worst case is a moment with two
    // active versions, and getPromptWithVersion picks the highest number. The version must also
    // belong to this template, so a stray id cannot activate another template's prompt.
    const activatedVersion = await PromptVersion.findOneAndUpdate(
      { _id: versionId, templateId },
      { isActive: true },
      { new: true }
    );

    if (!activatedVersion) {
      throw new Error('Version not found');
    }

    await PromptVersion.updateMany(
      { templateId, _id: { $ne: activatedVersion._id } },
      { isActive: false }
    );

    return activatedVersion;
  }

  /** True when the template has a version carrying one of these labels (e.g. the replace step ran). */
  async hasVersionLabelled(templateType: string, labels: string[]): Promise<boolean> {
    const template = await PromptTemplate.findOne({ templateType: templateType as any });
    if (!template) return false;
    const v = await PromptVersion.findOne({ templateId: template._id, label: { $in: labels } }).select('_id');
    return !!v;
  }

  /**
   * Back up the active value of each template as a version labelled "pre-v3" (OPS2, WR3), once.
   * A template that already has a pre-v3 version, or has no active version, is left alone. The
   * backup is inactive; the active version is not changed. Non-destructive and idempotent.
   */
  async backupPreV3(templateTypes: string[], createdBy = 'system-backup'): Promise<Array<{ templateType: string; result: 'backed_up' | 'already_backed_up' | 'no_template' | 'no_active_version'; version?: number }>> {
    const out: Array<{ templateType: string; result: 'backed_up' | 'already_backed_up' | 'no_template' | 'no_active_version'; version?: number }> = [];
    for (const templateType of templateTypes) {
      const template = await PromptTemplate.findOne({ templateType: templateType as any });
      if (!template) {
        out.push({ templateType, result: 'no_template' });
        continue;
      }
      const existing = await PromptVersion.findOne({ templateId: template._id, label: PRE_V3_LABEL });
      if (existing) {
        out.push({ templateType, result: 'already_backed_up', version: existing.version });
        continue;
      }
      const active = await PromptVersion.findOne({ templateId: template._id, isActive: true }).sort({ version: -1 });
      if (!active) {
        out.push({ templateType, result: 'no_active_version' });
        continue;
      }
      const copy = await this.createTemplateVersion(template._id.toString(), {
        prompt: active.prompt,
        createdBy,
        label: PRE_V3_LABEL,
        metadata: { notes: `Backup of v${active.version}, taken before the Content v3 doc text replaced it` },
      });
      out.push({ templateType, result: 'backed_up', version: copy.version });
    }
    return out;
  }

  /**
   * Get a specific version by ID
   */
  async getVersionById(versionId: string): Promise<IPromptVersion | null> {
    return await PromptVersion.findById(versionId).exec();
  }

  /**
   * Delete a version (cannot delete active version)
   */
  async deleteTemplateVersion(versionId: string): Promise<void> {
    const version = await PromptVersion.findById(versionId);
    
    if (!version) {
      throw new Error('Version not found');
    }

    if (version.isActive) {
      throw new Error('Cannot delete active version. Please activate another version first.');
    }

    await PromptVersion.findByIdAndDelete(versionId);
  }
}