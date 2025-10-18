import OpenAI from 'openai';
import { config } from '../config/config.js';
import { promptService, PromptParameters, PromptSetConfig } from './promptService.js';

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: config.openaiApiKey,
});

export interface ContentGenerationRequest {
  seedKeyword: string;
  wordCount: 'small' | 'medium' | 'large';
  tone?: string;
  audience?: string;
  additionalContext?: string;
  customParameters?: PromptParameters;
  promptSetConfig?: PromptSetConfig;
}

export interface ContentGenerationResult {
  success: boolean;
  content?: GeneratedContent;
  error?: string;
  promptsUsed?: Record<string, string>;
  metadata?: {
    totalTokens?: number;
    processingTime?: number;
    gptCalls?: number;
  };
}

export interface GeneratedContent {
  title: string;
  metaTitle: string;
  metaDescription: string;
  introduction: string;
  tableOfContents?: string;
  mainContent: string;
  faqs?: string;
  whatsNext?: string;
  conclusion: string;
  fullHtml: string;
  audienceData?: string;
  lsiKeywords?: string;
  factsData?: string;
}

class ContentGenerationService {
  /**
   * Generate content using default prompt set
   */
  async generateWithDefaults(request: ContentGenerationRequest): Promise<ContentGenerationResult> {
    try {
      const startTime = Date.now();
      let gptCalls = 0;
      let totalTokens = 0;
      const promptsUsed: Record<string, string> = {};

      // Use default prompt set configuration
      const promptSetConfig = request.promptSetConfig || promptService.getDefaultPromptSetConfig();
      
      // Set format template based on word count
      promptSetConfig.format_template = request.wordCount;

      // Build base parameters
      const baseParameters: PromptParameters = {
        seed_keyword: request.seedKeyword,
        context: request.additionalContext || '',
        ...request.customParameters
      };

      // Step 1: Generate audience data
      console.log(`🎯 Generating audience data for: ${request.seedKeyword}`);
      const audiencePrompt = await promptService.getProcessedPrompt('audience_generation', baseParameters);
      promptsUsed['audience_generation'] = audiencePrompt;
      
      const audienceResponse = await this.callGPT(audiencePrompt);
      gptCalls++;
      totalTokens += audienceResponse.usage?.total_tokens || 0;
      const audienceData = audienceResponse.choices[0].message.content || '';

      // Step 2: Generate LSI keywords
      console.log(`🔍 Generating LSI keywords...`);
      const lsiParameters = { ...baseParameters, audience_data: audienceData };
      const lsiPrompt = await promptService.getProcessedPrompt('lsi_keywords', lsiParameters);
      promptsUsed['lsi_keywords'] = lsiPrompt;
      
      const lsiResponse = await this.callGPT(lsiPrompt);
      gptCalls++;
      totalTokens += lsiResponse.usage?.total_tokens || 0;
      const lsiKeywords = lsiResponse.choices[0].message.content || '';

      // Step 3: Generate facts
      console.log(`📊 Generating facts and statistics...`);
      const factsParameters = { ...lsiParameters, lsi_keywords: lsiKeywords };
      const factsPrompt = await promptService.getProcessedPrompt('facts_generation', factsParameters);
      promptsUsed['facts_generation'] = factsPrompt;
      
      const factsResponse = await this.callGPT(factsPrompt);
      gptCalls++;
      totalTokens += factsResponse.usage?.total_tokens || 0;
      const factsData = factsResponse.choices[0].message.content || '';

      // Step 4: Generate content format/outline
      console.log(`📝 Generating content format for ${request.wordCount} article...`);
      const formatParameters = { 
        ...factsParameters, 
        facts: factsData 
      };
      const formatPrompt = await promptService.getProcessedPrompt(`format_${request.wordCount}`, formatParameters);
      promptsUsed[`format_${request.wordCount}`] = formatPrompt;
      
      const formatResponse = await this.callGPT(formatPrompt);
      gptCalls++;
      totalTokens += formatResponse.usage?.total_tokens || 0;
      const contentOutline = formatResponse.choices[0].message.content || '';

      // Step 5: Generate main content sections
      console.log(`✍️ Generating main content sections...`);
      const sectionParameters = {
        ...formatParameters,
        section_outline: contentOutline,
        relevant_facts: factsData
      };

      // Generate introduction
      const introPrompt = await promptService.getProcessedPrompt('section_content', {
        ...sectionParameters,
        section_topic: 'Introduction'
      });
      promptsUsed['introduction'] = introPrompt;
      
      const introResponse = await this.callGPT(introPrompt);
      gptCalls++;
      totalTokens += introResponse.usage?.total_tokens || 0;
      const introduction = introResponse.choices[0].message.content || '';

      // Generate main content (simplified - in full implementation, parse outline for sections)
      const mainContentPrompt = await promptService.getProcessedPrompt('section_content', {
        ...sectionParameters,
        section_topic: 'Main Content Sections'
      });
      promptsUsed['main_content'] = mainContentPrompt;
      
      const mainContentResponse = await this.callGPT(mainContentPrompt);
      gptCalls++;
      totalTokens += mainContentResponse.usage?.total_tokens || 0;
      const mainContent = mainContentResponse.choices[0].message.content || '';

      // Step 6: Generate conclusion
      console.log(`🔚 Generating conclusion...`);
      const conclusionPrompt = await promptService.getProcessedPrompt('conclusion', {
        ...sectionParameters,
        main_points: `${introduction}\n\n${mainContent}`,
        call_to_action: request.customParameters?.call_to_action || 'Learn more and take action'
      });
      promptsUsed['conclusion'] = conclusionPrompt;
      
      const conclusionResponse = await this.callGPT(conclusionPrompt);
      gptCalls++;
      totalTokens += conclusionResponse.usage?.total_tokens || 0;
      const conclusion = conclusionResponse.choices[0].message.content || '';

      // Step 7: Generate FAQs (optional for medium/large)
      let faqs = '';
      if (request.wordCount !== 'small') {
        console.log(`❓ Generating FAQs...`);
        const faqPrompt = await promptService.getProcessedPrompt('faqs', {
          ...sectionParameters,
          article_content: `${introduction}\n\n${mainContent}\n\n${conclusion}`
        });
        promptsUsed['faqs'] = faqPrompt;
        
        const faqResponse = await this.callGPT(faqPrompt);
        gptCalls++;
        totalTokens += faqResponse.usage?.total_tokens || 0;
        faqs = faqResponse.choices[0].message.content || '';
      }

      // Step 8: Generate What's Next (for large articles)
      let whatsNext = '';
      if (request.wordCount === 'large') {
        console.log(`➡️ Generating What's Next section...`);
        const whatsNextPrompt = await promptService.getProcessedPrompt('whats_next', {
          ...sectionParameters,
          article_topic: contentOutline
        });
        promptsUsed['whats_next'] = whatsNextPrompt;
        
        const whatsNextResponse = await this.callGPT(whatsNextPrompt);
        gptCalls++;
        totalTokens += whatsNextResponse.usage?.total_tokens || 0;
        whatsNext = whatsNextResponse.choices[0].message.content || '';
      }

      // Step 9: Generate meta title
      console.log(`🏷️ Generating meta title...`);
      const metaTitlePrompt = await promptService.getProcessedPrompt('meta_title', {
        ...sectionParameters,
        article_focus: contentOutline
      });
      promptsUsed['meta_title'] = metaTitlePrompt;
      
      const metaTitleResponse = await this.callGPT(metaTitlePrompt);
      gptCalls++;
      totalTokens += metaTitleResponse.usage?.total_tokens || 0;
      const metaTitle = metaTitleResponse.choices[0].message.content || '';

      // Step 10: Generate meta description
      console.log(`📄 Generating meta description...`);
      const metaDescPrompt = await promptService.getProcessedPrompt('meta_description', {
        ...sectionParameters,
        article_summary: contentOutline,
        main_benefit: 'Comprehensive information and actionable insights'
      });
      promptsUsed['meta_description'] = metaDescPrompt;
      
      const metaDescResponse = await this.callGPT(metaDescPrompt);
      gptCalls++;
      totalTokens += metaDescResponse.usage?.total_tokens || 0;
      const metaDescription = metaDescResponse.choices[0].message.content || '';

      // Assemble final content
      const generatedContent: GeneratedContent = {
        title: this.extractTitle(metaTitle),
        metaTitle: this.extractTitle(metaTitle),
        metaDescription: this.extractDescription(metaDescription),
        introduction,
        mainContent,
        faqs,
        whatsNext,
        conclusion,
        fullHtml: this.assembleFullHtml({
          title: this.extractTitle(metaTitle),
          introduction,
          mainContent,
          faqs,
          whatsNext,
          conclusion
        }),
        audienceData,
        lsiKeywords,
        factsData
      };

      const processingTime = Date.now() - startTime;
      console.log(`✅ Content generation completed in ${processingTime}ms with ${gptCalls} GPT calls`);

      return {
        success: true,
        content: generatedContent,
        promptsUsed,
        metadata: {
          totalTokens,
          processingTime,
          gptCalls
        }
      };

    } catch (error) {
      console.error('❌ Content generation failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  /**
   * Generate content using specific prompt set configuration
   */
  async generateFromPromptSet(
    promptSetId: string, 
    request: ContentGenerationRequest
  ): Promise<ContentGenerationResult> {
    try {
      // For now, use the promptSetId to modify the default config
      // In a full implementation, you'd load a saved prompt set configuration
      const promptSetConfig = promptService.getDefaultPromptSetConfig();
      
      // You could store prompt set configurations in the database and load them here
      console.log(`🎛️ Generating content using prompt set: ${promptSetId}`);
      
      return await this.generateWithDefaults({
        ...request,
        promptSetConfig
      });

    } catch (error) {
      console.error(`❌ Failed to generate from prompt set ${promptSetId}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate from prompt set'
      };
    }
  }

  /**
   * Call OpenAI GPT API
   */
  private async callGPT(prompt: string): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    try {
      const response = await openai.chat.completions.create({
        model: config.openaiModel,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 2000,
        temperature: 0.7,
      });

      return response;
    } catch (error) {
      console.error('❌ OpenAI API call failed:', error);
      throw error;
    }
  }

  /**
   * Extract clean title from GPT response
   */
  private extractTitle(response: string): string {
    // Extract first line or look for title patterns
    const lines = response.split('\n').filter(line => line.trim());
    if (lines.length > 0) {
      return lines[0].replace(/^(Title:|Meta Title:)\s*/i, '').trim();
    }
    return 'Generated Article Title';
  }

  /**
   * Extract clean description from GPT response
   */
  private extractDescription(response: string): string {
    const lines = response.split('\n').filter(line => line.trim());
    if (lines.length > 0) {
      return lines[0].replace(/^(Description:|Meta Description:)\s*/i, '').trim();
    }
    return 'Generated article description';
  }

  /**
   * Assemble full HTML from content parts
   */
  private assembleFullHtml(content: {
    title: string;
    introduction: string;
    mainContent: string;
    faqs?: string;
    whatsNext?: string;
    conclusion: string;
  }): string {
    let html = `<h1>${content.title}</h1>\n\n`;
    html += `<div class="introduction">\n${content.introduction}\n</div>\n\n`;
    html += `<div class="main-content">\n${content.mainContent}\n</div>\n\n`;
    
    if (content.faqs) {
      html += `<div class="faqs">\n<h2>Frequently Asked Questions</h2>\n${content.faqs}\n</div>\n\n`;
    }
    
    if (content.whatsNext) {
      html += `<div class="whats-next">\n<h2>What's Next</h2>\n${content.whatsNext}\n</div>\n\n`;
    }
    
    html += `<div class="conclusion">\n${content.conclusion}\n</div>`;
    
    return html;
  }

  /**
   * Test individual prompt template
   */
  async testPrompt(
    templateType: string, 
    parameters: PromptParameters
  ): Promise<{ success: boolean; result?: string; error?: string; prompt?: string }> {
    try {
      const processedPrompt = await promptService.getProcessedPrompt(templateType, parameters);
      const response = await this.callGPT(processedPrompt);
      
      return {
        success: true,
        result: response.choices[0].message.content || '',
        prompt: processedPrompt
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Test failed',
        prompt: await promptService.getProcessedPrompt(templateType, parameters).catch(() => 'Failed to process prompt')
      };
    }
  }
}

export const contentGenerationService = new ContentGenerationService();