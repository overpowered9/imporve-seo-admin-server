/**
 * Live wiring for the A/B harness: real step dependencies, the shared keyword data service, and
 * files under <cwd>/data/ab-tests/ (git-ignored, not served).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { getKeywordDataService } from '../keyword-data/keyword-data.default.js';
import { livePlannerDeps, liveTitleDeps } from '../content-v3-steps/steps.default.js';
import { runKeywordDataAbTest, type AbRunInput, type AbRunResult } from './keyword-data-ab.js';

export const AB_OUT_DIR = path.join(process.cwd(), 'data', 'ab-tests');

async function writeFileSafe(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

export function runLiveKeywordDataAbTest(input: AbRunInput, options: { save?: boolean } = {}): Promise<AbRunResult> {
  return runKeywordDataAbTest(input, {
    titleDeps: liveTitleDeps(),
    plannerDeps: livePlannerDeps(),
    keywordData: getKeywordDataService(),
    outDir: options.save === false ? null : AB_OUT_DIR,
    writeFile: writeFileSafe,
  });
}
