/**
 * Live wiring for the v3 Title and Planner step routes (handler: content-v3-steps.handler.ts),
 * mounted from content-v3.routes.ts at its root:
 *
 *   POST /api/v1/content-v3/title     requireAdmin
 *   POST /api/v1/content-v3/planner   requireAdmin
 */
import { Router } from 'express';
import { requireAdmin } from '../middleware/adminAuth.middleware.js';
import { runTitleStep } from '../services/content-v3-steps/title.step.js';
import { runPlannerStep } from '../services/content-v3-steps/planner.step.js';
import { liveTitleDeps, livePlannerDeps } from '../services/content-v3-steps/steps.default.js';
import { createContentV3StepsRouter } from './content-v3-steps.handler.js';

const router = Router();

router.use(
  '/',
  createContentV3StepsRouter({
    auth: requireAdmin,
    runTitle: (input) => runTitleStep(input, liveTitleDeps()),
    runPlanner: (input) => runPlannerStep(input, livePlannerDeps()),
  }),
);

export default router;
