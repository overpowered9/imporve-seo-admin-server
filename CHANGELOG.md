# Changelog

## Unreleased — Content v3 (branch `feature/content-v3`)

Everything below is off until `CONTENT_V3_ENABLED=true` and a site switches "Use Content v3" on; v2 is unchanged. Operator runbook: `docs/CONTENT_V3.md`.

### Added
- Switches and status: `CONTENT_V3_ENABLED`, `GET /api/v1/content-v3/status`, per-step timeouts and attempts.
- One model-call wrapper for every v3 step: hard timeout per attempt, up to 3 attempts, one `[model-call]` log line per attempt (tokens, cache, cost, latency, prompt version with a hash of the exact text), a per-article cost line.
- Prompt registry: version labels, a `pre-v3` backup of every replaced prompt, `POST /content-v3/prompts/seed?mode=replace`, `GET /content-v3/prompts/check`, atomic activation.
- Migration 023: wizard sessions (reused by Regenerate, deleted on Leave, 7-day expiry) and post history (blueprint picks, fingerprint, headings, checks).
- Search data lookup on DataForSEO Google SERP: town call, national call only when thin, town resolution on DataForSEO's location list.
- Research on the Perplexity Agent API with a competitor filter, location, source mapping and caps (needs `PERPLEXITY_API_KEY`).
- Wizard steps: `/content-v3/wizard/title`, `/wizard/town-check`, `/wizard/approve` (title check → research → planner → regulated check), `/content-v3/niches`.
- Niche profiles (8 profiles, the niche list, proof levels, watchlists) and the regulated topics list as editable settings.
- Blueprint draft 1 built by code (draws, history checks, word targets, numbered titles) with a model-free preview for the tester.
- Writer draft 2 (core + six rules blocks, cached), post-processing (HTML allowlist, source links, TOC, disclaimer slot, FAQ from HTML), the validator with one repair run, interim meta.
- `POST /content-v3/article`: paid exactly like v2 (reserve, refund on failure, regeneration from history), refused while one is running for the same session.
- `npm run v3:ten-keywords`: the full chain for the keyword list in `docs/content-v3-test-keywords.json`, with a review sheet.

### Changed
- `/content-v3/article/test` (admin) runs the new chain with the tester's blueprint pins.
- The v2 article row records the writing model (BUG3).
- The version route keeps the admin panel's version name (it was dropped).
- `/api/v1/generations` (the admin tester's saved generations) requires an admin token; it was open to anyone.
- The keyword-data Title and Planner prompts are the V1 text byte for byte plus one appended KEYWORD DATA block; the Planner block adds one sentence naming its two extra JSON fields (C6, approved 14 Nov).

### Fixed by the 10-keyword runs
- The Writer added a second summary (takeaways after a quick answer, or the reverse): the code-built SUMMARY line now says it is the only summary.
- "Larger than suggested" articles landed just under their range: step 3m aims a quarter into the range.
- The keyword check accepts the closest natural wording (contractions, -ing / -ed forms).
- The blueprint asked for more body sections than the Planner had questions, so the Writer dropped one and fell short: the count now stops at the number of questions (never below the size's minimum).
- An honest empty FAQ list (no People Also Ask questions) cost three Planner attempts and then the bare fallback plan: the 1-FAQ minimum now applies only when there were real questions to use.
- `npm run v3:ten-keywords -- --keyword-data` runs the list with keyword data on as well; `--render <off>,<on>` builds one sheet with both.

### Not yet
- Perplexity key, model and effort; disclaimer texts; the Humanizer v1.2 thresholds; the wizard input-fields doc; doc C's size table (working values are noted in the plugin's `docs/CONTENT_V3_PROGRESS.md`).
