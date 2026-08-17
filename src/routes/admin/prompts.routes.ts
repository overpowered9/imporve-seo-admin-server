import { Router, Request, Response } from 'express';
import { PromptManagementService } from '../../services/prompt-management.service.js';
// Real admin auth. This replaces a local placeholder that set a mock admin id and called next()
// unconditionally, which left this whole router — and the credit-granting routes mounted beside
// it — open to anyone. The router is ALSO mounted behind requireAdmin in index.ts; that mount is
// the actual guarantee, and requireAdmin short-circuits when it has already run, so listing it
// per-route below costs nothing and keeps the intent visible at each call site.
import { requireAdmin } from '../../middleware/adminAuth.middleware.js';

const router = Router();

// Initialize service (assumes MongoDB connection is already established)
const promptService = new PromptManagementService();

// ===== SIMPLIFIED ADMIN ROUTES FOR FOCUSED APPROACH =====
// Note: Complex prompt set management is disabled for focused approach
// We only need: templates (read-only), version management, and testing

// ===== SYSTEM TEMPLATES (READ-ONLY) =====

/**
 * GET /admin/prompt-templates
 * Get all prompt templates (read-only for focused approach)
 */
router.get('/prompt-templates', requireAdmin, async (req, res) => {
  try {
    const templates = await promptService.getAllTemplates();
    res.json({ 
      success: true, 
      data: templates,
      message: `Found ${templates.length} prompt templates`
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to fetch templates' 
    });
  }
});

// ===== UTILITY ENDPOINTS =====

/**
 * GET /admin/prompts/:templateType
 * Get a specific prompt by template type (for testing)
 */
router.get('/prompts/:templateType', requireAdmin, async (req, res) => {
  try {
    const { templateType } = req.params;
    const prompt = await promptService.getPrompt(templateType);
    
    res.json({ 
      success: true, 
      data: { 
        templateType, 
        prompt 
      },
      message: `Retrieved prompt for ${templateType}`
    });
  } catch (error) {
    res.status(404).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Prompt not found' 
    });
  }
});

/**
 * POST /admin/prompts/test-variables
 * Test prompt variable processing
 */
router.post('/prompts/test-variables', requireAdmin, async (req, res) => {
  try {
    const { prompt, variables } = req.body;

    if (!prompt || !variables) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: prompt, variables'
      });
    }

    const processedPrompt = promptService.processPromptVariables(prompt, variables);
    const extractedVariables = promptService.extractVariables(prompt);

    res.json({ 
      success: true, 
      data: {
        originalPrompt: prompt,
        processedPrompt,
        variables: extractedVariables,
        providedVariables: variables
      },
      message: 'Variable processing test completed'
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Variable processing failed' 
    });
  }
});

/**
 * GET /admin/prompts/health
 * Health check for prompt management system (simplified)
 */
router.get('/prompts/health', requireAdmin, async (req, res) => {
  try {
    const templates = await promptService.getAllTemplates();

    res.json({
      success: true,
      data: {
        totalTemplates: templates.length,
        systemTemplates: templates.filter(t => t.isSystem).length
      },
      message: 'Prompt management system is healthy'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Health check failed'
    });
  }
});

// ===== VERSION MANAGEMENT =====

/**
 * GET /admin/prompt-templates/:templateId/versions
 * Get all versions for a specific template
 */
router.get('/prompt-templates/:templateId/versions', requireAdmin, async (req, res) => {
  try {
    const { templateId } = req.params;
    const versions = await promptService.getTemplateVersions(templateId);
    
    res.json({
      success: true,
      data: versions,
      message: `Found ${versions.length} versions for template`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch versions'
    });
  }
});

/**
 * POST /admin/prompt-templates/:templateId/versions
 * Create a new version for a template
 */
router.post('/prompt-templates/:templateId/versions', requireAdmin, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { prompt, notes, expectedOutput } = req.body;
    
    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: 'Prompt content is required'
      });
    }

    const newVersion = await promptService.createTemplateVersion(templateId, {
      prompt,
      createdBy: (req as any).adminId,
      metadata: {
        notes,
        expectedOutput
      }
    });
    
    res.status(201).json({
      success: true,
      data: newVersion,
      message: 'New version created successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create version'
    });
  }
});

/**
 * PUT /admin/prompt-templates/:templateId/versions/:versionId/activate
 * Activate a specific version (deactivates others)
 */
router.put('/prompt-templates/:templateId/versions/:versionId/activate', requireAdmin, async (req, res) => {
  try {
    const { templateId, versionId } = req.params;
    
    const activatedVersion = await promptService.activateTemplateVersion(templateId, versionId);
    
    res.json({
      success: true,
      data: activatedVersion,
      message: 'Version activated successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to activate version'
    });
  }
});

/**
 * GET /admin/prompt-templates/:templateId/versions/:versionId
 * Get specific version details
 */
router.get('/prompt-templates/:templateId/versions/:versionId', requireAdmin, async (req, res) => {
  try {
    const { versionId } = req.params;
    const version = await promptService.getVersionById(versionId);
    
    if (!version) {
      return res.status(404).json({
        success: false,
        error: 'Version not found'
      });
    }
    
    res.json({
      success: true,
      data: version,
      message: 'Version retrieved successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch version'
    });
  }
});

/**
 * DELETE /admin/prompt-templates/:templateId/versions/:versionId
 * Delete a specific version (cannot delete active version)
 */
router.delete('/prompt-templates/:templateId/versions/:versionId', requireAdmin, async (req, res) => {
  try {
    const { versionId } = req.params;
    
    await promptService.deleteTemplateVersion(versionId);
    
    res.json({
      success: true,
      message: 'Version deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete version'
    });
  }
});

export default router;