import { Router, Request, Response } from 'express';
import { contentGenerationService, ContentGenerationRequest } from '../services/contentGenerationService.js';
import { promptService } from '../services/promptService.js';
import { EnhancedAIContentGenerator } from '../services/enhanced-ai-generator.service.js';
import { ConversationalAIContentGenerator } from '../services/conversational-ai-generator.service.js';
import { PromptManagementService } from '../services/prompt-management.service.js';
import { PromptTemplate, PromptVersion } from '../models/prompt.models.js';
import { validateApiAccess, validateCredits, AuthenticatedRequest } from '../middleware/apiAuth.middleware.js';
import { deductCredits } from '../models/user.models.js';
import sql from '../data/db.js';
import { FluxAIService } from '../services/fluxai.service.js';
import { chat } from '../services/openai.js';
import { enforceMetaLength, META_BOUNDS } from '../services/meta-length.js';

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
 * Get all system templates (updated for conversational prompts)
 * GET /api/generate/templates
 */
router.get('/templates', async (req: Request, res: Response) => {
  try {
    console.log('📋 Fetching all prompt templates...');
    
    const promptMgmt = new PromptManagementService();
    const templates = await promptMgmt.getAllTemplates();
    
    res.json({
      success: true,
      data: templates.map(t => ({
        _id: t._id,
        name: t.name,
        description: t.description,
        category: t.category,
        wordCountVariant: t.wordCountVariant,
        orderIndex: t.orderIndex,
        variables: t.variables,
        updatedAt: t.updatedAt
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
 * Get template versions with template info
 * GET /api/generate/templates/:templateId/versions
 */
router.get('/templates/:templateId/versions', async (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;
    
    console.log(`📚 Fetching versions for template: ${templateId}`);
    
    const promptMgmt = new PromptManagementService();
    const versions = await promptMgmt.getTemplateVersions(templateId);
    const template = await PromptTemplate.findById(templateId);
    const activeVersion = await promptMgmt.getActiveVersion(templateId);
    
    if (!template) {
      return res.status(404).json({
        success: false,
        error: 'Template not found'
      });
    }
    
    res.json({
      success: true,
      data: {
        template: {
          _id: template._id,
          name: template.name,
          description: template.description,
          category: template.category,
          wordCountVariant: template.wordCountVariant,
          variables: template.variables
        },
        activeVersion: activeVersion ? {
          _id: activeVersion._id,
          version: activeVersion.version,
          prompt: activeVersion.prompt,
          isActive: activeVersion.isActive,
          createdBy: activeVersion.createdBy,
          createdAt: activeVersion.createdAt
        } : null,
        versions: versions.map(v => ({
          _id: v._id,
          version: v.version,
          prompt: v.prompt,
          isActive: v.isActive,
          createdBy: v.createdBy,
          createdAt: v.createdAt,
          metadata: v.metadata
        }))
      }
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
    const { prompt, createdBy = 'admin', metadata } = req.body;

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: 'prompt is required'
      });
    }

    console.log(`➕ Creating new version for template: ${templateId}`);

    const promptMgmt = new PromptManagementService();
    const version = await promptMgmt.createTemplateVersion(templateId, {
      prompt,
      createdBy,
      metadata
    });
    
    res.json({
      success: true,
      data: {
        _id: version._id,
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
    
    const version = await PromptVersion.findById(versionId);
    if (!version) {
      return res.status(404).json({
        success: false,
        error: 'Version not found'
      });
    }
    
    const promptMgmt = new PromptManagementService();
    await promptMgmt.activateTemplateVersion(version.templateId.toString(), versionId);
    
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
 * Delete prompt version
 * DELETE /api/generate/templates/:templateId/versions/:versionId
 */
router.delete('/templates/:templateId/versions/:versionId', async (req: Request, res: Response) => {
  try {
    const { templateId, versionId } = req.params;
    
    console.log(`🗑️ Deleting version: ${versionId} from template: ${templateId}`);
    
    const promptMgmt = new PromptManagementService();
    await promptMgmt.deleteTemplateVersion(versionId);
    
    res.json({
      success: true,
      message: 'Version deleted successfully'
    });

  } catch (error: any) {
    console.error('❌ Version deletion error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete version'
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

    console.log(`🚀 Starting content generation with database prompts for: "${seed_keyword}" (${nos_of_words})`);

    // Initialize conversational generator (uses database prompts)
    const promptManagementService = new PromptManagementService();
    const conversationalGenerator = new ConversationalAIContentGenerator(
      promptManagementService,
      true // Enable fallback to original prompts
    );

    const startTime = Date.now();

    // Generate content using conversational flow with database prompts
    const result = await conversationalGenerator.generateContent({
      apiKey: process.env.OPENAI_API_KEY,
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
      enableTracing: false
    });

    const processingTime = Date.now() - startTime;

    console.log(`✅ Content generated successfully for: "${seed_keyword}" in ${processingTime}ms`);
    console.log(`📊 Using database-driven conversational prompts`);

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
          method: 'conversational',
          generator: 'database-prompts'
        })},
        ${processingTime}
      )
      RETURNING id
    `;

    const generationId = generationRecord[0].id;

    // 🔥 DEDUCT CREDITS AFTER SUCCESSFUL GENERATION (with website_id and generation_id)
    // Truncate reason to avoid varchar(255) limit
    const truncatedKeyword = seed_keyword.substring(0, 200);
    await deductCredits(
      userId,
      'content',
      1,
      `Content generation: ${truncatedKeyword}`,
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
        meta_description: result.meta_descreption
      },
      metadata: {
        method: 'conversational',
        generator: 'database-prompts',
        processingTime
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

// POST /api/v1/generate/testWithActiveVersions
// Admin panel route: Use ConversationalAIContentGenerator with all active database prompts
router.post('/testWithActiveVersions', async (req: Request, res: Response) => {
  try {
    const {
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
      audienceData = ''
    } = req.body;

    // Validate required parameters
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

    console.log(`🎯 Admin testing with all active versions: "${seed_keyword}" (${nos_of_words})`);

    // Initialize conversational generator (uses database prompts)
    const promptManagementService = new PromptManagementService();
    const conversationalGenerator = new ConversationalAIContentGenerator(
      promptManagementService,
      true // Enable fallback to original prompts
    );

    const startTime = Date.now();

    // Generate content using conversational flow with database prompts
    const result = await conversationalGenerator.generateContent({
      apiKey: process.env.OPENAI_API_KEY,
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
      enableTracing: false
    });

    const processingTime = Date.now() - startTime;

    console.log(`✅ Admin testing completed: "${seed_keyword}"`);
    console.log(`📊 Used all active prompt versions`);

    res.json({
      success: true,
      data: {
        search_data: result.search_data,
        content: result.content,
        meta_title: result.meta_title,
        meta_description: result.meta_descreption,
        promptsUsed: {},
        generationMetadata: {
          templatesUsed: [],
          promptVersions: {},
          processingTime
        }
      }
    });

  } catch (error) {
    console.error('❌ Admin testing error:', error);
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
 * Generate content using Conversational Flow (Hybrid Approach)
 * This maintains the original PHP sequential conversational context
 * while using database-driven tunable prompts
 * 
 * POST /api/v1/generate/conversational
 */
router.post('/conversational', validateApiAccess, validateCredits('content', 1), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
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
      audienceData,
      // Testing parameters
      testVersionOverride,
      enableTracing = false
    } = req.body;

    // Validate required parameters
    if (!seed_keyword) {
      return res.status(400).json({
        success: false,
        error: 'seed_keyword is required'
      });
    }

    // Validate nos_of_words
    const validWordCounts = ['600 to 1200 words', '1200 to 2400 words', '2400 to 3600 words'];
    if (!validWordCounts.includes(nos_of_words)) {
      return res.status(400).json({
        success: false,
        error: `nos_of_words must be one of: ${validWordCounts.join(', ')}`
      });
    }

    console.log(`🔄 Starting CONVERSATIONAL generation for: "${seed_keyword}" (${nos_of_words})`);
    if (testVersionOverride) {
      console.log(`🧪 Testing version: ${testVersionOverride.promptType} = ${testVersionOverride.versionId}`);
    }

    // Initialize conversational generator
    const promptManagementService = new PromptManagementService();
    const conversationalGenerator = new ConversationalAIContentGenerator(
      promptManagementService,
      true // Enable fallback to original prompts
    );

    const startTime = Date.now();

    // Generate content using conversational flow
    const result = await conversationalGenerator.generateContent({
      apiKey: process.env.OPENAI_API_KEY,
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
      testVersionOverride,
      enableTracing
    });

    const processingTime = Date.now() - startTime;

    console.log(`✅ Conversational content generated in ${processingTime}ms`);

    // Save generation to database
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
        'content_conversational',
        'success',
        ${JSON.stringify({
          seed_keyword,
          nos_of_words,
          content_lang,
          voice_tone,
          point_of_view,
          title,
          testVersionOverride
        })},
        ${JSON.stringify({
          content: result.content,
          meta_title: result.meta_title,
          meta_description: result.meta_descreption
        })},
        ${JSON.stringify({
          method: 'conversational',
          enableTracing
        })},
        ${processingTime}
      ) RETURNING generation_id
    `.then(rows => rows[0]);

    const generationId = generationRecord.generation_id;
    console.log(`💾 Generation saved with ID: ${generationId}`);

    // Deduct credit (truncate reason to avoid varchar limit)
    const truncatedKeyword = seed_keyword.substring(0, 200);
    await deductCredits(
      userId,
      'content',
      1,
      `Conversational content: ${truncatedKeyword}`,
      websiteId,
      generationId
    );
    console.log(`💳 Credit deducted for user ${userId}`);

    res.json({
      success: true,
      data: {
        generation_id: generationId,
        search_data: result.search_data,
        content: result.content,
        meta_title: result.meta_title,
        meta_description: result.meta_descreption
      },
      metadata: {
        method: 'conversational',
        processingTime,
        testVersionUsed: testVersionOverride || null
      }
    });

  } catch (error) {
    console.error('❌ Conversational generation error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate content using conversational flow'
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
    // Truncate reason to avoid varchar(255) limit in credit_transactions table
    const truncatedTitle = (title || prompt || '').substring(0, 200);
    await deductCredits(
      userId,
      'images',
      1,
      `AI image generation: ${truncatedTitle}`,
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
      count = 30
    } = req.body;

    if (!seed_keyword || !String(seed_keyword).trim()) {
      return res.status(400).json({
        success: false,
        error: 'seed_keyword is required'
      });
    }

    const seed = String(seed_keyword).trim();
    const keywordCount = Math.min(Math.max(parseInt(count, 10) || 30, 1), 50);

    console.log(`🔍 Starting keyword generation for: "${seed}" (count=${keywordCount})`);

    const nicheLine = niche ? `\nNiche/industry context: ${niche}` : '';
    const prompt = `You are an SEO keyword research assistant. Generate exactly ${keywordCount} long-tail keyword variations that real people type into search engines for the seed keyword below. Mix informational, commercial and question-style search intents. Keep each keyword between 2 and 8 words.${nicheLine}

Seed keyword: ${seed}

Output rules: one keyword per line, lowercase, no numbering, no bullets, no quotes, no explanations or headings — just the keywords.`;

    const raw = await chat([{ role: 'user', content: prompt }]);

    // Parse one-per-line output defensively: strip bullets/numbering the model
    // may add despite instructions, drop blanks, dedupe, cap at requested count.
    const seen = new Set<string>();
    const keywords: string[] = [];
    for (const line of raw.split('\n')) {
      const kw = line.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').replace(/["'‘’“”]/g, '').trim();
      const key = kw.toLowerCase();
      if (kw && !seen.has(key)) {
        seen.add(key);
        keywords.push(kw);
      }
      if (keywords.length >= keywordCount) break;
    }

    if (keywords.length === 0) {
      // No usable output — fail without deducting credits.
      return res.status(500).json({
        success: false,
        error: 'Keyword generation returned no results. Please try again.'
      });
    }

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
          seed_keyword: seed,
          niche,
          count: keywordCount
        })},
        ${JSON.stringify({
          keywords,
          total_count: keywords.length
        })},
        ${JSON.stringify({
          provider: 'openai-chat',
          generation_time: Date.now()
        })}
      )
      RETURNING id
    `;

    const generationId = generationRecord[0].id;

    // 🔥 DEDUCT CREDITS AFTER SUCCESSFUL GENERATION (with website_id and generation_id)
    const truncatedKeyword = seed.substring(0, 200);
    await deductCredits(
      userId,
      'keywords',
      1,
      `Keyword research: ${truncatedKeyword}`,
      websiteId,
      generationId
    );

    console.log(`✅ ${keywords.length} keywords generated and saved (ID: ${generationId})`);
    console.log(`💳 1 keyword credit deducted for user ${userId}`);

    res.json({
      success: true,
      data: {
        generation_id: generationId,
        seed_keyword: seed,
        keywords,
        total_count: keywords.length
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

/**
 * Deduct Keyword Credits Only (for plugin-generated keywords)
 * POST /api/v1/generate/generatekeywordded
 *
 * This endpoint only deducts keyword credits without generating anything.
 * LEGACY: current plugin versions generate keywords server-side via /generatekeyword
 * (which deducts atomically). Kept for older plugin installs that still scrape
 * Google Suggest in the browser and report usage here.
 */
router.post('/generatekeywordded', validateApiAccess, validateCredits('keywords', 1), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      seed_keyword,
      count = 1,
      reason
    } = req.body;

    const userId = req.user.id;
    const websiteId = req.website?.id || null;

    console.log(`💳 Deducting keyword credits for plugin generation: "${seed_keyword || 'N/A'}"`);

    // � SAVE MINIMAL GENERATION RECORD (to get generation_id)
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
          seed_keyword: seed_keyword || 'Plugin-generated',
          count,
          source: 'wordpress-plugin'
        })},
        ${JSON.stringify({
          message: 'Credits deducted for plugin-generated keywords',
          count
        })},
        ${JSON.stringify({
          provider: 'wordpress-plugin',
          generation_time: new Date().toISOString()
        })}
      )
      RETURNING id
    `;

    const generationId = generationRecord[0].id;

    // 🔥 DEDUCT CREDITS (with website_id and generation_id)
    // Truncate reason to avoid varchar(255) limit
    const truncatedKeyword = (seed_keyword || 'N/A').substring(0, 200);
    const truncatedReason = (reason || `Plugin keyword: ${truncatedKeyword}`).substring(0, 240);
    await deductCredits(
      userId,
      'keywords',
      count,
      truncatedReason,
      websiteId,
      generationId
    );

    console.log(`✅ ${count} keyword credit(s) deducted for user ${userId} (Generation ID: ${generationId})`);

    res.json({
      success: true,
      data: {
        generation_id: generationId,
        credits_deducted: count,
        message: 'Keyword credits deducted successfully'
      }
    });

  } catch (error) {
    console.error('❌ Keyword credit deduction error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to deduct keyword credits'
    });
  }
});

/**
 * Generate auxiliary text (meta title, meta description, audience data).
 * No credit cost — these are small supporting GPT calls. Auth-only.
 * POST /api/v1/generate/auxiliary
 *
 * Body: { type, seed_keyword, title?, content?, audience_data?, title_type? }
 *   type:          'meta_title' | 'meta_description' | 'audience_data' | 'keyword_context' | 'title'
 *   title:         required for meta_title and meta_description
 *   content:       optional, used by meta_description for context
 *   audience_data: optional, used by 'title' to tailor the wizard title
 *   title_type:    'question' formats the 'title' output as a question (seed_option3)
 *
 * Response: { success: true, data: { type, text } }
 */
router.post('/auxiliary', validateApiAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { type, seed_keyword, title, content, audience_data, title_type } = req.body as {
      type?: string;
      seed_keyword?: string;
      title?: string;
      content?: string;
      audience_data?: string;
      title_type?: string;
    };

    if (!type) {
      return res.status(400).json({
        success: false,
        error: 'type is required (meta_title | meta_description | audience_data | title)'
      });
    }
    if (!seed_keyword) {
      return res.status(400).json({
        success: false,
        error: 'seed_keyword is required'
      });
    }

    let prompt: string;
    switch (type) {
      case 'meta_title':
        prompt = `Create an SEO optimized meta title based on the blog post title \`${title || ''}\` and the keyword \`${seed_keyword}\`. Max length of title should be 50-60 characters including spaces.`;
        break;
      case 'meta_description':
        prompt = `Create an SEO optimized meta description. Length of the description MUST be 150-160 characters including spaces (never exceed 160). Meta description is based on the blog post title \`${title || ''}\`, the keyword \`${seed_keyword}\` and the blog post content i.e. ${content || ''}.`;
        break;
      case 'audience_data':
        prompt = `Assume someone enters the keyword ${seed_keyword} into a search engine. Analyze the following characteristics: 1. [demographic information] 2. [tone preferences] 3. [reading level preference] 4. [emotional needs/pain points]. This information will be used to create content that is specifically appealing to such people. Do not give content recommendations yet. As an output, write just information for characteristics without any explanation or introduction.`;
        break;
      case 'keyword_context':
        prompt = `In a few sentences (max 500 characters not including spaces) explain what the following list of keywords is about and what their common thread is. The goal is to create a context that is relevant to all keywords in the list. Do not use the words "keyword list" or "list" in your output. Start your output with "The context is..." Keyword List: ${seed_keyword}`;
        break;
      case 'title': {
        // Wizard "Create best title / question from keyword" (seed_option2 / seed_option3).
        // title_type 'question' formats the title as a question; otherwise a regular title.
        const asQuestion = title_type === 'question';
        const questionConstraint = asQuestion ? ' Title should be formed as a question.' : '';
        prompt = `You are a content creator who creates SEO optimized titles for blog posts. You are provided a word or phrase that is searched by the reader, and the audience data of the reader, including demographic information, tone preferences, reading level preference and emotional needs/pain points. Using this information you should come up with a title that will be engaging and interesting for people who are described in the audience data and search provided word or phrase.${questionConstraint} In the title do not include emojis or hashtags. Limit characters not including spaces to 80-100. As an output, write just a title without explanation or introduction.

Now generate a SEO optimized title based on the following information:
Keyword: ${seed_keyword}
Audience data: {${audience_data || ''}}`;
        break;
      }
      default:
        return res.status(400).json({
          success: false,
          error: `Unknown type "${type}". Must be: meta_title, meta_description, audience_data, keyword_context, or title.`
        });
    }

    console.log(`✨ Auxiliary generation | type=${type} | seed_keyword="${seed_keyword.substring(0, 60)}"`);
    let text = await chat([{ role: 'user', content: prompt }]);

    // Strip quote characters — GPT routinely wraps outputs in quotes and that
    // bleeds into rendered SEO tags / context blocks downstream.
    text = text.replace(/["'‘’“”]/g, '').trim();

    // Enforce SEO meta length budgets server-side (title 50-60, description 150-160):
    // re-run the prompt when the model drifts out of range, hard-cap to max as a last resort.
    if (type === 'meta_title' || type === 'meta_description') {
      const kind = type; // narrowed to 'meta_title' | 'meta_description'
      const { min, max } = META_BOUNDS[kind];
      text = await enforceMetaLength({
        kind,
        current: text,
        regenerate: async () => {
          const strict = `${prompt}\n\nThe result MUST be STRICTLY between ${min} and ${max} characters including spaces (never exceed ${max}). Output ONLY the ${kind === 'meta_title' ? 'meta title' : 'meta description'} text, with no quotes or explanation.`;
          const retry = await chat([{ role: 'user', content: strict }]);
          return retry.replace(/["'‘’“”]/g, '').trim();
        },
        onAttempt: ({ attempt, candidate, accepted }) =>
          console.log(`ℹ️ auxiliary ${kind} retry ${attempt} — ${candidate.trim().length} chars, accepted=${accepted}`),
      });
    }

    res.json({
      success: true,
      data: { type, text }
    });
  } catch (error) {
    console.error('❌ Auxiliary generation error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate auxiliary text'
    });
  }
});

export default router;