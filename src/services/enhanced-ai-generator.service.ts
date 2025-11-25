import { PromptManagementService } from './prompt-management.service.js';
import { GeneratePostParams, GeneratePostResult, ChatMessage, generateAiHtmlPost2 } from './ai_content_admin_tuneable.js';
import { OriginalPromptsHelper, BasicPromptParams } from './original-prompts.helper.js';

interface DynamicPromptData {
  audience_generation?: string;
  lsi_keywords?: string;
  facts_generation?: string;
  // Master comprehensive prompts that contain ALL instructions (like PHP $basic_prompt)
  basic_prompt_small?: string;
  basic_prompt_medium?: string;
  basic_prompt_large?: string;
  // Continuation prompts that reference the master context (SHORT prompts)
  section_continuation?: string;
  conclusion_continuation?: string;
  faqs_continuation?: string;
  whats_next_continuation?: string;
  meta_title?: string;
  meta_description?: string;
}

interface VersionTestOverride {
  promptType: string;    // e.g., 'audience_generation'
  versionId: string;     // MongoDB ObjectId as string
}

interface GenerateAiContentDynamicParams extends GeneratePostParams {
  // Additional parameters for dynamic prompt integration
  useActivePrompts?: boolean; // whether to use active prompts from database
  customPrompts?: DynamicPromptData; // optional custom prompts override
  templateVariables?: Record<string, string>; // variables to populate in prompts
  testVersionOverride?: VersionTestOverride; // for version testing - use specific version for one prompt type
}

interface EnhancedGeneratePostResult extends GeneratePostResult {
  promptsUsed?: DynamicPromptData;
  generationMetadata?: {
    templatesUsed: string[];
    promptVersions: Record<string, string>;
    processingTime?: number;
  };
}

export class EnhancedAIContentGenerator {
  constructor(private promptService: PromptManagementService) {}

  /**
   * Generate AI content using dynamic prompts from our focused prompt management system
   * This integrates with the comprehensive generateAiHtmlPost2 pipeline
   */
  async generateAiContentDynamic(params: GenerateAiContentDynamicParams): Promise<EnhancedGeneratePostResult> {
    const startTime = Date.now();
    
    const {
      useActivePrompts = true,
      customPrompts = {},
      templateVariables = {},
      testVersionOverride,
      ...baseParams
    } = params;

    // 1) Fetch active prompts from database if needed
    let prompts: DynamicPromptData = {};
    let promptVersions: Record<string, string> = {};
    let templatesUsed: string[] = [];

    if (useActivePrompts) {
      const activePrompts = await this.fetchActivePrompts(testVersionOverride);
      prompts = activePrompts.prompts;
      promptVersions = activePrompts.versions;
      templatesUsed = activePrompts.templates;
    }

    // 2) Merge with custom prompts (custom overrides active)
    prompts = { ...prompts, ...customPrompts };

    // 3) Populate variables in prompts
    const populatedPrompts = this.populatePromptVariables(prompts, templateVariables);

    // 4) Use generateAiHtmlPost2 with enhanced integration
    const enhancedParams = {
      ...baseParams,
      // Pass audience data if we have it from our prompts
      audienceData: baseParams.audienceData || await this.generateAudienceIfNeeded(populatedPrompts, baseParams)
    };

    // Generate content using the original comprehensive pipeline
    const result = await generateAiHtmlPost2(enhancedParams);

    // 5) Enhance meta generation with custom prompts if available
    const enhancedResult = await this.enhanceWithCustomMeta(result, populatedPrompts, baseParams);

    // 6) Add metadata
    const finalResult: EnhancedGeneratePostResult = {
      ...enhancedResult,
      promptsUsed: populatedPrompts,
      generationMetadata: {
        templatesUsed,
        promptVersions,
        processingTime: Date.now() - startTime
      }
    };

    return finalResult;
  }

  async generateAiHtmlPost(params: GeneratePostParams): Promise<GeneratePostResult> {
    const {
      apiKey = process.env.OPENAI_API_KEY,
      seed_keyword,
      keyword_selection = '',
      seed_options = '',
      nos_of_words = '1200 to 2400 words',
      content_lang = 'en',
      voice_tone = '',
      point_of_view = '',
      title = '',
      call_to_action = '',
      details_to_include = '',
      for_testing_only = 0,
      audienceData
    } = params || ({} as GeneratePostParams);

    if (!apiKey) {
      throw new Error('Missing OpenAI API key');
    }
    if (!seed_keyword) {
      throw new Error('seed_keyword is required');
    }

    const model = 'gpt-4o';
    const wordCountVariant = this.getWordCountVariant(nos_of_words);
    console.log(`🔄 Generating content with wordCountVariant: ${wordCountVariant}`);

    // 1) Ensure audience data (replicates getAudienceData() if not provided)
    const audience = audienceData || await this.generateAudienceData(apiKey, model, seed_keyword, content_lang);
    console.log(`✅ Audience data generated/retrieved`);

    // 2) LSI keywords using dynamic prompt
    const lsiKeywords = await this.generateLSIKeywords(apiKey, model, seed_keyword, audience, content_lang);
    console.log(`✅ LSI keywords generated`);

    // 3) Facts generation using dynamic prompt
    const facts = await this.generateFacts(apiKey, model, seed_keyword, audience, content_lang);
    console.log(`✅ Facts generated`);

    // 4) Build the MASTER basic_prompt with all comprehensive instructions
    // This is the key: ONE big prompt with everything, just like the original PHP
    const basicPrompt = await this.buildBasicPrompt({
      wordCountVariant,
      seed_keyword,
      title: title || '',
      lsiKeywords,
      voice_tone: voice_tone || '',
      point_of_view: point_of_view || '',
      audience,
      details_to_include: details_to_include || '',
      content_lang: content_lang || '',
      call_to_action: call_to_action || '',
      facts,
      nos_of_words: nos_of_words || ''
    });
    console.log(`✅ Master basic_prompt built (${basicPrompt.length} chars)`);

    // 5) Start conversation with master prompt - generates Intro + TOC
    let conversation: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant. Please respond in ' + content_lang },
      { role: 'user', content: basicPrompt }
    ];

    const introResponse = await this.chatOnce(apiKey, model, conversation);
    console.log(`✅ Introduction and TOC generated`);
    conversation.push({ role: 'assistant', content: introResponse });

    // 6) Generate content sections with continuation prompts
    // These are SHORT prompts because they reference the master context
    const sectionConfig = this.getSectionConfig(wordCountVariant);
    const sectionResponses: string[] = [];

    for (let i = 1; i <= sectionConfig.sectionCount; i++) {
      const sectionPrompt = await this.getSectionContinuationPrompt(i, sectionConfig);
      conversation.push({ role: 'user', content: sectionPrompt });

      const sectionResponse = await this.chatOnce(apiKey, model, conversation);
      sectionResponses.push(this.wrapSection(sectionResponse));
      conversation.push({ role: 'assistant', content: sectionResponse });
      console.log(`✅ Section ${i}/${sectionConfig.sectionCount} generated`);
    }

    // 7) Generate conclusion using continuation prompt
    const conclusionPrompt = await this.getConclusionContinuationPrompt(sectionConfig);
    conversation.push({ role: 'user', content: conclusionPrompt });
    const conclusionResp = await this.chatOnce(apiKey, model, conversation);
    conversation.push({ role: 'assistant', content: conclusionResp });
    console.log(`✅ Conclusion generated`);

    // 8) Generate FAQs using continuation prompt
    const faqsPrompt = await this.getFAQsContinuationPrompt(sectionConfig);
    conversation.push({ role: 'user', content: faqsPrompt });
    const faqsResp = await this.chatOnce(apiKey, model, conversation);
    conversation.push({ role: 'assistant', content: faqsResp });
    console.log(`✅ FAQs generated`);

    // 9) Generate What's Next using continuation prompt
    const whatsNextPrompt = await this.getWhatsNextContinuationPrompt(sectionConfig);
    conversation.push({ role: 'user', content: whatsNextPrompt });
    const whatsNextResp = await this.chatOnce(apiKey, model, conversation);
    console.log(`✅ What's Next generated`);

    // 10) Assemble HTML content
    let contentFinal = this.assembleContent({
      introResponse,
      sectionResponses,
      conclusionResp,
      faqsResp,
      whatsNextResp
    });
    console.log(`✅ Content assembled`);

    // 11) Post-process content
    contentFinal = this.postProcessContent(contentFinal);
    console.log(`✅ Content post-processed`);

    // 12) Generate meta data using dynamic prompts
    const metaTitle = await this.generateMetaTitle(apiKey, model, title || seed_keyword, seed_keyword);
    const metaDescription = await this.generateMetaDescription(apiKey, model, title || seed_keyword, seed_keyword, contentFinal);
    console.log(`✅ Meta data generated`);

    return {
      search_data: title && title.trim() ? title : seed_keyword,
      content: contentFinal,
      meta_title: metaTitle,
      meta_descreption: metaDescription
    };
  }

  private async getPromptOrFallback(templateName: string, wordCountVariant: string, fallback: string): Promise<string> {
    try {
      return await this.promptService.getPrompt(templateName);
    } catch (error) {
      console.warn(`Prompt '${templateName}' not found, using fallback`);
      return fallback;
    }
  }

  private getWordCountVariant(nos_of_words: string): string {
    if (nos_of_words === '600 to 1200 words') return 'small';
    if (nos_of_words === '2400 to 3600 words') return 'large';
    return 'medium';
  }

  private getSectionConfig(variant: string) {
    const configs = {
      small: { 
        sectionCount: 4, 
        sectionWordMin: 200, 
        sectionWordMax: 250,
        conclusionMin: 100,
        conclusionMax: 150,
        faqsMin: 100,
        faqsMax: 150,
        whatsMin: 100,
        whatsMax: 150
      },
      medium: { 
        sectionCount: 4, 
        sectionWordMin: 350, 
        sectionWordMax: 400,
        conclusionMin: 150,
        conclusionMax: 200,
        faqsMin: 100,
        faqsMax: 150,
        whatsMin: 150,
        whatsMax: 200
      },
      large: { 
        sectionCount: 5, 
        sectionWordMin: 450, 
        sectionWordMax: 600,
        conclusionMin: 150,
        conclusionMax: 200,
        faqsMin: 100,
        faqsMax: 150,
        whatsMin: 150,
        whatsMax: 200
      }
    };
    return configs[variant as keyof typeof configs] || configs.medium;
  }

  private ordinal(n: number): string {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  private wrapSection(html: string): string {
    return html;
  }

  private assembleContent(sections: {
    introResponse: string;
    sectionResponses: string[];
    conclusionResp: string;
    faqsResp: string;
    whatsNextResp: string;
  }): string {
    const { introResponse, sectionResponses, conclusionResp, faqsResp, whatsNextResp } = sections;
    
    return '<div class="main-content-section-improveseo">' +
      introResponse +
      sectionResponses.map(s => `<div style="margin-bottom: 15px;margin-top: 50px;">${s}</div>`).join('') +
      `<div style="margin-bottom: 15px;margin-top: 50px;">${conclusionResp}</div>` +
      `<div style="margin-bottom: 15px;margin-top: 50px;">${faqsResp}</div>` +
      `<div style="margin-bottom: 15px;margin-top: 50px;">${whatsNextResp}</div>` +
      '</div>';
  }

  private postProcessContent(content: string): string {
    // Convert Markdown to HTML first (in case AI returns Markdown)
    content = this.convertMarkdownToHTML(content);
    
    // Apply all the post-processing from the original function
    content = this.stripParenthesesWrappingContactTokens(content);
    content = this.convert_emails_to_links(content);
    content = this.convert_urls_to_links(content);
    content = this.stripParenthesesAroundAnchorTags(content);

    // Light HTML entity/nbsp cleanup
    content = content.replace(/&nbsp;/g, '').replace(/<p>&nbsp;<\/p>/g, '').replace(/<p>\s<\/p>/g, '').replace(/<p><\/p>/g, '');

    // Remove boilerplate headings if present
    content = this.replace_content(content, '<h2>Main Content Sections</h2>');
    content = this.replace_content(content, '<p>—</p>');

    content = this.removePTags(content);
    content = this.removeConsecutiveSpecialCharacters(content);

    // Ensure TOC anchors match headings
    content = this.verifyAndFixTOCLinks(content);

    // Optional smooth scroll style (properly formatted, without padding for bulk posts)
    

    return content;
  }

  private async generateAudienceData(apiKey: string, model: string, seed_keyword: string, content_lang: string): Promise<string> {
    const prompt = `Assume someone enters the keyword ${seed_keyword} into a search engine. Analyze the following characteristics: 1. [demographic information] 2. [tone preferences] 3. [reading level preference] 4. [emotional needs/pain points]. This information will be used to create content that is specifically appealing to such people. Do not give content recommendations yet. As an output, write just information for characteristics without any explanation or introduction.`;
    return await this.chatOnce(apiKey, model, [
      { role: 'system', content: 'You are a helpful assistant. Please respond in ' + content_lang },
      { role: 'user', content: prompt }
    ]);
  }

  private async generateMetaTitle(apiKey: string, model: string, aigeneratedtitle: string, seed_keyword: string): Promise<string> {
    try {
      const metaTitlePrompt = await this.promptService.getPrompt('meta_title');
      const processedPrompt = this.promptService.processPromptVariables(metaTitlePrompt, {
        title: aigeneratedtitle,
        seed_keyword
      });
      return await this.chatOnce(apiKey, model, [{ role: 'user', content: processedPrompt }]);
    } catch (error) {
      // Fallback to original meta title generation
      const q = `Create an SEO optimized meta title based on the blog post title \`${aigeneratedtitle}\` and the keyword \`${seed_keyword}\`. max length of title should be 50-60 characters including spaces.`;
      return await this.chatOnce(apiKey, model, [{ role: 'user', content: q }]);
    }
  }

  private async generateMetaDescription(apiKey: string, model: string, aigeneratedtitle: string, seed_keyword: string, content: string): Promise<string> {
    try {
      const metaDescPrompt = await this.promptService.getPrompt('meta_description');
      const processedPrompt = this.promptService.processPromptVariables(metaDescPrompt, {
        title: aigeneratedtitle,
        seed_keyword,
        content
      });
      return await this.chatOnce(apiKey, model, [{ role: 'user', content: processedPrompt }]);
    } catch (error) {
      // Fallback to original meta description generation
      const q = `Create an SEO optimized meta description. max length of description should be 70-80 characters including spaces. Meta description is based on the blog post title \`${aigeneratedtitle}\`, the keyword \`${seed_keyword}\` and the blog post content i.e. ${content}.`;
      return await this.chatOnce(apiKey, model, [{ role: 'user', content: q }]);
    }
  }

  /**
   * Fetch active prompts for all 12 fixed templates from database
   */
  private async fetchActivePrompts(testVersionOverride?: VersionTestOverride): Promise<{
    prompts: DynamicPromptData;
    versions: Record<string, string>;
    templates: string[];
  }> {
    try {
      const templates = await this.promptService.getAllTemplates();
      const prompts: DynamicPromptData = {};
      const versions: Record<string, string> = {};
      const templatesUsed: string[] = [];

      // Fixed template names that map to our templates
      const templateMap = {
        'audience_generation': 'audience_generation',
        'lsi_keywords': 'lsi_keywords', 
        'facts_generation': 'facts_generation',
        'basic_prompt_small': 'basic_prompt_small',
        'basic_prompt_medium': 'basic_prompt_medium',
        'basic_prompt_large': 'basic_prompt_large',
        'section_continuation': 'section_continuation',
        'conclusion_continuation': 'conclusion_continuation',
        'faqs_continuation': 'faqs_continuation',
        'whats_next_continuation': 'whats_next_continuation',
        'meta_title': 'meta_title',
        'meta_description': 'meta_description'
      };

      for (const template of templates) {
        const mappedName = templateMap[template.name as keyof typeof templateMap];
        if (mappedName) {
          let versionToUse;
          
          // Check if this template should use a test version override
          if (testVersionOverride && template.name === testVersionOverride.promptType) {
            console.log(`🧪 Using test version ${testVersionOverride.versionId} for ${template.name}`);
            versionToUse = await this.promptService.getVersionById(testVersionOverride.versionId);
          } else {
            // Use active version as normal
            versionToUse = await this.promptService.getActiveVersion(template._id.toString());
          }
          
          if (versionToUse) {
            prompts[mappedName as keyof DynamicPromptData] = versionToUse.prompt;
            versions[mappedName] = testVersionOverride && template.name === testVersionOverride.promptType 
              ? `v${versionToUse.version} (TEST)` 
              : `v${versionToUse.version}`;
            templatesUsed.push(template.name);
          }
        }
      }

      return { prompts, versions, templates: templatesUsed };
    } catch (error) {
      console.error('Failed to fetch active prompts:', error);
      // Return empty prompts if database fetch fails
      return { prompts: {}, versions: {}, templates: [] };
    }
  }

  /**
   * Replace variables in prompts with actual values
   */
  private populatePromptVariables(prompts: DynamicPromptData, variables: Record<string, string>): DynamicPromptData {
    const populated: DynamicPromptData = {};

    for (const [key, prompt] of Object.entries(prompts)) {
      if (prompt) {
        let populatedPrompt = prompt;
        
        // Replace all {{variable}} patterns with actual values
        for (const [variable, value] of Object.entries(variables)) {
          const regex = new RegExp(`\\{\\{${variable}\\}\\}`, 'g');
          populatedPrompt = populatedPrompt.replace(regex, value || '');
        }
        
        populated[key as keyof DynamicPromptData] = populatedPrompt;
      }
    }

    return populated;
  }

  /**
   * Generate audience data if needed using custom prompts
   */
  private async generateAudienceIfNeeded(prompts: DynamicPromptData, params: GeneratePostParams): Promise<string | undefined> {
    if (prompts.audience_generation && params.seed_keyword) {
      try {
        const apiKey = params.apiKey || process.env.OPENAI_API_KEY;
        if (!apiKey) return undefined;

        return await this.chatOnce(apiKey, 'gpt-4o', [
          { role: 'system', content: `You are a helpful assistant. Please respond in ${params.content_lang || 'en'}` },
          { role: 'user', content: prompts.audience_generation }
        ]);
      } catch (error) {
        console.error('Failed to generate audience with custom prompt:', error);
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Enhance result with custom meta generation
   */
  private async enhanceWithCustomMeta(
    result: GeneratePostResult, 
    prompts: DynamicPromptData, 
    params: GeneratePostParams
  ): Promise<GeneratePostResult> {
    const apiKey = params.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) return result;

    const enhanced = { ...result };

    // Enhance meta title with custom prompt
    if (prompts.meta_title) {
      try {
        const customTitle = await this.chatOnce(apiKey, 'gpt-4o', [
          { role: 'system', content: `You are a helpful assistant. Please respond in ${params.content_lang || 'en'}` },
          { role: 'user', content: prompts.meta_title }
        ]);
        if (customTitle.trim()) {
          enhanced.meta_title = customTitle;
        }
      } catch (error) {
        console.error('Failed to generate custom meta title:', error);
      }
    }

    // Enhance meta description with custom prompt
    if (prompts.meta_description) {
      try {
        const customDescription = await this.chatOnce(apiKey, 'gpt-4o', [
          { role: 'system', content: `You are a helpful assistant. Please respond in ${params.content_lang || 'en'}` },
          { role: 'user', content: prompts.meta_description }
        ]);
        if (customDescription.trim()) {
          enhanced.meta_descreption = customDescription;
        }
      } catch (error) {
        console.error('Failed to generate custom meta description:', error);
      }
    }

    return enhanced;
  }

  private async chatOnce(apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages })
    });
    
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI error ${res.status}: ${text}`);
    }
    
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').replace(/^['"]|['"]$/g, '');
  }

  // Helper methods (copied from original implementation)
  private replace_content(content: string, remove: string): string {
    const esc = remove.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return content.replace(new RegExp(esc, 'g'), '');
  }

  private removePTags(html: string): string {
    html = html.replace(/<p>(\s|&nbsp;)*<\/p>/g, '');
    html = html.replace(/\n/g, '<br>');
    html = html.replace(/<h2>Table of Contents<\/h2>/g, '<h2 style="margin-top: 35px;">Table of Contents</h2>');
    html = html.replace(/\[[^\]]*\]/g, '');
    return html;
  }

  private convert_emails_to_links(content: string): string {
    return content.replace(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g, '<a href="mailto:$1">$1</a>');
  }

  private convert_urls_to_links(content: string): string {
    // First, protect existing anchor tags by temporarily replacing them
    const anchors: string[] = [];
    content = content.replace(/(<a\b[^>]*>.*?<\/a>)/gi, (match) => {
      anchors.push(match);
      return `__ANCHOR_${anchors.length - 1}__`;
    });

    // Now convert standalone URLs (not inside href attributes)
    content = content.replace(
      /(?<!href="|href='|src="|src=')\b(https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[\/\w.~:?#[\]@!$&'()*+,;=%-]*|www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[\/\w.~:?#[\]@!$&'()*+,;=%-]*)\b/g,
      (match) => {
        const href = /^https?:\/\//.test(match) ? match : `http://${match}`;
        return `<a href="${href}" target="_blank" rel="noopener">${match}</a>`;
      }
    );

    // Restore the protected anchors
    content = content.replace(/__ANCHOR_(\d+)__/g, (match, index) => {
      return anchors[parseInt(index)];
    });

    return content;
  }

  private convertMarkdownToHTML(content: string): string {
    // FIRST: Convert **bold** and *italic* BEFORE heading conversion
    // Use [^*]+ to avoid nested asterisks and gs flag for multiline
    content = content.replace(/\*\*([^*]+?)\*\*/gs, '<strong>$1</strong>');
    content = content.replace(/\*([^*\s][^*]*?)\*/g, '<em>$1</em>');
    
    // Convert Markdown headings to HTML with IDs (from h6 to h1)
    content = content.replace(/^#{6}\s+(.+)$/gm, (match, text) => {
      const cleanText = text.trim().replace(/<\/?strong>/g, '').replace(/<\/?em>/g, '');
      const id = cleanText.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
      return `<h6 id="${id}">${text.trim()}</h6>`;
    });
    content = content.replace(/^#{5}\s+(.+)$/gm, (match, text) => {
      const cleanText = text.trim().replace(/<\/?strong>/g, '').replace(/<\/?em>/g, '');
      const id = cleanText.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
      return `<h5 id="${id}">${text.trim()}</h5>`;
    });
    content = content.replace(/^#{4}\s+(.+)$/gm, (match, text) => {
      const cleanText = text.trim().replace(/<\/?strong>/g, '').replace(/<\/?em>/g, '');
      const id = cleanText.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
      return `<h4 id="${id}">${text.trim()}</h4>`;
    });
    content = content.replace(/^#{3}\s+(.+)$/gm, (match, text) => {
      const cleanText = text.trim().replace(/<\/?strong>/g, '').replace(/<\/?em>/g, '');
      const id = cleanText.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
      return `<h3 id="${id}">${text.trim()}</h3>`;
    });
    content = content.replace(/^#{2}\s+(.+)$/gm, (match, text) => {
      const cleanText = text.trim().replace(/<\/?strong>/g, '').replace(/<\/?em>/g, '');
      const id = cleanText.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
      return `<h2 id="${id}">${text.trim()}</h2>`;
    });
    content = content.replace(/^#\s+(.+)$/gm, (match, text) => {
      const cleanText = text.trim().replace(/<\/?strong>/g, '').replace(/<\/?em>/g, '');
      const id = cleanText.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
      return `<h1 id="${id}">${text.trim()}</h1>`;
    });
    
    // Convert --- horizontal rules
    content = content.replace(/^---+$/gm, '<hr>');
    
    return content;
  }

  private stripParenthesesWrappingContactTokens(content: string): string {
    // Remove parentheses around URLs (preserving the full URL including trailing slashes)
    content = content.replace(/\(\s*((?:https?:\/\/|www\.)[^\s)]+)\s*\)/gi, '$1');
    // Remove parentheses around emails
    content = content.replace(/\(\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,})\s*\)/g, '$1');
    return content;
  }

  private stripParenthesesAroundAnchorTags(content: string): string {
    return content.replace(/\(\s*(<a\b[^>]*>.*?<\/a>)\s*\)/gi, '$1');
  }

  private removeConsecutiveSpecialCharacters(content: string): string {
    // Split content into tags and text nodes
    const parts = content.split(/(<[^>]+>)/g);
    
    for (let i = 0; i < parts.length; i++) {
      // Skip HTML tags
      if (parts[i] && parts[i][0] === '<') {
        continue;
      }
      // Within text nodes, remove any run of 2+ non-alphanumeric, non-space characters
      // This preserves single occurrences but strips sequences (e.g., ### -> '', ** -> '')
      // Using Unicode-aware pattern to match PHP's \p{L} (letters) and \p{N} (numbers)
      parts[i] = parts[i].replace(/[^\p{L}\p{N}\s]{2,}/gu, '');
    }
    
    return parts.join('');
  }

  private verifyAndFixTOCLinks(content: string): string {
    // Parse the content to extract TOC links and headings
    const tocLinks: Record<string, string> = {};
    const headings: Record<string, string> = {};
    
    // Extract TOC links using regex
    const tocRe = /<a href="#([^"]+)">([^<]+)<\/a>/gi;
    let tocMatch: RegExpExecArray | null;
    while ((tocMatch = tocRe.exec(content)) !== null) {
      tocLinks[tocMatch[1]] = tocMatch[2].trim();
    }
    
    // Extract headings with IDs using regex
    const headingRe = /<h([2-6])(?:\s+id="([^"]+)")?>([^<]+)<\/h[2-6]>/gi;
    let headingMatch: RegExpExecArray | null;
    while ((headingMatch = headingRe.exec(content)) !== null) {
      if (headingMatch[2]) {
        headings[headingMatch[2]] = headingMatch[3].trim();
      }
    }
    
    // Check for missing IDs and fix them
    let updated = content;
    
    for (const [anchor, title] of Object.entries(tocLinks)) {
      if (!headings[anchor]) {
        // Find the heading with matching title and add ID
        const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const headingPattern = new RegExp(`<h([2-6])(?:\\s+[^>]*)?>\\s*(${escapedTitle})\\s*<\\/h[2-6]>`, 'i');
        updated = updated.replace(headingPattern, (match, level, text) => {
          return `<h${level} id="${anchor}">${text}</h${level}>`;
        });
      }
    }
    
    // Generate missing TOC links for headings without them (for debugging)
    for (const [id, title] of Object.entries(headings)) {
      if (!tocLinks[id]) {
        console.log(`Missing TOC link for heading: ${title} (ID: ${id})`);
      }
    }
    
    return updated;
  }

  private generateAnchorId(text: string): string {
    let id = (text || '').toLowerCase();
    id = id.replace(/<[^>]+>/g, '');
    id = id.replace(/[^a-z0-9\s-]/g, '');
    id = id.replace(/[\s-]+/g, '-');
    id = id.replace(/^-+|-+$/g, '');
    return id || 'section';
  }

  /**
   * Get the original comprehensive basic_prompt (MASTER PROMPT)
   * This contains ALL the instructions like the PHP implementation
   */
  private getOriginalBasicPrompt(params: BasicPromptParams): string {
    const { wordCountVariant } = params;
    
    if (wordCountVariant === 'small') {
      return OriginalPromptsHelper.getBasicPromptSmall(params);
    } else if (wordCountVariant === 'large') {
      return OriginalPromptsHelper.getBasicPromptLarge(params);
    } else {
      return OriginalPromptsHelper.getBasicPromptMedium(params);
    }
  }

  /**
   * Build the MASTER basic_prompt that contains ALL comprehensive instructions
   * Tries database first, falls back to original PHP prompts
   */
  private async buildBasicPrompt(params: BasicPromptParams): Promise<string> {
    const { wordCountVariant } = params;
    const templateName = `basic_prompt_${wordCountVariant}`;
    
    try {
      // Try to fetch custom prompt from database
      const customPrompt = await this.promptService.getPrompt(templateName);
      console.log(`✅ Using custom prompt template: ${templateName}`);
      
      // Populate variables in custom prompt
      return this.promptService.processPromptVariables(customPrompt, {
        seed_keyword: params.seed_keyword,
        title: params.title,
        lsi_keywords: params.lsiKeywords,
        voice_tone: params.voice_tone,
        point_of_view: params.point_of_view,
        audience_data: params.audience,
        details_to_include: params.details_to_include,
        content_lang: params.content_lang,
        call_to_action: params.call_to_action,
        facts_to_include: params.facts,
        nos_of_words: params.nos_of_words
      });
    } catch (error) {
      // Fallback to original hardcoded comprehensive prompt
      console.log(`⚠️  Custom prompt '${templateName}' not found, using original PHP prompt`);
      return this.getOriginalBasicPrompt(params);
    }
  }

  /**
   * Generate LSI keywords with tunable prompt
   */
  private async generateLSIKeywords(
    apiKey: string,
    model: string,
    seed_keyword: string,
    audience: string,
    content_lang: string
  ): Promise<string> {
    try {
      const lsiPrompt = await this.promptService.getPrompt('lsi_keywords');
      const processed = this.promptService.processPromptVariables(lsiPrompt, {
        seed_keyword,
        audience_data: audience
      });
      return await this.chatOnce(apiKey, model, [
        { role: 'system', content: 'You are a helpful assistant. Please respond in ' + content_lang },
        { role: 'user', content: processed }
      ]);
    } catch (error) {
      // Fallback to original LSI prompt
      const fallbackPrompt = `As an expert SEO manager, you are tasked with generating 50 Latent Semantic Indexing (LSI) keywords. You are provided a word or phrase that is searched by the reader, and the audience data of the reader, including demographic information, tone preferences, reading level preference and emotional needs/pain points. Using this information you should come up with the LSI keywords that will be engaging and interesting for the reader who is described in the audience data and search provided word or phrase. These keywords should be closely related to the provided main keyword, enhancing content relevance and SEO effectiveness. Please compile the keywords in a comma separated text format without any additional explanations or introductions.\n\nMain keyword: ${seed_keyword}\n\nAudience data: {${audience}}`;
      return await this.chatOnce(apiKey, model, [
        { role: 'system', content: 'You are a helpful assistant. Please respond in ' + content_lang },
        { role: 'user', content: fallbackPrompt }
      ]);
    }
  }

  /**
   * Generate facts with tunable prompt
   */
  private async generateFacts(
    apiKey: string,
    model: string,
    seed_keyword: string,
    audience: string,
    content_lang: string
  ): Promise<string> {
    try {
      const factsPrompt = await this.promptService.getPrompt('facts_generation');
      const processed = this.promptService.processPromptVariables(factsPrompt, {
        seed_keyword,
        audience_data: audience
      });
      return await this.chatOnce(apiKey, model, [
        { role: 'system', content: 'You are a helpful assistant. Please respond in ' + content_lang },
        { role: 'user', content: processed }
      ]);
    } catch (error) {
      // Fallback to original facts prompt
      const fallbackPrompt = `Generate 5 most interesting and fun facts with specific details about the "Main keyword" for the audience described in the audience data provided below. Each fact should be one short sentence. As an output, write just a bullet point list of facts without explanation or introduction.\n\nNow generate facts.\n\nMain Keyword: ${seed_keyword}\n\nAudience data: {${audience}}`;
      return await this.chatOnce(apiKey, model, [
        { role: 'system', content: 'You are a helpful assistant. Please respond in ' + content_lang },
        { role: 'user', content: fallbackPrompt }
      ]);
    }
  }

  /**
   * Get section continuation prompt - SHORT because it references master context
   */
  private async getSectionContinuationPrompt(
    sectionNumber: number,
    config: ReturnType<typeof this.getSectionConfig>
  ): Promise<string> {
    try {
      const prompt = await this.promptService.getPrompt('section_continuation');
      return this.promptService.processPromptVariables(prompt, {
        section_number: sectionNumber.toString(),
        ordinal: this.ordinal(sectionNumber),
        min_words: config.sectionWordMin.toString(),
        max_words: config.sectionWordMax.toString()
      });
    } catch (error) {
      // Fallback to original continuation format
      return `Now generate the ${this.ordinal(sectionNumber)} subtitle content. IMPORTANT: Output should not be more than ${config.sectionWordMin}-${config.sectionWordMax} words. After writing an output check the word count and regenerate if it is not in the range. Do not include the word count in the output.`;
    }
  }

  /**
   * Get conclusion continuation prompt
   */
  private async getConclusionContinuationPrompt(
    config: ReturnType<typeof this.getSectionConfig>
  ): Promise<string> {
    try {
      const prompt = await this.promptService.getPrompt('conclusion_continuation');
      return this.promptService.processPromptVariables(prompt, {
        min_words: config.conclusionMin.toString(),
        max_words: config.conclusionMax.toString()
      });
    } catch (error) {
      return `Now generate the conclusion content. IMPORTANT: Output should not be more than ${config.conclusionMin}-${config.conclusionMax} words. After writing an output check the word count and regenerate if it is not in the range. Do not include the word count in the output.`;
    }
  }

  /**
   * Get FAQs continuation prompt
   */
  private async getFAQsContinuationPrompt(
    config: ReturnType<typeof this.getSectionConfig>
  ): Promise<string> {
    try {
      const prompt = await this.promptService.getPrompt('faqs_continuation');
      return this.promptService.processPromptVariables(prompt, {
        min_words: config.faqsMin.toString(),
        max_words: config.faqsMax.toString()
      });
    } catch (error) {
      return `Now generate the FAQs content. IMPORTANT: Output should not be more than ${config.faqsMin}-${config.faqsMax} words. After writing an output check the word count and regenerate if it is not in the range. Do not include the word count in the output.`;
    }
  }

  /**
   * Get What's Next continuation prompt
   */
  private async getWhatsNextContinuationPrompt(
    config: ReturnType<typeof this.getSectionConfig>
  ): Promise<string> {
    try {
      const prompt = await this.promptService.getPrompt('whats_next_continuation');
      return this.promptService.processPromptVariables(prompt, {
        min_words: config.whatsMin.toString(),
        max_words: config.whatsMax.toString()
      });
    } catch (error) {
      return `Now generate What is next? content. IMPORTANT: Output should not be more than ${config.whatsMin}-${config.whatsMax} words. After writing an output check the word count and regenerate if it is not in the range. Do not include the word count in the output.`;
    }
  }
}