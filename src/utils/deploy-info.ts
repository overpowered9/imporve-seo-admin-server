/**
 * What GET /health reports — including WHICH code is running.
 *
 * Added after keyword lists went free (c2a29a4 / d6cc207) and the live server kept charging for
 * them: the fix was on the branches, but nobody could tell which branch or commit Render was
 * actually serving. Render sets RENDER_GIT_BRANCH and RENDER_GIT_COMMIT on every Git-backed deploy,
 * so echoing them here answers "is it live?" with one unauthenticated curl.
 *
 * Both are null outside Render (local runs, tests). A /health response with no `deploy` block at
 * all means the running build predates this file — i.e. a branch without these commits.
 *
 * `keyword_lists: 'free'` is a behaviour flag for the same question: a build that still charges
 * for keyword generation cannot report it.
 */

export interface DeployInfo {
  commit: string | null;
  branch: string | null;
}

/** The deploy identity Render injected, or nulls when not running on Render. */
export function deployInfo(env: NodeJS.ProcessEnv = process.env): DeployInfo {
  const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
  return {
    commit: clean(env.RENDER_GIT_COMMIT),
    branch: clean(env.RENDER_GIT_BRANCH),
  };
}

/** The GET /health body. `env` and `now` are parameters so tests need not mutate globals. */
export function healthPayload(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()) {
  return {
    status: 'healthy',
    service: 'improveseo-ai-server',
    features: [
      'AI Content Generation',
      'User Management',
      'Website Management',
      'Credit System',
      'MongoDB Prompt Management',
      'Template Version Control',
    ],
    deploy: deployInfo(env),
    keyword_lists: 'free' as const,
    timestamp: now.toISOString(),
  };
}
