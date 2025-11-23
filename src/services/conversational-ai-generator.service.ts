/**
 * Conversational AI Content Generator
 * 
 * This service implements the hybrid approach:
 * - Maintains the sequential conversational context from original PHP implementation
 * - Makes all prompts database-driven and tunable by prompt engineers
 * - Falls back to hardcoded prompts if database is unavailable
 * 
 * Key Design:
 * - Master prompts (basic_prompt_small/medium/large) contain ALL instructions
 * - Continuation prompts are SHORT and reference the master context
 * - Full conversation history maintained throughout generation
 */

import { PromptManagementService } from './prompt-management.service.js';
import { GeneratePostParams, GeneratePostResult, ChatMessage, generateAiHtmlPost2 } from './ai_content_admin_tuneable.js';
import { OriginalPromptsHelper, BasicPromptParams } from './original-prompts.helper.js';

// ==================== INTERFACES ====================

interface VersionTestOverride {
  promptType: string;    // e.g., 'section_continuation'
  versionId: string;     // MongoDB ObjectId as string
}

interface ConversationalGenerateParams extends GeneratePostParams {
  testVersionOverride?: VersionTestOverride; // For A/B testing
  enableTracing?: boolean; // Enable conversation trace logging
}

interface ConversationTrace {
  generationId: string;
  timestamp: Date;
  params: GeneratePostParams;
  stages: ConversationStage[];
  finalContent: string;
  metadata: {
    totalTokens: number;
    totalLatency: number;
    wordCount: number;
    promptsUsed: string[];
  };
}

interface ConversationStage {
  stageName: string;
  promptTemplateUsed: string;
  promptVersionUsed: number;
  promptText: string; // populated with variables
  aiResponse: string;
  tokensUsed?: number;
  latency: number;
}

interface SectionConfig {
  sectionCount: number;
  sectionWordMin: number;
  sectionWordMax: number;
  conclusionMin: number;
  conclusionMax: number;
  faqsMin: number;
  faqsMax: number;
  whatsMin: number;
  whatsMax: number;
}

// ==================== MAIN SERVICE ====================

export class ConversationalAIContentGenerator {
  private trace: ConversationTrace | null = null;

  constructor(
    private promptService: PromptManagementService,
    private enableFallback: boolean = true
  ) {}

  /**
   * Main entry point for conversational content generation
   * Preserves original PHP flow while using database-driven prompts
   */
  async generateContent(params: ConversationalGenerateParams): Promise<GeneratePostResult> {
    const startTime = Date.now();
    const generationId = this.generateId();

    // Initialize conversation trace if enabled
    if (params.enableTracing) {
      this.trace = {
        generationId,
        timestamp: new Date(),
        params,
        stages: [],
        finalContent: '',
        metadata: {
          totalTokens: 0,
          totalLatency: 0,
          wordCount: 0,
          promptsUsed: []
        }
      };
    }

    try {
      // Use database-driven conversational flow
      return await this.generateWithConversationalFlow(params);
    } catch (error) {
      if (this.enableFallback) {
        console.warn('❌ Conversational flow failed, falling back to original implementation:', error);
        // Fallback to original hardcoded implementation
        return await generateAiHtmlPost2(params);
      }
      throw error;
    } finally {
      if (this.trace) {
        this.trace.metadata.totalLatency = Date.now() - startTime;
        await this.saveTrace(this.trace);
      }
    }
  }

  /**
   * PHASE 1: Pre-Generation (Parallel, no dependencies)
   * Generate audience data, LSI keywords, and facts
   */
  private async preGeneration(params: ConversationalGenerateParams): Promise<{
    audience: string;
    lsi: string;
    facts: string;
  }> {
    const { apiKey = process.env.OPENAI_API_KEY, seed_keyword, content_lang = 'en' } = params;
    
    if (!apiKey) throw new Error('Missing OpenAI API key');

    const model = 'gpt-4o';
    const stageStartTime = Date.now();

    console.log('📋 Phase 1: Pre-Generation...');

    // 1. Audience Generation
    const audiencePrompt = await this.getPromptWithFallback(
      'audience_generation',
      params.testVersionOverride,
      `Assume someone enters the keyword ${seed_keyword} into a search engine. Analyze the following characteristics: 1. [demographic information] 2. [tone preferences] 3. [reading level preference] 4. [emotional needs/pain points]. This information will be used to create content that is specifically appealing to such people. Do not give content recommendations yet. As an output, write just information for characteristics without any explanation or introduction.`
    );
    
    const populatedAudiencePrompt = this.populateVariables(audiencePrompt, {
      seed_keyword,
      content_lang
    });

    const audience = await this.chatOnce(apiKey, model, [
      { role: 'system', content: `You are a helpful assistant. Please respond in ${content_lang}` },
      { role: 'user', content: populatedAudiencePrompt }
    ]);

    this.recordStage('audience_generation', audiencePrompt, audience, Date.now() - stageStartTime);
    console.log('✅ Audience data generated');

    // 2. LSI Keywords Generation
    const lsiStageStart = Date.now();
    const lsiPrompt = await this.getPromptWithFallback(
      'lsi_keywords',
      params.testVersionOverride,
      `As an expert SEO manager, you are tasked with generating 50 Latent Semantic Indexing (LSI) keywords. You are provided a word or phrase that is searched by the reader, and the audience data of the reader, including demographic information, tone preferences, reading level preference and emotional needs/pain points. Using this information you should come up with the LSI keywords that will be engaging and interesting for the reader who is described in the audience data and search provided word or phrase. These keywords should be closely related to the provided main keyword, enhancing content relevance and SEO effectiveness. Please compile the keywords in a comma separated text format without any additional explanations or introductions.\n\nMain keyword: {{seed_keyword}}\n\nAudience data: {{{audience_data}}}`
    );

    const populatedLsiPrompt = this.populateVariables(lsiPrompt, {
      seed_keyword,
      audience_data: audience
    });

    const lsi = await this.chatOnce(apiKey, model, [
      { role: 'system', content: `You are a helpful assistant. Please respond in ${content_lang}` },
      { role: 'user', content: populatedLsiPrompt }
    ]);

    this.recordStage('lsi_keywords', lsiPrompt, lsi, Date.now() - lsiStageStart);
    console.log('✅ LSI keywords generated');

    // 3. Facts Generation
    const factsStageStart = Date.now();
    const factsPrompt = await this.getPromptWithFallback(
      'facts_generation',
      params.testVersionOverride,
      `Generate 5 most interesting and fun facts with specific details about the "Main keyword" for the audience described in the audience data provided below. Each fact should be one short sentence. As an output, write just a bullet point list of facts without explanation or introduction.\n\nNow generate facts.\n\nMain Keyword: {{seed_keyword}}\n\nAudience data: {{{audience_data}}}`
    );

    const populatedFactsPrompt = this.populateVariables(factsPrompt, {
      seed_keyword,
      audience_data: audience
    });

    const facts = await this.chatOnce(apiKey, model, [
      { role: 'system', content: `You are a helpful assistant. Please respond in ${content_lang}` },
      { role: 'user', content: populatedFactsPrompt }
    ]);

    this.recordStage('facts_generation', factsPrompt, facts, Date.now() - factsStageStart);
    console.log('✅ Facts generated');

    return { audience, lsi, facts };
  }

  /**
   * PHASE 2: Master Context + Intro/TOC
   * Build comprehensive master prompt with ALL instructions
   */
  private async generateIntroAndTOC(
    params: ConversationalGenerateParams,
    preGenData: { audience: string; lsi: string; facts: string }
  ): Promise<{ introAndTOC: string; conversation: ChatMessage[] }> {
    const {
      apiKey = process.env.OPENAI_API_KEY,
      seed_keyword,
      title = '',
      voice_tone = '',
      point_of_view = '',
      details_to_include = '',
      call_to_action = '',
      nos_of_words = '1200 to 2400 words',
      content_lang = 'en'
    } = params;

    if (!apiKey) throw new Error('Missing OpenAI API key');

    const model = 'gpt-4o';
    const variant = this.getWordCountVariant(nos_of_words);
    const stageStartTime = Date.now();

    console.log('📝 Phase 2: Master Context + Intro/TOC...');

    // Build or fetch the MASTER prompt (contains ALL instructions)
    const masterPrompt = await this.buildMasterPrompt({
      wordCountVariant: variant,
      seed_keyword,
      title,
      lsiKeywords: preGenData.lsi,
      voice_tone,
      point_of_view,
      audience: preGenData.audience,
      details_to_include,
      content_lang,
      call_to_action,
      facts: preGenData.facts,
      nos_of_words
    }, params.testVersionOverride);

    console.log(`✅ Master prompt built (${masterPrompt.length} chars, variant: ${variant})`);

    // Start conversation with master prompt
    const conversation: ChatMessage[] = [
      { role: 'system', content: `You are a helpful assistant. Please respond in ${content_lang}` },
      { role: 'user', content: masterPrompt }
    ];

    const introAndTOC = await this.chatOnce(apiKey, model, conversation);
    conversation.push({ role: 'assistant', content: introAndTOC });

    this.recordStage(`master_context_${variant}`, masterPrompt, introAndTOC, Date.now() - stageStartTime);
    console.log('✅ Introduction and TOC generated');

    return { introAndTOC, conversation };
  }

  /**
   * PHASE 3: Sequential Section Generation (Context-aware)
   * Each section builds on previous responses
   */
  private async generateContentSections(
    params: ConversationalGenerateParams,
    conversation: ChatMessage[],
    sectionConfig: SectionConfig
  ): Promise<{ sectionResponses: string[]; conversation: ChatMessage[] }> {
    const { apiKey = process.env.OPENAI_API_KEY } = params;
    if (!apiKey) throw new Error('Missing OpenAI API key');

    const model = 'gpt-4o';
    const sectionResponses: string[] = [];

    console.log(`📄 Phase 3: Generating ${sectionConfig.sectionCount} sections...`);

    for (let i = 1; i <= sectionConfig.sectionCount; i++) {
      const stageStartTime = Date.now();
      
      // Get continuation prompt (SHORT - references master context)
      const sectionPrompt = await this.getSectionContinuationPrompt(
        i,
        sectionConfig,
        params.testVersionOverride
      );

      // Add to conversation (maintains full context)
      conversation.push({ role: 'user', content: sectionPrompt });

      const sectionContent = await this.chatOnce(apiKey, model, conversation);
      sectionResponses.push(sectionContent);

      // Store response in conversation
      conversation.push({ role: 'assistant', content: sectionContent });

      this.recordStage(`section_${i}`, sectionPrompt, sectionContent, Date.now() - stageStartTime);
      console.log(`✅ Section ${i}/${sectionConfig.sectionCount} generated`);
    }

    return { sectionResponses, conversation };
  }

  /**
   * PHASE 4: Finalization (Conclusion, FAQs, What's Next)
   */
  private async generateFinalizationSections(
    params: ConversationalGenerateParams,
    conversation: ChatMessage[],
    sectionConfig: SectionConfig
  ): Promise<{
    conclusion: string;
    faqs: string;
    whatsNext: string;
  }> {
    const { apiKey = process.env.OPENAI_API_KEY } = params;
    if (!apiKey) throw new Error('Missing OpenAI API key');

    const model = 'gpt-4o';

    console.log('🎯 Phase 4: Finalization (Conclusion, FAQs, What\'s Next)...');

    // Conclusion
    const conclusionStartTime = Date.now();
    const conclusionPrompt = await this.getConclusionContinuationPrompt(sectionConfig, params.testVersionOverride);
    conversation.push({ role: 'user', content: conclusionPrompt });
    const conclusion = await this.chatOnce(apiKey, model, conversation);
    conversation.push({ role: 'assistant', content: conclusion });
    this.recordStage('conclusion', conclusionPrompt, conclusion, Date.now() - conclusionStartTime);
    console.log('✅ Conclusion generated');

    // FAQs
    const faqsStartTime = Date.now();
    const faqsPrompt = await this.getFAQsContinuationPrompt(sectionConfig, params.testVersionOverride);
    conversation.push({ role: 'user', content: faqsPrompt });
    const faqs = await this.chatOnce(apiKey, model, conversation);
    conversation.push({ role: 'assistant', content: faqs });
    this.recordStage('faqs', faqsPrompt, faqs, Date.now() - faqsStartTime);
    console.log('✅ FAQs generated');

    // What's Next
    const whatsNextStartTime = Date.now();
    const whatsNextPrompt = await this.getWhatsNextContinuationPrompt(sectionConfig, params.testVersionOverride);
    conversation.push({ role: 'user', content: whatsNextPrompt });
    const whatsNext = await this.chatOnce(apiKey, model, conversation);
    this.recordStage('whats_next', whatsNextPrompt, whatsNext, Date.now() - whatsNextStartTime);
    console.log('✅ What\'s Next generated');

    return { conclusion, faqs, whatsNext };
  }

  /**
   * PHASE 5: Meta Generation (Independent)
   */
  private async generateMetaData(
    params: ConversationalGenerateParams,
    content: string
  ): Promise<{ metaTitle: string; metaDescription: string }> {
    const {
      apiKey = process.env.OPENAI_API_KEY,
      seed_keyword,
      title = '',
      content_lang = 'en'
    } = params;

    if (!apiKey) throw new Error('Missing OpenAI API key');

    const model = 'gpt-4o';

    console.log('🏷️  Phase 5: Meta Generation...');

    // Meta Title
    const metaTitleStartTime = Date.now();
    const metaTitlePrompt = await this.getPromptWithFallback(
      'meta_title',
      params.testVersionOverride,
      `Create an SEO optimized meta title based on the blog post title \`{{title}}\` and the keyword \`{{seed_keyword}}\`. max length of title should be 50-60 characters including spaces.`
    );

    const populatedMetaTitlePrompt = this.populateVariables(metaTitlePrompt, {
      title: title || seed_keyword,
      seed_keyword
    });

    const metaTitle = await this.chatOnce(apiKey, model, [
      { role: 'system', content: `You are a helpful assistant. Please respond in ${content_lang}` },
      { role: 'user', content: populatedMetaTitlePrompt }
    ]);
    this.recordStage('meta_title', metaTitlePrompt, metaTitle, Date.now() - metaTitleStartTime);
    console.log('✅ Meta title generated');

    // Meta Description
    const metaDescStartTime = Date.now();
    const metaDescPrompt = await this.getPromptWithFallback(
      'meta_description',
      params.testVersionOverride,
      `Create an SEO optimized meta description. max length of description should be 70-80 characters including spaces. Meta description is based on the blog post title \`{{title}}\`, the keyword \`{{seed_keyword}}\` and the blog post content i.e. {{content}}.`
    );

    const populatedMetaDescPrompt = this.populateVariables(metaDescPrompt, {
      title: title || seed_keyword,
      seed_keyword,
      content: content.substring(0, 500) // Limit content length
    });

    const metaDescription = await this.chatOnce(apiKey, model, [
      { role: 'system', content: `You are a helpful assistant. Please respond in ${content_lang}` },
      { role: 'user', content: populatedMetaDescPrompt }
    ]);
    this.recordStage('meta_description', metaDescPrompt, metaDescription, Date.now() - metaDescStartTime);
    console.log('✅ Meta description generated');

    return { metaTitle, metaDescription };
  }

  /**
   * Orchestrate the complete conversational generation flow
   */
  private async generateWithConversationalFlow(
    params: ConversationalGenerateParams
  ): Promise<GeneratePostResult> {
    // Phase 1: Pre-Generation
    const preGenData = await this.preGeneration(params);

    // Phase 2: Master Context + Intro/TOC
    const { introAndTOC, conversation } = await this.generateIntroAndTOC(params, preGenData);

    // Phase 3: Sequential Section Generation
    const variant = this.getWordCountVariant(params.nos_of_words || '1200 to 2400 words');
    const sectionConfig = this.getSectionConfig(variant);
    const { sectionResponses, conversation: updatedConversation } = await this.generateContentSections(
      params,
      conversation,
      sectionConfig
    );

    // Phase 4: Finalization
    const { conclusion, faqs, whatsNext } = await this.generateFinalizationSections(
      params,
      updatedConversation,
      sectionConfig
    );

    // Assemble content
    let contentFinal = this.assembleContent({
      introResponse: introAndTOC,
      sectionResponses,
      conclusionResp: conclusion,
      faqsResp: faqs,
      whatsNextResp: whatsNext
    });

    // Post-process content
    contentFinal = this.postProcessContent(contentFinal);

    // Phase 5: Meta Generation
    const { metaTitle, metaDescription } = await this.generateMetaData(params, contentFinal);

    // Store final content in trace
    if (this.trace) {
      this.trace.finalContent = contentFinal;
      this.trace.metadata.wordCount = this.countWords(contentFinal);
    }

    return {
      search_data: params.title && params.title.trim() ? params.title : params.seed_keyword,
      content: contentFinal,
      meta_title: metaTitle,
      meta_descreption: metaDescription
    };
  }

  // ==================== HELPER METHODS ====================

  /**
   * Get prompt from database with fallback to hardcoded version
   */
  private async getPromptWithFallback(
    templateName: string,
    testVersionOverride?: VersionTestOverride,
    fallback?: string
  ): Promise<string> {
    try {
      // Check for test version override
      if (testVersionOverride && testVersionOverride.promptType === templateName) {
        console.log(`🧪 Using test version for ${templateName}`);
        const testVersion = await this.promptService.getVersionById(testVersionOverride.versionId);
        if (testVersion) {
          return testVersion.prompt;
        }
      }

      // Try to get active version from database
      return await this.promptService.getPrompt(templateName);
    } catch (error) {
      if (fallback) {
        console.warn(`⚠️  Prompt '${templateName}' not found in database, using fallback`);
        return fallback;
      }
      throw new Error(`Prompt '${templateName}' not found and no fallback provided`);
    }
  }

  /**
   * Build the MASTER prompt that contains ALL comprehensive instructions
   */
  private async buildMasterPrompt(
    params: BasicPromptParams,
    testVersionOverride?: VersionTestOverride
  ): Promise<string> {
    const { wordCountVariant } = params;
    const templateName = `basic_prompt_${wordCountVariant}`;

    try {
      // Try to fetch from database
      const dbPrompt = await this.getPromptWithFallback(templateName, testVersionOverride);
      
      // Populate variables
      const populated = this.populateVariables(dbPrompt, {
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

      console.log(`✅ Using database prompt: ${templateName}`);
      return populated;
    } catch (error) {
      // Fallback to original PHP prompts
      console.log(`⚠️  Database prompt '${templateName}' not found, using original PHP prompt`);
      return this.getOriginalMasterPrompt(params);
    }
  }

  private getOriginalMasterPrompt(params: BasicPromptParams): string {
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
   * Get section continuation prompt (SHORT - references master context)
   */
  private async getSectionContinuationPrompt(
    sectionNumber: number,
    config: SectionConfig,
    testVersionOverride?: VersionTestOverride
  ): Promise<string> {
    const prompt = await this.getPromptWithFallback(
      'section_continuation',
      testVersionOverride,
      `Now generate the {{ordinal}} subtitle content from the Table of Contents you created earlier. IMPORTANT: Output should not be more than {{min_words}}-{{max_words}} words. After writing an output check the word count and regenerate if it is not in the range. Do not include the word count in the output.`
    );

    return this.populateVariables(prompt, {
      section_number: sectionNumber.toString(),
      ordinal: this.getOrdinalName(sectionNumber),
      min_words: config.sectionWordMin.toString(),
      max_words: config.sectionWordMax.toString()
    });
  }

  private async getConclusionContinuationPrompt(
    config: SectionConfig,
    testVersionOverride?: VersionTestOverride
  ): Promise<string> {
    const prompt = await this.getPromptWithFallback(
      'conclusion_continuation',
      testVersionOverride,
      `Now generate the conclusion content. IMPORTANT: Output should not be more than {{min_words}}-{{max_words}} words. After writing an output check the word count and regenerate if it is not in the range. Do not include the word count in the output.`
    );

    return this.populateVariables(prompt, {
      min_words: config.conclusionMin.toString(),
      max_words: config.conclusionMax.toString()
    });
  }

  private async getFAQsContinuationPrompt(
    config: SectionConfig,
    testVersionOverride?: VersionTestOverride
  ): Promise<string> {
    const prompt = await this.getPromptWithFallback(
      'faqs_continuation',
      testVersionOverride,
      `Now generate the FAQs content. IMPORTANT: Output should not be more than {{min_words}}-{{max_words}} words. After writing an output check the word count and regenerate if it is not in the range. Do not include the word count in the output.`
    );

    return this.populateVariables(prompt, {
      min_words: config.faqsMin.toString(),
      max_words: config.faqsMax.toString()
    });
  }

  private async getWhatsNextContinuationPrompt(
    config: SectionConfig,
    testVersionOverride?: VersionTestOverride
  ): Promise<string> {
    const prompt = await this.getPromptWithFallback(
      'whats_next_continuation',
      testVersionOverride,
      `Now generate What is next? content. IMPORTANT: Output should not be more than {{min_words}}-{{max_words}} words. After writing an output check the word count and regenerate if it is not in the range. Do not include the word count in the output.`
    );

    return this.populateVariables(prompt, {
      min_words: config.whatsMin.toString(),
      max_words: config.whatsMax.toString()
    });
  }

  private populateVariables(prompt: string, variables: Record<string, string>): string {
    let populated = prompt;
    
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      populated = populated.replace(regex, value || '');
    }
    
    return populated;
  }

  private getWordCountVariant(nos_of_words: string): string {
    if (nos_of_words === '600 to 1200 words') return 'small';
    if (nos_of_words === '2400 to 3600 words') return 'large';
    return 'medium';
  }

  private getSectionConfig(variant: string): SectionConfig {
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

  private getOrdinalName(n: number): string {
    const names = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
    return names[n] || `${n}th`;
  }

  private assembleContent(sections: {
    introResponse: string;
    sectionResponses: string[];
    conclusionResp: string;
    faqsResp: string;
    whatsNextResp: string;
  }): string {
    const { introResponse, sectionResponses, conclusionResp, faqsResp, whatsNextResp } = sections;

    return (
      '<div class="main-content-section-improveseo">' +
      introResponse +
      sectionResponses.map(s => `<div style="margin-bottom: 15px;margin-top: 50px;">${s}</div>`).join('') +
      `<div style="margin-bottom: 15px;margin-top: 50px;">${conclusionResp}</div>` +
      `<div style="margin-bottom: 15px;margin-top: 50px;">${faqsResp}</div>` +
      `<div style="margin-bottom: 15px;margin-top: 50px;">${whatsNextResp}</div>` +
      '</div>'
    );
  }

  private postProcessContent(content: string): string {
    // Convert Markdown to HTML first (in case AI returns Markdown)
    content = this.convertMarkdownToHTML(content);
    
    // Apply all post-processing from original function
    content = this.stripParenthesesWrappingContactTokens(content);
    content = this.convert_emails_to_links(content);
    content = this.convert_urls_to_links(content);
    content = this.stripParenthesesAroundAnchorTags(content);

    // HTML entity/nbsp cleanup
    content = content
      .replace(/&nbsp;/g, '')
      .replace(/<p>&nbsp;<\/p>/g, '')
      .replace(/<p>\s<\/p>/g, '')
      .replace(/<p><\/p>/g, '');

    // Remove boilerplate headings
    content = this.replace_content(content, '<h2>Main Content Sections</h2>');
    content = this.replace_content(content, '<p>—</p>');

    content = this.removePTags(content);
    content = this.removeConsecutiveSpecialCharacters(content);
    content = this.verifyAndFixTOCLinks(content);

    return content;
  }

  // Post-processing utility methods
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
    return content.replace(
      /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g,
      '<a href="mailto:$1">$1</a>'
    );
  }

  private convert_urls_to_links(content: string): string {
    return content.replace(
      /(<a\b[^>]*>.*?<\/a>)|((https?:\/\/|www\.)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}([\/\w.~:?#[\]@!$&'()*+,;=%-]*)?)/g,
      (match, anchorTag, url) => {
        if (anchorTag) return anchorTag;
        const href = /^https?:\/\//.test(url) ? url : `http://${url}`;
        return `<a href="${href}" target="_blank" rel="noopener">${url}</a>`;
      }
    );
  }

  private convertMarkdownToHTML(content: string): string {
    // Convert Markdown headings to HTML with IDs
    // ### Heading -> <h3 id="heading">Heading</h3>
    content = content.replace(/^#{6}\s+(.+)$/gm, (match, text) => {
      const id = text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
      return `<h6 id="${id}">${text.trim()}</h6>`;
    });
    content = content.replace(/^#{5}\s+(.+)$/gm, (match, text) => {
      const id = text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
      return `<h5 id="${id}">${text.trim()}</h5>`;
    });
    content = content.replace(/^#{4}\s+(.+)$/gm, (match, text) => {
      const id = text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
      return `<h4 id="${id}">${text.trim()}</h4>`;
    });
    content = content.replace(/^#{3}\s+(.+)$/gm, (match, text) => {
      const id = text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
      return `<h3 id="${id}">${text.trim()}</h3>`;
    });
    content = content.replace(/^#{2}\s+(.+)$/gm, (match, text) => {
      const id = text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
      return `<h2 id="${id}">${text.trim()}</h2>`;
    });
    content = content.replace(/^#\s+(.+)$/gm, (match, text) => {
      const id = text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
      return `<h1 id="${id}">${text.trim()}</h1>`;
    });
    
    // Convert **bold** to <strong>
    content = content.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    
    // Convert *italic* to <em>
    content = content.replace(/\*(.+?)\*/g, '<em>$1</em>');
    
    // Convert --- horizontal rules
    content = content.replace(/^---+$/gm, '<hr>');
    
    return content;
  }

  private stripParenthesesWrappingContactTokens(content: string): string {
    content = content.replace(/\(\s*((?:https?:\/\/|www\.)[^\s)]+)\s*\)/gi, '$1');
    content = content.replace(/\(\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,})\s*\)/g, '$1');
    return content;
  }

  private stripParenthesesAroundAnchorTags(content: string): string {
    return content.replace(/\(\s*(<a\b[^>]*>.*?<\/a>)\s*\)/gi, '$1');
  }

  private removeConsecutiveSpecialCharacters(content: string): string {
    const parts = content.split(/(<[^>]+>)/g);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] && parts[i][0] === '<') continue;
      parts[i] = parts[i].replace(/[^\p{L}\p{N}\s]{2,}/gu, '');
    }
    return parts.join('');
  }

  private verifyAndFixTOCLinks(content: string): string {
    const tocLinks: Record<string, string> = {};
    const headings: Record<string, string> = {};

    const tocRe = /<a href="#([^"]+)">([^<]+)<\/a>/gi;
    let tocMatch: RegExpExecArray | null;
    while ((tocMatch = tocRe.exec(content)) !== null) {
      tocLinks[tocMatch[1]] = tocMatch[2].trim();
    }

    const headingRe = /<h([2-6])(?:\s+id="([^"]+)")?>([^<]+)<\/h[2-6]>/gi;
    let headingMatch: RegExpExecArray | null;
    while ((headingMatch = headingRe.exec(content)) !== null) {
      if (headingMatch[2]) {
        headings[headingMatch[2]] = headingMatch[3].trim();
      }
    }

    let updated = content;
    for (const [anchor, title] of Object.entries(tocLinks)) {
      if (!headings[anchor]) {
        const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const headingPattern = new RegExp(`<h([2-6])(?:\\s+[^>]*)?>\\s*(${escapedTitle})\\s*<\\/h[2-6]>`, 'i');
        updated = updated.replace(headingPattern, (match, level, text) => {
          return `<h${level} id="${anchor}">${text}</h${level}>`;
        });
      }
    }

    return updated;
  }

  // OpenAI API call
  private async chatOnce(apiKey: string, model: string, messages: ChatMessage[]): Promise<string> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
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

  // Tracing and monitoring
  private recordStage(
    stageName: string,
    promptText: string,
    aiResponse: string,
    latency: number
  ): void {
    if (!this.trace) return;

    this.trace.stages.push({
      stageName,
      promptTemplateUsed: stageName,
      promptVersionUsed: 1, // TODO: Get actual version
      promptText: promptText.substring(0, 1000), // Truncate for storage
      aiResponse: aiResponse.substring(0, 1000), // Truncate for storage
      latency
    });

    this.trace.metadata.promptsUsed.push(stageName);
  }

  private async saveTrace(trace: ConversationTrace): Promise<void> {
    // TODO: Implement trace storage to MongoDB
    console.log(`📊 Conversation trace saved: ${trace.generationId}`);
  }

  private generateId(): string {
    return `gen_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  private countWords(text: string): number {
    const stripped = text.replace(/<[^>]+>/g, ' ');
    return stripped.split(/\s+/).filter(w => w.length > 0).length;
  }
}
