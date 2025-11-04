import { PromptManagementService } from './prompt-management.service.js';
import { GeneratePostParams, GeneratePostResult, ChatMessage, generateAiHtmlPost2 } from './ai_content_admin_tuneable.js';

interface DynamicPromptData {
  audience_generation?: string;
  lsi_keywords?: string;
  facts_generation?: string;
  format_small?: string;
  format_medium?: string;
  format_large?: string;
  section_content?: string;
  conclusion?: string;
  faqs?: string;
  whats_next?: string;
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

    // 1) Ensure audience data (replicates getAudienceData() if not provided)
    const audience = audienceData || await this.generateAudienceData(apiKey, model, seed_keyword, content_lang);

    // 2) LSI keywords using dynamic prompt  
    const formatVariant = wordCountVariant === 'small' ? 'format_small' : 
                         wordCountVariant === 'large' ? 'format_large' : 'format_medium';
    const lsiPrompt = await this.promptService.getPrompt('lsi_keywords');
    const lsiPromptProcessed = this.promptService.processPromptVariables(lsiPrompt, {
      seed_keyword,
      audience_data: audience
    });
    const lsiKeywords = await this.chatOnce(apiKey, model, [
      { role: 'system', content: 'You are a helpful assistant. Please respond in ' + content_lang },
      { role: 'user', content: lsiPromptProcessed }
    ]);

    // 3) Facts generation using dynamic prompt
    const factsPrompt = await this.promptService.getPrompt('facts_generation');
    const factsPromptProcessed = this.promptService.processPromptVariables(factsPrompt, {
      seed_keyword,
      audience_data: audience
    });
    const facts = await this.chatOnce(apiKey, model, [
      { role: 'system', content: 'You are a helpful assistant. Please respond in ' + content_lang },
      { role: 'user', content: factsPromptProcessed }
    ]);

    // 4) Introduction and TOC using dynamic prompt
    const introPrompt = await this.promptService.getPrompt(formatVariant);
    const introPromptProcessed = this.promptService.processPromptVariables(introPrompt, {
      nos_of_words: nos_of_words || '',
      seed_keyword,
      title: title || '',
      lsi_keywords: lsiKeywords,
      voice_tone: voice_tone || '',
      point_of_view: point_of_view || '',
      audience_data: audience,
      details_to_include: details_to_include || '',
      content_lang: content_lang || '',
      call_to_action: call_to_action || '',
      facts_to_include: facts
    });

    let conversation: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant. Please respond in ' + content_lang },
      { role: 'user', content: introPromptProcessed }
    ];

    const introResponse = await this.chatOnce(apiKey, model, conversation);
    conversation.push({ role: 'assistant', content: introResponse });

    // 5) Generate content sections dynamically
    const sectionConfig = this.getSectionConfig(wordCountVariant);
    const sectionResponses: string[] = [];

    for (let i = 1; i <= sectionConfig.sectionCount; i++) {
      try {
        // Use section content prompt for all sections
        const sectionPrompt = await this.promptService.getPrompt('section_content');
        const sectionPromptProcessed = this.promptService.processPromptVariables(sectionPrompt, {
          section_number: i.toString(),
          min_words: sectionConfig.sectionWordMin.toString(),
          max_words: sectionConfig.sectionWordMax.toString(),
          ordinal: this.ordinal(i)
        });
        conversation.push({ role: 'user', content: sectionPromptProcessed });
      } catch (error) {
        // Fallback to generic section prompt
        const genericPrompt = `Now generate the ${this.ordinal(i)} subtitle content. IMPORTANT: Output should not be more than ${sectionConfig.sectionWordMin}-${sectionConfig.sectionWordMax} words. After writing an output check the word count and regenerate if it is not in the range. Do not include the word count in the output.`;
        conversation.push({ role: 'user', content: genericPrompt });
      }

      const sectionResponse = await this.chatOnce(apiKey, model, conversation);
      sectionResponses.push(this.wrapSection(sectionResponse));
      conversation.push({ role: 'assistant', content: sectionResponse });
    }

    // 6) Generate conclusion using dynamic prompt
    const conclusionPrompt = await this.getPromptOrFallback(
      'conclusion',
      wordCountVariant,
      `Now generate the conclusion content. IMPORTANT: Output should not be more than ${sectionConfig.conclusionMin}-${sectionConfig.conclusionMax} words. After writing an output check the word count and regenerate if it is not in the range. Do not include the word count in the output.`
    );
    conversation.push({ role: 'user', content: conclusionPrompt });
    const conclusionResp = await this.chatOnce(apiKey, model, conversation);
    conversation.push({ role: 'assistant', content: conclusionResp });

    // 7) Generate FAQs using dynamic prompt
    const faqsPrompt = await this.getPromptOrFallback(
      'faqs',
      wordCountVariant,
      `Now generate the FAQs content. IMPORTANT: Output should not be more than ${sectionConfig.faqsMin}-${sectionConfig.faqsMax} words. After writing an output check the word count and regenerate if it is not in the range. Do not include the word count in the output.`
    );
    conversation.push({ role: 'user', content: faqsPrompt });
    const faqsResp = await this.chatOnce(apiKey, model, conversation);
    conversation.push({ role: 'assistant', content: faqsResp });

    // 8) Generate What's Next using dynamic prompt
    const whatsNextPrompt = await this.getPromptOrFallback(
      'whats_next',
      wordCountVariant,
      `Now generate What is next? content. IMPORTANT: Output should not be more than ${sectionConfig.whatsMin}-${sectionConfig.whatsMax} words. After writing an output check the word count and regenerate if it is not in the range. Do not include the word count in the output.`
    );
    conversation.push({ role: 'user', content: whatsNextPrompt });
    const whatsNextResp = await this.chatOnce(apiKey, model, conversation);

    // 9) Assemble HTML content
    let contentFinal = this.assembleContent({
      introResponse,
      sectionResponses,
      conclusionResp,
      faqsResp,
      whatsNextResp
    });

    // 10) Post-process content
    contentFinal = this.postProcessContent(contentFinal);

    // 11) Generate meta data using dynamic prompts
    const metaTitle = await this.generateMetaTitle(apiKey, model, title || seed_keyword, seed_keyword);
    const metaDescription = await this.generateMetaDescription(apiKey, model, title || seed_keyword, seed_keyword, contentFinal);

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
    content += '\n<style>\nhtml { scroll-behavior: smooth; }\n</style>';

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

      // Fixed template names that map to our 12 templates
      const templateMap = {
        'audience_generation': 'audience_generation',
        'lsi_keywords': 'lsi_keywords', 
        'facts_generation': 'facts_generation',
        'format_small': 'format_small',
        'format_medium': 'format_medium',
        'format_large': 'format_large',
        'section_content': 'section_content',
        'conclusion': 'conclusion',
        'faqs': 'faqs',
        'whats_next': 'whats_next',
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
    // Match URLs but skip those already inside anchor tags
    return content.replace(/(<a\b[^>]*>.*?<\/a>)|((https?:\/\/|www\.)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}([\/\w.~:?#[\]@!$&'()*+,;=%-]*)?)/g, (match, anchorTag, url) => {
      // If this is already an anchor tag, return it unchanged
      if (anchorTag) return anchorTag;
      
      // Determine the href (add http:// if missing)
      const href = /^https?:\/\//.test(url) ? url : `http://${url}`;
      
      // For display text, keep the original format (with https:// or www.)
      return `<a href="${href}" target="_blank" rel="noopener">${url}</a>`;
    });
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
}