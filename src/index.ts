import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { router as v1 } from './routes/v1.js';
import { errorHandler } from './utils/error-handler.js';
import { connectToDatabase } from './config/database.js';
import adminPromptRoutes from './routes/admin/prompts.routes.js';
import generationsRoutes from './routes/generations.routes.js';
import { testConnection } from './data/db.js';

dotenv.config();

const app = express();

// CORS configuration - Allow all origins for API access
const corsOptions = {
  origin: true, // Allow all origins
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'x-api-key', 'x-site-code'],
  credentials: true
};

app.use(cors(corsOptions));

// Stripe webhook route MUST receive raw body for signature verification
// This MUST come BEFORE express.json() middleware
app.use('/api/v1/stripe/webhook', express.raw({ type: 'application/json' }));

// Body parsing middleware - MUST come before routes (but after webhook raw body)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Debug middleware to log requests
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`, req.body);
  next();
});

// ===== ROUTES CONFIGURATION =====
app.use('/api/v1', v1);
app.use('/api/v1/generations', generationsRoutes);
app.use('/api/admin', adminPromptRoutes);

// Root health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'improveseo-ai-server',
    features: [
      'AI Content Generation',
      'User Management',
      'Website Management',
      'Credit System',
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
     // Test PostgreSQL connection first
    const pgConnected = await testConnection();
    if (!pgConnected) {
      console.error('❌ Cannot start server without PostgreSQL connection');
      process.exit(1);
    }
    // Connect to MongoDB
    await connectToDatabase();
    
    // Start Express server
    app.listen(port, () => {
      console.log(`[improveseo-ai-server] listening on http://localhost:${port}`);
      console.log(`🚀 Server ready with user management system`);
      console.log(`📋 Admin Panel: http://localhost:${port}/api/admin/prompts/health`);
      console.log(`🔧 Features: Authentication + Website Management + Credit System`);
      console.log(`🧪 Test signup: POST ${port}/api/v1/auth/signup`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();