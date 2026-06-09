import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export const config = {
  port: process.env.PORT || 3001,
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/improveseo',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
  fluxAiApiKey: process.env.FLUX_AI_API_KEY || '',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV || 'development'
};

// Validate required environment variables
if (!config.openaiApiKey) {
  console.warn('⚠️  OPENAI_API_KEY is not set. Content generation will fail.');
}

if (!config.fluxAiApiKey) {
  console.warn('⚠️  FLUX_AI_API_KEY is not set. Image generation will fail.');
}

if (!config.stripeSecretKey && config.nodeEnv === 'production') {
  console.warn('⚠️  STRIPE_SECRET_KEY is not set. Payment processing will fail.');
}

if (!config.mongoUri) {
  console.error('❌ MONGODB_URI is required');
  process.exit(1);
}