import { PromptTemplate, PromptVersion, IPromptTemplate, IPromptVersion } from '../models/prompt.models.js';
import { Types } from 'mongoose';

export interface PromptParameters {
  seed_keyword?: string;
  audience_data?: string;
  lsi_keywords?: string;
  facts?: string;
  context?: string;
  section_topic?: string;
  section_outline?: string;
  relevant_facts?: string;
  main_points?: string;
  call_to_action?: string;
  article_content?: string;
  article_topic?: string;
  article_focus?: string;
  article_summary?: string;
  main_benefit?: string;
  [key: string]: any; // Allow additional dynamic parameters
}

export interface PromptSetConfig {
  audience_generation?: string | null;
  lsi_keywords?: string | null;
  facts_generation?: string | null;
  format_template?: string | null; // 'small', 'medium', or 'large'
  section_content?: string | null;
  conclusion?: string | null;
  faqs?: string | null;
  whats_next?: string | null;
  meta_title?: string | null;
  meta_description?: string | null;
}

export class PromptService {
  /**
   * Get all available system templates
   */
  async getSystemTemplates(): Promise<IPromptTemplate[]> {
    return await PromptTemplate.find({ isSystem: true }).sort({ name: 1 });
  }

  /**
   * Get active prompt for a specific template type
   */
  async getActivePrompt(templateType: string): Promise<IPromptVersion | null> {
    const template = await PromptTemplate.findOne({ 
      templateType: templateType as any,
      isSystem: true 
    });
    
    if (!template) {
      return null;
    }

    return await PromptVersion.findOne({ 
      templateId: template._id,
      isActive: true 
    });
  }

  /**
   * Get active prompt with fallback to default
   */
  async getPromptWithFallback(templateType: string): Promise<string> {
    try {
      const activeVersion = await this.getActivePrompt(templateType);
      
      if (activeVersion) {
        return activeVersion.prompt;
      }

      // Fallback: try to get version 1 (default system version)
      const template = await PromptTemplate.findOne({ 
        templateType: templateType as any,
        isSystem: true 
      });
      
      if (template) {
        const defaultVersion = await PromptVersion.findOne({ 
          templateId: template._id,
          version: 1 
        });
        
        if (defaultVersion) {
          console.warn(`⚠️ Using default version for ${templateType}, no active version found`);
          return defaultVersion.prompt;
        }
      }

      // Final fallback: basic template
      return this.getFallbackPrompt(templateType);
      
    } catch (error) {
      console.error(`❌ Error getting prompt for ${templateType}:`, error);
      return this.getFallbackPrompt(templateType);
    }
  }

  /**
   * Get fallback prompts for critical template types
   */
  private getFallbackPrompt(templateType: string): string {
    const fallbacks: Record<string, string> = {
      audience_generation: 'Analyze the target audience for "{seed_keyword}". Consider demographics, interests, and content preferences.',
      lsi_keywords: 'Generate 15 LSI keywords related to "{seed_keyword}" that would be relevant for content creation.',
      facts_generation: 'Provide 8-10 relevant facts and statistics about "{seed_keyword}" that would be valuable for content creation.',
      format_small: 'Create a content outline for a 500-800 word article about "{seed_keyword}" with introduction, main content, and conclusion.',
      format_medium: 'Create a content outline for an 800-1500 word article about "{seed_keyword}" with detailed sections and FAQ.',
      format_large: 'Create a comprehensive content outline for a 1500+ word article about "{seed_keyword}" with multiple sections, FAQ, and what\'s next.',
      section_content: 'Write engaging content for the section "{section_topic}" related to "{seed_keyword}". Target audience: {audience_data}',
      conclusion: 'Write a conclusion for an article about "{seed_keyword}" summarizing: {main_points}',
      faqs: 'Generate 5 frequently asked questions and answers about "{seed_keyword}" for the target audience.',
      whats_next: 'Create a "What\'s Next" section for an article about "{seed_keyword}" with next steps and related topics.',
      meta_title: 'Create an SEO-optimized meta title (50-60 characters) for an article about "{seed_keyword}".',
      meta_description: 'Create an SEO-optimized meta description (150-160 characters) for an article about "{seed_keyword}".'
    };

    const fallback = fallbacks[templateType];
    if (!fallback) {
      console.error(`❌ No fallback available for template type: ${templateType}`);
      return `Generate content related to "{seed_keyword}" for the template type: ${templateType}`;
    }

    console.warn(`⚠️ Using hardcoded fallback for ${templateType}`);
    return fallback;
  }

  /**
   * Process template variables in a prompt
   */
  processPromptVariables(prompt: string, parameters: PromptParameters): string {
    let processedPrompt = prompt;
    
    // Replace all parameter variables
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined && value !== null) {
        const regex = new RegExp(`\\{${key}\\}`, 'g');
        processedPrompt = processedPrompt.replace(regex, String(value));
      }
    }

    // Warn about unresolved variables
    const unresolvedMatches = processedPrompt.match(/\{[^}]+\}/g);
    if (unresolvedMatches) {
      console.warn(`⚠️ Unresolved variables in prompt: ${unresolvedMatches.join(', ')}`);
      
      // Replace with placeholders
      unresolvedMatches.forEach(match => {
        processedPrompt = processedPrompt.replace(new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[NOT_PROVIDED]');
      });
    }

    return processedPrompt;
  }

  /**
   * Get processed prompt for a template type
   */
  async getProcessedPrompt(templateType: string, parameters: PromptParameters): Promise<string> {
    const rawPrompt = await this.getPromptWithFallback(templateType);
    return this.processPromptVariables(rawPrompt, parameters);
  }

  /**
   * Get all prompts for a prompt set configuration
   */
  async getPromptSet(config: PromptSetConfig, parameters: PromptParameters): Promise<Record<string, string>> {
    const results: Record<string, string> = {};

    for (const [templateType, versionId] of Object.entries(config)) {
      if (versionId === null) {
        // Skip this template
        continue;
      }

      try {
        let prompt: string;

        if (versionId && versionId !== 'default') {
          // Use specific version
          const version = await PromptVersion.findById(versionId);
          if (version) {
            prompt = version.prompt;
          } else {
            console.warn(`⚠️ Version ${versionId} not found for ${templateType}, using fallback`);
            prompt = await this.getPromptWithFallback(templateType);
          }
        } else {
          // Use active/default version
          prompt = await this.getPromptWithFallback(templateType);
        }

        // Handle format template selection
        if (templateType === 'format_template' && versionId) {
          const formatType = `format_${versionId}`; // 'format_small', 'format_medium', 'format_large'
          prompt = await this.getPromptWithFallback(formatType);
        }

        results[templateType] = this.processPromptVariables(prompt, parameters);

      } catch (error) {
        console.error(`❌ Error processing ${templateType}:`, error);
        results[templateType] = this.processPromptVariables(
          this.getFallbackPrompt(templateType), 
          parameters
        );
      }
    }

    return results;
  }

  /**
   * Get default prompt set configuration
   */
  getDefaultPromptSetConfig(): PromptSetConfig {
    return {
      audience_generation: 'default',
      lsi_keywords: 'default',
      facts_generation: 'default',
      format_template: 'medium', // small, medium, or large
      section_content: 'default',
      conclusion: 'default',
      faqs: 'default',
      whats_next: 'default',
      meta_title: 'default',
      meta_description: 'default'
    };
  }

  /**
   * Create a new prompt version
   */
  async createPromptVersion(
    templateId: string | Types.ObjectId,
    prompt: string,
    createdBy: string,
    metadata?: any
  ): Promise<IPromptVersion> {
    const template = await PromptTemplate.findById(templateId);
    if (!template) {
      throw new Error('Template not found');
    }

    // Get next version number
    const lastVersion = await PromptVersion.findOne({ templateId })
      .sort({ version: -1 });
    const nextVersion = (lastVersion?.version || 0) + 1;

    // Create new version
    const version = new PromptVersion({
      templateId,
      version: nextVersion,
      prompt,
      isActive: false, // Don't auto-activate
      createdBy,
      metadata: metadata || {}
    });

    return await version.save();
  }

  /**
   * Activate a prompt version (deactivates others)
   */
  async activatePromptVersion(versionId: string | Types.ObjectId): Promise<void> {
    const version = await PromptVersion.findById(versionId);
    if (!version) {
      throw new Error('Version not found');
    }

    // Deactivate all other versions for this template
    await PromptVersion.updateMany(
      { templateId: version.templateId },
      { isActive: false }
    );

    // Activate this version
    await PromptVersion.updateOne(
      { _id: versionId },
      { isActive: true }
    );
  }

  /**
   * Get all versions for a template
   */
  async getTemplateVersions(templateId: string | Types.ObjectId): Promise<IPromptVersion[]> {
    return await PromptVersion.find({ templateId }).sort({ version: -1 });
  }

  /**
   * Validate prompt set configuration
   */
  validatePromptSetConfig(config: PromptSetConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const requiredTemplates = ['audience_generation', 'lsi_keywords', 'facts_generation'];

    for (const required of requiredTemplates) {
      if (!config[required as keyof PromptSetConfig]) {
        errors.push(`Missing required template: ${required}`);
      }
    }

    // Validate format template selection
    if (config.format_template && !['small', 'medium', 'large', null].includes(config.format_template)) {
      errors.push('format_template must be "small", "medium", "large", or null');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

export const promptService = new PromptService();