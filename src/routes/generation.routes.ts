import { Router, Request, Response } from 'express';
import { contentGenerationService, ContentGenerationRequest } from '../services/contentGenerationService.js';
import { promptService } from '../services/promptService.js';
import { EnhancedAIContentGenerator } from '../services/enhanced-ai-generator.service.js';
import { PromptManagementService } from '../services/prompt-management.service.js';
import { validateApiAccess, validateCredits, AuthenticatedRequest } from '../middleware/apiAuth.middleware.js';
import { deductCredits } from '../models/user.models.js';
import sql from '../data/db.js';
import { FluxAIService } from '../services/fluxai.service.js';

const router = Router();

/**
 * Generate content using default prompt set
 * POST /api/generate/default
 */
router.post('/default', async (req: Request, res: Response) => {
  try {
    const {
      seedKeyword,
      wordCount = 'medium',
      tone,
      audience,
      additionalContext,
      customParameters
    } = req.body;

    if (!seedKeyword) {
      return res.status(400).json({
        success: false,
        error: 'seedKeyword is required'
      });
    }

    if (!['small', 'medium', 'large'].includes(wordCount)) {
      return res.status(400).json({
        success: false,
        error: 'wordCount must be "small", "medium", or "large"'
      });
    }

    console.log(`🚀 Starting content generation for: "${seedKeyword}" (${wordCount})`);

    const request: ContentGenerationRequest = {
      seedKeyword,
      wordCount,
      tone,
      audience,
      additionalContext,
      customParameters
    };

    const result = await contentGenerationService.generateWithDefaults(request);

    if (result.success) {
      console.log(`✅ Content generated successfully for: "${seedKeyword}"`);
    } else {
      console.error(`❌ Content generation failed for: "${seedKeyword}"`, result.error);
    }

    res.json(result);

  } catch (error) {
    console.error('❌ Content generation endpoint error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during content generation'
    });
  }
});

/**
 * Generate content using specific prompt set
 * POST /api/generate/promptset/:setId
 */
router.post('/promptset/:setId', async (req: Request, res: Response) => {
  try {
    const { setId } = req.params;
    const {
      seedKeyword,
      wordCount = 'medium',
      tone,
      audience,
      additionalContext,
      customParameters
    } = req.body;

    if (!seedKeyword) {
      return res.status(400).json({
        success: false,
        error: 'seedKeyword is required'
      });
    }

    if (!['small', 'medium', 'large'].includes(wordCount)) {
      return res.status(400).json({
        success: false,
        error: 'wordCount must be "small", "medium", or "large"'
      });
    }

    console.log(`🎛️ Starting content generation with prompt set ${setId} for: "${seedKeyword}"`);

    const request: ContentGenerationRequest = {
      seedKeyword,
      wordCount,
      tone,
      audience,
      additionalContext,
      customParameters
    };

    const result = await contentGenerationService.generateFromPromptSet(setId, request);

    if (result.success) {
      console.log(`✅ Content generated successfully using prompt set ${setId}`);
    } else {
      console.error(`❌ Content generation failed with prompt set ${setId}:`, result.error);
    }

    res.json(result);

  } catch (error) {
    console.error('❌ Prompt set generation endpoint error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during prompt set generation'
    });
  }
});

/**
 * Test individual prompt template
 * POST /api/generate/test-prompt
 */
router.post('/test-prompt', async (req: Request, res: Response) => {
  try {
    const { templateType, parameters } = req.body;

    if (!templateType) {
      return res.status(400).json({
        success: false,
        error: 'templateType is required'
      });
    }

    if (!parameters || typeof parameters !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'parameters object is required'
      });
    }

    console.log(`🧪 Testing prompt template: ${templateType}`);

    const result = await contentGenerationService.testPrompt(templateType, parameters);

    res.json(result);

  } catch (error) {
    console.error('❌ Prompt test endpoint error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during prompt testing'
    });
  }
});

/**
 * Get all system templates
 * GET /api/generate/templates
 */
router.get('/templates', async (req: Request, res: Response) => {
  try {
    console.log('📋 Fetching system templates...');
    
    const templates = await promptService.getSystemTemplates();
    
    res.json({
      success: true,
      templates: templates.map(t => ({
        id: t._id,
        name: t.name,
        displayName: t.displayName,
        description: t.description,
        templateType: t.templateType,
        category: t.category,
        variables: t.variables,
        isSystem: t.isSystem
      }))
    });

  } catch (error) {
    console.error('❌ Templates fetch error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch templates'
    });
  }
});

/**
 * Get template versions
 * GET /api/generate/templates/:templateId/versions
 */
router.get('/templates/:templateId/versions', async (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;
    
    console.log(`📚 Fetching versions for template: ${templateId}`);
    
    const versions = await promptService.getTemplateVersions(templateId);
    
    res.json({
      success: true,
      versions: versions.map(v => ({
        id: v._id,
        version: v.version,
        prompt: v.prompt,
        isActive: v.isActive,
        createdBy: v.createdBy,
        createdAt: v.createdAt,
        metadata: v.metadata
      }))
    });

  } catch (error) {
    console.error('❌ Template versions fetch error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch template versions'
    });
  }
});

/**
 * Create new prompt version
 * POST /api/generate/templates/:templateId/versions
 */
router.post('/templates/:templateId/versions', async (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;
    const { prompt, createdBy = 'api-user', metadata } = req.body;

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: 'prompt is required'
      });
    }

    console.log(`➕ Creating new version for template: ${templateId}`);

    const version = await promptService.createPromptVersion(templateId, prompt, createdBy, metadata);
    
    res.json({
      success: true,
      version: {
        id: version._id,
        version: version.version,
        prompt: version.prompt,
        isActive: version.isActive,
        createdBy: version.createdBy,
        createdAt: version.createdAt,
        metadata: version.metadata
      }
    });

  } catch (error) {
    console.error('❌ Version creation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create prompt version'
    });
  }
});

/**
 * Activate prompt version
 * PUT /api/generate/versions/:versionId/activate
 */
router.put('/versions/:versionId/activate', async (req: Request, res: Response) => {
  try {
    const { versionId } = req.params;
    
    console.log(`🔄 Activating version: ${versionId}`);
    
    await promptService.activatePromptVersion(versionId);
    
    res.json({
      success: true,
      message: 'Version activated successfully'
    });

  } catch (error) {
    console.error('❌ Version activation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to activate version'
    });
  }
});

/**
 * Get default prompt set configuration
 * GET /api/generate/default-config
 */
router.get('/default-config', async (req: Request, res: Response) => {
  try {
    console.log('⚙️ Fetching default prompt set configuration...');
    
    const config = promptService.getDefaultPromptSetConfig();
    
    res.json({
      success: true,
      config
    });

  } catch (error) {
    console.error('❌ Default config fetch error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch default configuration'
    });
  }
});

/**
 * Generate content using active prompts from database (focused approach)
 * POST /api/generate/active
 */
router.post('/active', validateApiAccess, validateCredits('content', 1), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      seed_keyword,
      keyword_selection,
      seed_options,
      nos_of_words = '1200 to 2400 words',
      content_lang = 'en',
      voice_tone,
      point_of_view,
      title,
      call_to_action,
      details_to_include,
      for_testing_only = 0,
      audienceData,
      // Dynamic prompt parameters
      useActivePrompts = true,
      customPrompts = {},
      templateVariables = {}
    } = req.body;

    if (!seed_keyword) {
      return res.status(400).json({
        success: false,
        error: 'seed_keyword is required'
      });
    }

    // Validate nos_of_words parameter
    const validWordCounts = ['600 to 1200 words', '1200 to 2400 words', '2400 to 3600 words'];
    if (!validWordCounts.includes(nos_of_words)) {
      return res.status(400).json({
        success: false,
        error: `nos_of_words must be one of: ${validWordCounts.join(', ')}`
      });
    }

    console.log(`🚀 Starting dynamic content generation for: "${seed_keyword}" (${nos_of_words})`);

    // Initialize services
    const promptManagementService = new PromptManagementService();
    const enhancedGenerator = new EnhancedAIContentGenerator(promptManagementService);

    // Prepare template variables with request parameters
    const enhancedTemplateVariables = {
      seed_keyword,
      context: details_to_include || '',
      audience_data: audienceData || '',
      lsi_keywords: '', // Will be generated dynamically
      facts_data: '', // Will be generated dynamically
      section_content: '', // Will be used in sections
      conclusion_content: '', // Will be used in conclusion
      faqs_content: '', // Will be used in FAQs
      whats_next_content: call_to_action || '',
      meta_title: title || seed_keyword,
      meta_description: '',
      ...templateVariables // Allow override of any variables
    };

    // Generate content using dynamic prompts
    const result = await enhancedGenerator.generateAiContentDynamic({
      // Core parameters from generateAiHtmlPost2
      seed_keyword,
      keyword_selection,
      seed_options,
      nos_of_words: nos_of_words as '600 to 1200 words' | '1200 to 2400 words' | '2400 to 3600 words',
      content_lang,
      voice_tone,
      point_of_view,
      title,
      call_to_action,
      details_to_include,
      for_testing_only,
      audienceData,
      // Dynamic prompt parameters
      useActivePrompts,
      customPrompts,
      templateVariables: enhancedTemplateVariables
    });

    console.log(`✅ Dynamic content generated successfully for: "${seed_keyword}"`);
    console.log(`📊 Generation metadata:`, result.generationMetadata);

    // � SAVE GENERATION TO DATABASE FIRST (to get generation_id)
    const userId = req.user.id;
    const websiteId = req.website?.id || null;
    
    const generationRecord = await sql`
      INSERT INTO user_generations (
        user_id,
        website_id,
        type,
        status,
        parameters,
        result,
        metadata,
        processing_time_ms
      ) VALUES (
        ${userId},
        ${websiteId},
        'content',
        'success',
        ${JSON.stringify({
          seed_keyword,
          nos_of_words,
          content_lang,
          voice_tone,
          point_of_view,
          title
        })},
        ${JSON.stringify({
          content: result.content,
          meta_title: result.meta_title,
          meta_description: result.meta_descreption
        })},
        ${JSON.stringify({
          promptsUsed: result.promptsUsed,
          generationMetadata: result.generationMetadata
        })},
        ${result.generationMetadata?.processingTime || 0}
      )
      RETURNING id
    `;

    const generationId = generationRecord[0].id;

    // 🔥 DEDUCT CREDITS AFTER SUCCESSFUL GENERATION (with website_id and generation_id)
    await deductCredits(
      userId,
      'content',
      1,
      `Content generation for keyword: ${seed_keyword}`,
      websiteId,
      generationId
    );

    console.log(`💳 Credits deducted and generation saved (ID: ${generationId})`);

    res.json({
      success: true,
      data: {
        generation_id: generationId,
        search_data: result.search_data,
        content: result.content,
        meta_title: result.meta_title,
        meta_description: result.meta_descreption,
        // Additional metadata from dynamic generation
        promptsUsed: result.promptsUsed,
        generationMetadata: result.generationMetadata
      }
    });

  } catch (error) {
    console.error('❌ Dynamic content generation error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate content'
    });
  }
});

// POST /api/v1/generate/immediateVersionTesting
// Test a specific version of one prompt type while using active versions for others
router.post('/immediateVersionTesting', async (req: Request, res: Response) => {
  try {
    const {
      // Core generation parameters (same as /active route)
      seed_keyword,
      keyword_selection = '',
      seed_options = '',
      nos_of_words = '600 to 1200 words',
      content_lang,
      voice_tone = '',
      point_of_view = '',
      title = '',
      call_to_action = '',
      details_to_include = '',
      for_testing_only = 0,
      audienceData = '',
      
      // Testing-specific parameters
      testPromptType,     // e.g., 'audience_generation'
      testVersionId,      // MongoDB ObjectId of the version to test
      
      // Optional template variable overrides
      templateVariables = {}
    } = req.body;

    // Validate required parameters
    if (!seed_keyword) {
      return res.status(400).json({
        success: false,
        error: 'seed_keyword is required'
      });
    }

    if (!testPromptType || !testVersionId) {
      return res.status(400).json({
        success: false,
        error: 'testPromptType and testVersionId are required for version testing'
      });
    }

    // Validate nos_of_words parameter
    const validWordCounts = ['600 to 1200 words', '1200 to 2400 words', '2400 to 3600 words'];
    if (!validWordCounts.includes(nos_of_words)) {
      return res.status(400).json({
        success: false,
        error: `nos_of_words must be one of: ${validWordCounts.join(', ')}`
      });
    }

    console.log(`🧪 Starting version testing for: "${seed_keyword}" (${nos_of_words})`);
    console.log(`🔍 Testing ${testPromptType} version: ${testVersionId}`);

    // Initialize services
    const promptManagementService = new PromptManagementService();
    const enhancedGenerator = new EnhancedAIContentGenerator(promptManagementService);

    // Prepare template variables with request parameters
    const enhancedTemplateVariables = {
      seed_keyword,
      context: details_to_include || '',
      audience_data: audienceData || '',
      lsi_keywords: '', // Will be generated dynamically
      facts_data: '', // Will be generated dynamically
      section_content: '', // Will be used in sections
      conclusion_content: '', // Will be used in conclusion
      faqs_content: '', // Will be used in FAQs
      whats_next_content: call_to_action || '',
      meta_title: title || seed_keyword,
      meta_description: '',
      ...templateVariables // Allow override of any variables
    };

    // Generate content using version testing mode
    const result = await enhancedGenerator.generateAiContentDynamic({
      // Core parameters from generateAiHtmlPost2
      seed_keyword,
      keyword_selection,
      seed_options,
      nos_of_words: nos_of_words as '600 to 1200 words' | '1200 to 2400 words' | '2400 to 3600 words',
      content_lang,
      voice_tone,
      point_of_view,
      title,
      call_to_action,
      details_to_include,
      for_testing_only,
      audienceData,
      
      // Version testing configuration
      useActivePrompts: true, // Use active prompts as base
      testVersionOverride: {   // Override specific prompt type with test version
        promptType: testPromptType,
        versionId: testVersionId
      },
      templateVariables: enhancedTemplateVariables
    });

    console.log(`✅ Version testing completed for: "${seed_keyword}"`);
    console.log(`🧪 Tested version: ${testPromptType} v${testVersionId}`);
    console.log(`📊 Generation metadata:`, result.generationMetadata);

    res.json({
      success: true,
      data: {
        search_data: result.search_data,
        content: result.content,
        meta_title: result.meta_title,
        meta_description: result.meta_descreption,
        // Additional testing metadata
        promptsUsed: result.promptsUsed,
        generationMetadata: result.generationMetadata,
        testingInfo: {
          testedPromptType: testPromptType,
          testedVersionId: testVersionId,
          message: `Used ${testPromptType} version ${testVersionId} for testing while other prompts used active versions`
        }
      }
    });

  } catch (error) {
    console.error('❌ Version testing error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate content with version testing'
    });
  }
});

/**
 * Generate AI Image
 * POST /api/v1/generate/generateimage
 */
router.post('/generateimage', validateApiAccess, validateCredits('images', 1), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      title,
      prompt,
      noedit = false,
      seed_title,
      width = 1024,
      height = 768
    } = req.body;

    if (!title && !prompt) {
      return res.status(400).json({
        success: false,
        error: 'Either title or prompt is required'
      });
    }

    console.log(`🎨 Starting Flux AI image generation for: "${title || prompt}"`);

    const userId = req.user.id;
    const websiteId = req.website?.id || null;
    const startTime = Date.now();

    // Initialize Flux AI service
    const fluxAI = new FluxAIService();
    const openAiKey = process.env.OPENAI_API_KEY || '';

    if (!openAiKey) {
      return res.status(500).json({
        success: false,
        error: 'OpenAI API key not configured for prompt generation'
      });
    }

    let imageUrl: string;
    let imagePrompt: string;

    if (noedit && prompt) {
      // Use custom prompt directly (no OpenAI prompt generation)
      imagePrompt = prompt;
      console.log('📝 Using custom prompt (no edit mode)');

      const taskId = await fluxAI.generateImage({
        prompt: imagePrompt,
        width,
        height,
        prompt_upsampling: false,
        safety_tolerance: 2,
        output_format: 'jpeg'
      });

      imageUrl = await fluxAI.getResult(taskId);
    } else {
      // Generate prompt using OpenAI + Flux AI (WordPress plugin default flow)
      const result = await fluxAI.generateImageWithPolling(
        title || prompt,
        openAiKey,
        { width, height }
      );

      imageUrl = result.imageUrl;
      imagePrompt = result.promptUsed;
    }

    const processingTime = Date.now() - startTime;

    // � SAVE GENERATION TO DATABASE FIRST (to get generation_id)
    const generationRecord = await sql`
      INSERT INTO user_generations (
        user_id,
        website_id,
        type,
        status,
        parameters,
        result,
        metadata,
        processing_time_ms
      ) VALUES (
        ${userId},
        ${websiteId},
        'image',
        'success',
        ${JSON.stringify({
          title: title || prompt,
          prompt: imagePrompt,
          width,
          height,
          noedit
        })},
        ${JSON.stringify({
          image_url: imageUrl,
          prompt_used: imagePrompt
        })},
        ${JSON.stringify({
          provider: 'flux-ai',
          model: 'flux-pro-1.1',
          generation_time: new Date().toISOString()
        })},
        ${processingTime}
      )
      RETURNING id
    `;

    const generationId = generationRecord[0].id;

    // 🔥 DEDUCT CREDITS AFTER SUCCESSFUL GENERATION (with website_id and generation_id)
    await deductCredits(
      userId,
      'images',
      1,
      `AI image generation for: ${title || prompt}`,
      websiteId,
      generationId
    );

    console.log(`✅ Flux AI image generated and saved (ID: ${generationId})`);
    console.log(`💳 1 image credit deducted for user ${userId}`);
    console.log(`⏱️ Processing time: ${processingTime}ms`);

    res.json({
      success: true,
      data: {
        generation_id: generationId,
        image_url: imageUrl,
        prompt_used: imagePrompt,
        width,
        height,
        processing_time_ms: processingTime
      }
    });

  } catch (error) {
    console.error('❌ Flux AI image generation error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate AI image'
    });
  }
});

/**
 * Generate Keyword List
 * POST /api/v1/generate/generatekeyword
 */
router.post('/generatekeyword', validateApiAccess, validateCredits('keywords', 1), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      seed_keyword,
      niche,
      count = 50,
      include_search_volume = false
    } = req.body;

    if (!seed_keyword) {
      return res.status(400).json({
        success: false,
        error: 'seed_keyword is required'
      });
    }

    console.log(`🔍 Starting keyword generation for: "${seed_keyword}"`);

    // TODO: Replace with actual keyword research service
    // For now, return mock response
    const keywords = Array.from({ length: count }, (_, i) => ({
      keyword: `${seed_keyword} ${['guide', 'tips', 'tutorial', 'benefits', 'examples', 'best practices', 'tools', 'strategies', 'techniques', 'ideas'][i % 10]} ${i + 1}`,
      search_volume: include_search_volume ? Math.floor(Math.random() * 10000) + 100 : undefined,
      difficulty: include_search_volume ? Math.floor(Math.random() * 100) : undefined,
      cpc: include_search_volume ? (Math.random() * 5).toFixed(2) : undefined
    }));

    const userId = req.user.id;
    const websiteId = req.website?.id || null;

    // � SAVE GENERATION TO DATABASE FIRST (to get generation_id)
    const generationRecord = await sql`
      INSERT INTO user_generations (
        user_id,
        website_id,
        type,
        status,
        parameters,
        result,
        metadata
      ) VALUES (
        ${userId},
        ${websiteId},
        'keywords',
        'success',
        ${JSON.stringify({
          seed_keyword,
          niche,
          count,
          include_search_volume
        })},
        ${JSON.stringify({
          keywords,
          total_count: keywords.length
        })},
        ${JSON.stringify({
          provider: 'keyword-research-api',
          generation_time: Date.now()
        })}
      )
      RETURNING id
    `;

    const generationId = generationRecord[0].id;

    // 🔥 DEDUCT CREDITS AFTER SUCCESSFUL GENERATION (with website_id and generation_id)
    await deductCredits(
      userId,
      'keywords',
      1,
      `Keyword research for: ${seed_keyword}`,
      websiteId,
      generationId
    );

    console.log(`✅ ${keywords.length} keywords generated and saved (ID: ${generationId})`);
    console.log(`💳 1 keyword credit deducted for user ${userId}`);

    res.json({
      success: true,
      data: {
        generation_id: generationId,
        seed_keyword,
        keywords,
        total_count: keywords.length,
        message: '🚧 Mock response - Keyword research service to be integrated'
      }
    });

  } catch (error) {
    console.error('❌ Keyword generation error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate keywords'
    });
  }
});

export default router;