import express from 'express';
import dotenv from 'dotenv';
import { router as v1 } from './routes/v1.js';
import { errorHandler } from './utils/error-handler.js';
import { connectToDatabase } from './config/database.js';
import adminPromptRoutes from './routes/admin/prompts.routes.js';
import generationsRoutes from './routes/generations.routes.js';

dotenv.config();

const app = express();

// CORS middleware - allow requests from React frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || 'http://localhost:5173');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

app.use(express.json({ limit: '1mb' }));

// ===== ROUTES CONFIGURATION =====
// Primary AI generation endpoints
app.use('/api/v1', v1);

// Generation history management
app.use('/api/v1/generations', generationsRoutes);

// Simplified admin interface for prompt management (focused approach)
// Features: Read-only templates, version management, testing utilities
// Supports 12 fixed template types with version control
app.use('/api/admin', adminPromptRoutes);

// Root health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'improveseo-ai-server',
    features: [
      'AI Content Generation',
      'MongoDB Prompt Management',
      'Template Version Control'
    ],
    timestamp: new Date().toISOString()
  });
});

app.use(errorHandler);

const port = Number(process.env.PORT || 8080);

// Initialize database and start server
async function startServer() {
  try {
    // Connect to MongoDB
    await connectToDatabase();
    
    // Start Express server
    app.listen(port, () => {
      console.log(`[improveseo-ai-server] listening on http://localhost:${port}`);
      console.log(`🚀 Server ready with focused prompt management system`);
      console.log(`📋 Admin Panel: http://localhost:${port}/api/admin/prompts/health`);
      console.log(`🔧 Features: 12 fixed templates + version management`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
