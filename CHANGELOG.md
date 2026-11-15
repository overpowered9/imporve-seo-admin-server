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

### Completion and production-readiness pass (14–15 Nov)

Money and safety
- Charged once per click: `POST /content-v3/article` takes a `request_id`. Migration 024's `content_v3_runs` ledger claims each request before any charge, replays a finished one without charging, allows one running run per session across instances, and retries refunds that failed.
- Charges left behind by a stopped process are refunded. The ledger's housekeeping runs on every instance, v3 on or off. It sweeps runs past the deadline, refunds them, and reports refunds in an unknown state instead of paying twice. On SIGTERM, articles in progress are failed at once, so they refund within the drain window.
- Time limits per request, below the plugin's waits: article 480 s, approve 360 s (research stops early enough for the Planner), title 200 s. Retries back off with jitter, honour `Retry-After` (Perplexity too), and never retry a request the provider refused.
- The free steps (title, town check, approve) have a daily allowance per account that grows with the articles delivered that day (`CONTENT_V3_FREE_STEP_LIMITS_JSON`). `/article` is limited to 30 a minute. Keyword prefetch spends nothing unless v3 and `ISEO_V3_KEYWORD_DATA` are on; `/niches` answers only with v3 on.
- v3 needs migrations 023 and 024: while their tables are missing, `/status` says v3 is off and the v3 routes answer `v3_disabled`, so sites stay on v2.
- HTML: links the model writes are removed unless they are the CTA; source links are inserted on text nodes with parsed URLs; a final allowlist pass runs over the finished article.
- Regulated businesses stay on v2 until their niche has a disclaimer text (`409 v3_regulated_disabled`, before any charge).

Data
- JSON in the v3 tables is stored as objects (`::text::jsonb`). postgres.js 3.4.7 double-encoded `${JSON.stringify(x)}::jsonb`, which would have lost the wizard session after its second write on Postgres. This was checked against a throwaway Postgres 16 (34 checks).
- Migrations 022–024 record themselves in `schema_migrations` and export `DOWN_SQL`; `migrations:print --down` prints the reversals.
- Leave removes the unsubmitted post's history row, blanks its article text and removes the stored answer from the ledger. The rows and billing stay.

Correctness
- Word targets are calibrated per size (`CONTENT_V3_TARGET_CALIBRATION_JSON`, default 1.0 / 1.3 / 1.6). A draft that is too short gets rescaled targets on its second run. The second run is skipped when "regulated sources" is the only error and research gave fewer than 3 sources.
- Numbered titles follow the Title step's form; a typed title needs a number before a known item kind.
- The 40% rule applies only to dimensions with 3 or more options and redraws only the over-used dimension. History counts the same article type, one row per post.
- Validator:
  - fixed labels are caught with any apostrophe or extra words;
  - fuller list of back-references;
  - "questions" lists may use question headings;
  - N to N + 2 body sections for numbered H2 items;
  - the Writer must report its item count.
- Strict Writer output parser.
- The disclaimer goes before FAQ and closing, or before the closing alone.
- Stored headings leave out FAQ questions.
- Price detection no longer counts "pounds".
- With no price, the line demanding a figure is left out of the Cost guide piece.
- `/article` enforces the numbered title's minimum size; approve needs a town choice for a local business; research uses `SEARCH_DATA_COUNTRY_ISO`; failed attempts' spend is recorded.

Observability
- `run=<session key>` on the search data, DataForSEO and keyword data lines; timings on title, approve and article lines; `[content-v3] cost over ceiling` (`CONTENT_V3_COST_CEILING_USD_JSON`); `[image] run=` per image.
- Every article records its content-hash versions: interim meta prompt, niche profile, blueprint pieces.
- `GET /content-v3/admin/trail?run=` (admin): one run's ledger, generation and post rows.
- The request log keeps only the field names of v3 bodies; `cta_phone` is redacted everywhere.
- The shared prompt reader returns the newest active version.

### Not yet
- Perplexity key, model and effort; disclaimer texts; the Humanizer v1.2 thresholds; the wizard input-fields doc; doc C's size table (working values are listed in the plugin's `docs/CONTENT_V3_LEAD_REQUIREMENTS.md`).
- The image model's price in `MODEL_PRICES_JSON` (the `[image]` line shows `cost_usd=null` until then); keyword data fetched in parallel with search data and research (a latency improvement).
