import { Router, Request, Response } from 'express';
import Generation, { IGeneration } from '../models/generation.models.js';

const router = Router();

// POST /api/v1/generations - Save a generation result
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      type,
      parameters,
      result,
      metadata,
      testingInfo,
      status,
      error,
      userId,
      sessionId
    } = req.body;

    // Basic validation
    if (!type || !['active', 'testing'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Type must be active or testing'
      });
    }

    if (!parameters?.seed_keyword) {
      return res.status(400).json({
        success: false,
        error: 'Seed keyword is required'
      });
    }

    if (!status || !['success', 'error'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Status must be success or error'
      });
    }

    // Create new generation document
    const generation = new Generation({
      type,
      parameters,
      result,
      metadata,
      testingInfo,
      status,
      error,
      userId,
      sessionId: sessionId || `session_${Date.now()}_${Math.random().toString(36).substring(2)}`
    });

    const savedGeneration = await generation.save();

    res.status(201).json({
      success: true,
      data: savedGeneration,
      message: 'Generation saved successfully'
    });

  } catch (error: any) {
    console.error('Error saving generation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save generation',
      details: error.message
    });
  }
});

// GET /api/v1/generations - Get generation history with filtering and pagination
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const type = req.query.type as string;
    const status = req.query.status as string;
    const search = req.query.search as string;
    const userId = req.query.userId as string;
    const sessionId = req.query.sessionId as string;

    // Build filter object
    const filter: any = {};
    
    if (type && ['active', 'testing'].includes(type)) filter.type = type;
    if (status && ['success', 'error'].includes(status)) filter.status = status;
    if (userId) filter.userId = userId;
    if (sessionId) filter.sessionId = sessionId;
    
    // Add text search if provided
    if (search) {
      filter.$or = [
        { 'parameters.seed_keyword': { $regex: search, $options: 'i' } },
        { 'result.meta_title': { $regex: search, $options: 'i' } },
        { 'result.content': { $regex: search, $options: 'i' } }
      ];
    }

    // Calculate skip value for pagination
    const skip = (page - 1) * limit;

    // Execute query with pagination
    const [generations, totalCount] = await Promise.all([
      Generation.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Generation.countDocuments(filter)
    ]);

    // Calculate pagination info
    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    res.json({
      success: true,
      data: generations,
      pagination: {
        currentPage: page,
        totalPages,
        totalCount,
        limit,
        hasNextPage,
        hasPrevPage
      }
    });

  } catch (error: any) {
    console.error('Error fetching generations:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch generations',
      details: error.message
    });
  }
});

// GET /api/v1/generations/:id - Get a specific generation by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const generation = await Generation.findById(id);

    if (!generation) {
      return res.status(404).json({
        success: false,
        error: 'Generation not found'
      });
    }

    res.json({
      success: true,
      data: generation
    });

  } catch (error: any) {
    console.error('Error fetching generation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch generation',
      details: error.message
    });
  }
});

// DELETE /api/v1/generations/:id - Delete a specific generation
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const generation = await Generation.findByIdAndDelete(id);

    if (!generation) {
      return res.status(404).json({
        success: false,
        error: 'Generation not found'
      });
    }

    res.json({
      success: true,
      message: 'Generation deleted successfully'
    });

  } catch (error: any) {
    console.error('Error deleting generation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete generation',
      details: error.message
    });
  }
});

// GET /api/v1/generations/stats/overview - Get generation statistics
router.get('/stats/overview', async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    const sessionId = req.query.sessionId as string;

    // Build filter for user/session
    const filter: any = {};
    if (userId) filter.userId = userId;
    if (sessionId) filter.sessionId = sessionId;

    const stats = await Generation.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalGenerations: { $sum: 1 },
          successfulGenerations: {
            $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] }
          },
          failedGenerations: {
            $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] }
          },
          testingRuns: {
            $sum: { $cond: [{ $eq: ['$type', 'testing'] }, 1, 0] }
          },
          activeRuns: {
            $sum: { $cond: [{ $eq: ['$type', 'active'] }, 1, 0] }
          },
          averageProcessingTime: { $avg: '$metadata.processingTime' }
        }
      }
    ]);

    const result = stats[0] || {
      totalGenerations: 0,
      successfulGenerations: 0,
      failedGenerations: 0,
      testingRuns: 0,
      activeRuns: 0,
      averageProcessingTime: 0
    };

    res.json({
      success: true,
      data: result
    });

  } catch (error: any) {
    console.error('Error fetching generation stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch generation statistics',
      details: error.message
    });
  }
});

export default router;