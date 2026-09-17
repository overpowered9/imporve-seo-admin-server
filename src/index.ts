import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { router as v1 } from './routes/v1.js';
import { errorHandler } from './utils/error-handler.js';
import { connectToDatabase } from './config/database.js';
import adminPromptRoutes from './routes/admin/prompts.routes.js';
import { requireAdmin } from './middleware/adminAuth.middleware.js';
import { logCreditsConfigFingerprint } from './config/credits.config.js';
import { startPlanCreditSync } from './services/billing/plan-credit-sync.js';
import generationsRoutes from './routes/generations.routes.js';
import { testConnection } from './data/db.js';
import { startTrialEmailScheduler } from './services/trial-emails.service.js';
// BILL-007/008 — replaces lifecycle-emails.service.ts, which sent inline and
// had no dry-run, no lead-time config and no shared runner. That module is left
// in place but is no longer started; see notification-jobs.ts.
import { startNotificationScheduler } from './services/billing/notification-jobs.js';
import { startLedgerMonitor } from './services/billing/ledger-monitor.js';
import { startEmailWorker } from './services/billing/email-worker.js';
import sql from './data/db.js';

dotenv.config();

const app = express();

// Render terminates TLS at a single proxy hop and passes the caller's address in
// X-Forwarded-For. Without this, req.ip is the proxy's address for every request, which would
// collapse the per-IP login rate limiter into one shared bucket — letting any one caller
// exhaust it and lock every operator out of the admin panel.
app.set('trust proxy', 1);

// CORS configuration - Allow all origins for API access
const corsOptions = {
  origin: true, // Allow all origins
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'x-api-key', 'x-site-code', 'x-site-domain'],
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

// Debug middleware to log requests.
//
// Bodies are redacted before logging. This previously printed req.body verbatim, which wrote
// every customer's plaintext password to the logs on each /auth/login and /auth/signup, and
// would now do the same for the admin password. Anyone with log access had the credentials.
const REDACTED_KEYS = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'apiKey',
]);

function redactBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key) ? '[redacted]' : value;
  }
  return out;
}

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`, redactBody(req.body));
  next();
});

// ===== ROUTES CONFIGURATION =====
app.use('/api/v1', v1);
app.use('/api/v1/generations', generationsRoutes);
// requireAdmin is applied at the MOUNT rather than inside prompts.routes.ts so that a route added
// to that router later cannot ship unprotected by someone forgetting a per-route guard. This mount
// previously had no auth at all, and the router's own `requireAdmin` was a stub calling next().
app.use('/api/admin', requireAdmin, adminPromptRoutes);

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

    // Record WHICH price table this process is running. One hash line, not a price list — the
    // values are integrity-sensitive and must not be printed. credits.config.ts has already
    // thrown at import if any price was missing or malformed, so reaching here means it is valid.
    logCreditsConfigFingerprint();

    // subscription_plans.*_credits are derived from the env grants now. Best-effort refresh so the
    // Stripe checkout descriptions and CMS plan tables that still read those columns stay truthful.
    await startPlanCreditSync();

    // Start the trial-email drip scheduler (no-op unless TRIAL_EMAILS_ENABLED=true)
    startTrialEmailScheduler();

    // Credit-expiry + inactivity notifications (BILL-007, BILL-008).
    // No-op unless LIFECYCLE_EMAILS_ENABLED=true, so this changes nothing until
    // the copy is final and it is deliberately switched on.
    startNotificationScheduler(sql);

    // BILL-004 — alert when a billing event completes without a ledger row.
    // No-op unless LEDGER_MONITOR_ENABLED=true, so it cannot start alarming
    // before the backfill has run.
    startLedgerMonitor(sql);

    // BILL-006 — the outbox worker, ON by default. The ticket's complaint is
    // that no email is sent on upgrade or cancellation, so shipping it switched
    // off would relocate the bug rather than fix it. Set
    // BILLING_EMAILS_ENABLED=false to halt delivery; jobs keep queueing.
    startEmailWorker(sql);

    // Start Express server
    const server = app.listen(port, () => {
      console.log(`[improveseo-ai-server] listening on http://localhost:${port}`);
      console.log(`🚀 Server ready with user management system`);
      console.log(`📋 Admin Panel: http://localhost:${port}/api/admin/prompts/health`);
      console.log(`🔧 Features: Authentication + Website Management + Credit System`);
      console.log(`🧪 Test signup: POST ${port}/api/v1/auth/signup`);
    });

    // ── Keep-alive timeout tuning (prevents intermittent 502 / ECONNRESET) ─────
    // Cloud load balancers (Render, ELB, etc.) keep upstream connections idle for
    // ~60s. Node's default keepAliveTimeout is only 5s, so Node can close a socket
    // the LB still believes is open; the next request the LB sends on that dead
    // socket fails with a 502/connection reset. Setting our timeouts ABOVE the LB's
    // idle window guarantees the LB always closes first. headersTimeout must be
    // greater than keepAliveTimeout.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    // Cap total request duration so a stuck client/socket can't hold a connection
    // open forever (0 = disabled by default in Node).
    server.requestTimeout = 120_000;

    // ── Graceful shutdown ──────────────────────────────────────────────────────
    // Render sends SIGTERM on every deploy. Without draining, in-flight logins are
    // killed mid-request and users see connection errors during each deploy.
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n${signal} received — draining connections…`);
      server.close((err) => {
        if (err) {
          console.error('Error during server close:', err);
          process.exit(1);
        }
        console.log('✅ All connections drained. Exiting.');
        process.exit(0);
      });
      // Hard limit: don't hang the platform's shutdown forever.
      setTimeout(() => {
        console.error('⏱️  Drain timeout — forcing exit.');
        process.exit(1);
      }, 25_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();