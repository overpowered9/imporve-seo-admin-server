import { Types } from 'mongoose';
import { 
  PromptTemplate, 
  PromptVersion, 
  IPromptTemplate, 
  IPromptVersion
} from '../models/prompt.models.js';

export class PromptManagementService {
  
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

    // Get the active version for this template
    const activeVersion = await PromptVersion.findOne({
      templateId: template._id,
      isActive: true
    });

    if (!activeVersion) {
      throw new Error(`No active version found for template '${templateType}'`);
    }

    return activeVersion.prompt;
  }

  /**
   * Get all templates
   */
  async getAllTemplates(): Promise<IPromptTemplate[]> {
    return await PromptTemplate.find().sort({ name: 1 });
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
      metadata: versionData.metadata
    });

    return await newVersion.save();
  }

  /**
   * Activate a specific version (deactivates all other versions for this template)
   */
  async activateTemplateVersion(templateId: string, versionId: string): Promise<IPromptVersion> {
    // Deactivate all versions for this template
    await PromptVersion.updateMany(
      { templateId },
      { isActive: false }
    );

    // Activate the specified version
    const activatedVersion = await PromptVersion.findByIdAndUpdate(
      versionId,
      { isActive: true },
      { new: true }
    );

    if (!activatedVersion) {
      throw new Error('Version not found');
    }

    return activatedVersion;
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

  /**
   * Get active version for a template
   */
  async getActiveVersion(templateId: string): Promise<IPromptVersion | null> {
    return await PromptVersion.findOne({ 
      templateId, 
      isActive: true 
    }).exec();
  }
}