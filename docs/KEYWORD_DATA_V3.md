# Keyword data (DataForSEO Labs) and the Content v3 Title / Planner steps

Branch `feature/keyword-data-v3`, built 2026-11-11 from `main` (`571cb62`). Five phase commits plus this report.

Two approved features:

- **Option A** — a keyword metrics API (`POST /api/v1/generate/keywords/metrics`) so the plugin's keyword tool can show real search volume, difficulty and intent.
- **Option B** — behind a flag, keyword data feeds the Content v3 **Title** and **Planner** steps. It never reaches the Writer (Option C, rejected), and tests enforce that.

Version 1 is **national data only**, from **DataForSEO Labs endpoints only** (keyword overview, related keywords, search intent). No Google Ads / Keywords Data endpoints are called; the client refuses any path outside `/dataforseo_labs/`.

## Contents

- [Phase 0: what the code looked like](#phase-0-what-the-code-looked-like)
- [What was built, per phase](#what-was-built-per-phase)
- [New env vars and config](#new-env-vars-and-config)
- [How to run locally](#how-to-run-locally)
- [Toggling the flag](#toggling-the-flag)
- [Endpoints and curl examples](#endpoints-and-curl-examples)
- [How to run the A/B harness](#how-to-run-the-ab-harness)
- [Tests and acceptance criteria](#tests-and-acceptance-criteria)
- [Known limitations](#known-limitations)
- [Open decisions](#open-decisions)

## Phase 0: what the code looked like

Read-only survey before any code (file:line as of `main` at `571cb62`).

| Item | Finding |
|---|---|
| Existing keyword endpoint | `src/routes/generation.routes.ts:1193` `POST /generate/generatekeyword`, plugin auth (`validateApiAccess`), free, per-day allowance. Untouched. |
| DataForSEO usage | None anywhere in `src/`. |
| v3 routes | Only `POST /content-v3/article/test` (`src/routes/content-v3.routes.ts:161`) and `POST /content-v3/prompts/seed` (`:208`), both admin-only. |
| Title step | **Did not exist.** The title was a caller-supplied field (`claude-content-generator-v3.service.ts:90`). |
| Planner step | **Did not exist.** The code still ran the audience/LSI "intelligence" prompt (`:739-764`) that the design doc says the Planner replaces. |
| Research step | Did not exist. |
| Design doc | `docs/content-v3-prompt-drafts.md` is **not in the repo** (`*.md` is git-ignored except named files); the copy used is `~/Downloads/content-v3-prompt-drafts.md`. |
| Research report | **Not found** anywhere on the machine, so "list what in the research report no longer matches the code" could not be done. |

Decided with the project owner on 2026-11-11: build the Title and Planner steps from the design doc as new admin-only v3 routes, with `search_data` and `research` as optional request inputs (the SERP lookup and the Perplexity research step are not built); return the contract shape plus `success: true`; create `.env.example`; prefetch is plugin-authenticated, Title/Planner/A-B are admin-only.

**Design doc vs code, as found:** the Planner had not replaced `content_v3_intelligence`; the Writer in code is the older `===META_JSON===` draft, not draft 2; no Title step or SERP lookup; no research step; the blueprint is still the v2-era one (pull quote accent, woven FAQ).

## What was built, per phase

### Phase 1 — DataForSEO client (`71029f4`)

- `src/services/keyword-data/dataforseo.client.ts` — one shared client. Basic auth from caller-supplied credentials, 8 s timeout (AbortController on global fetch), **one retry with backoff on network errors and 5xx / DataForSEO 5xxxx**. A timeout is *not* retried: the Title/Planner steps run the client under an 8 s overall budget and a retry after an 8 s wait would double it. HTTP and task-level status codes map to a closed set of error kinds (`auth`, `payment`, `rate_limit`, `bad_request`, `server`, `network`, `timeout`, `task_error`). Every call logs `[dataforseo] endpoint=… http=… status=… latency_ms=… cost=…`; credentials never appear in logs or error messages. `assertLabsPath` refuses any non-Labs path.
- Tests: `dataforseo.client.test.ts` (injected fetch): success, timeout, 5xx-then-retry, network retry, task error, auth error, malformed body, Labs-only guarantee.

### Phase 2 — service, cache, block (`f5452ea`)

- `src/config/keyword-data.config.ts` — credentials, flag, credit cost, and the product constants (`KEYWORD_DATA_DEFAULTS`).
- `src/services/keyword-data/keyword-data.types.ts` — the contract item; `normalizeKeyword` (trim, collapse whitespace, lower-case).
- `src/services/keyword-data/normalize.ts` — DataForSEO item → contract item. **Missing values become `null`, never 0**; a real 0 stays 0; difficulty clamped 0–100; intent mapped to the four contract values.
- `src/migrations/022-keyword-data-cache.ts` — two Postgres tables, RLS on, idempotent: `keyword_metrics_cache` (per keyword) and `keyword_related_cache` (per seed, JSONB list). Key `(keyword lower-cased and trimmed, location_code, language_code)`, 30-day TTL via `expires_at`. Registered in `print-migrations.ts` and as `npm run migrate:keyword-data-cache`.
- `src/services/keyword-data/keyword-data-cache.ts` — reads filter `expires_at > NOW()`, writes upsert on the primary key. **Fails open**: a missing table or an outage is a miss plus one `[keyword-data] cache unavailable` log line.
- `src/services/keyword-data/keyword-data.service.ts` — `getMetrics` (dedupe, cache first, one batched Labs call for the misses, upsert, request order), `getSeedWithRelated` (seed + 30 related, two calls in parallel under a budget; a late answer still fills the cache), `tryGetForPrompt` (block or `null`, never throws, logs `[keyword-data] fallback step=… reason=…`).
- `src/services/keyword-data/keyword-data-block.ts` — `buildKeywordDataBlock(seed, related, limit)`: related sorted by volume descending (unknown last), seed duplicates removed, missing fields omitted, limit applied after sorting (10 Title / 30 Planner).
- `src/services/keyword-data/keyword-data.default.ts` — the live singleton (real client from env, real `sql` cache).
- Tests: normalisation and null handling; cache hit/miss/expiry/upsert against `fake-sql`; service batching, fallbacks, budget; block formatting and limits.

### Phase 3 — endpoints (`43c93f7`)

- `POST /api/v1/generate/keywords/metrics` — `src/routes/keyword-metrics.handler.ts` (pure, dependency-injected) + `keyword-metrics.routes.ts` (live wiring), mounted from `generation.routes.ts` beside `/generatekeyword`. Plugin auth, zod validation to the contract, per-account rate limit 30/min. Credits: `KEYWORD_METRICS_CREDIT_COST` (default 0); when > 0 the v2 `reserveCredits` / `refundCredits` pair is used. No `user_generations` row is written (the live table's `type` constraint is unverified).
- `POST /api/v1/content-v3/keyword-data/prefetch` — `content-v3-keyword-data.handler.ts` + `.routes.ts`, mounted from `content-v3.routes.ts`. Plugin auth, 30/min. Never fails the caller for a provider problem: `status: "unavailable"` with a `reason`.
- `src/middleware/rateLimit.middleware.ts` — additive `keyPrefix` option. The limiter's buckets are shared across instances and keyed by user id alone, so a second per-user limiter would otherwise count `/auxiliary`'s calls. Default behaviour unchanged.
- `src/test/helpers/http-app.ts` — mounts a router on a real HTTP server for route tests.
- Tests: auth, every validation rule, cached vs uncached bodies, provider error mapping, credits 0 / >0 / short / refund, 429; prefetch ready/unavailable; source assertions on the live wiring.

### Phase 4 — Title and Planner steps, Option B (`297c6b5`)

- `src/services/content-v3-steps/prompts.ts` — **generated from the design doc's fenced blocks**, so `TITLE_SYSTEM_V1` and `PLANNER_SYSTEM_V1` are PROMPT 1 and PROMPT 3 byte for byte (hash-pinned in `prompts.test.ts`). `TITLE_SYSTEM_V2_KEYWORD_DATA` and `PLANNER_SYSTEM_V2_KEYWORD_DATA` are V1 plus exactly the contract's rules (and, for the Planner, `demand_notes` / `overlap` in the OUTPUT JSON); the test proves that subtracting the additions gives V1 back. Four DB-tunable templates (`content_v3_title`, `content_v3_title_keyword_data`, `content_v3_planner`, `content_v3_planner_keyword_data`) are seeded by the existing `POST /content-v3/prompts/seed`, so the old prompt stays selectable and editable.
- `xml.ts` (data tags, left out when empty, values escaped), `attempts.ts` (the doc's up-to-3-attempts rule), `recent-posts.ts` (code-side selection), `step-common.ts` (the keyword-data decision), `title.step.ts`, `planner.step.ts`, `steps.default.ts` (live deps: Claude with the system block cached and thinking off; Title on the writing model, Planner on the low-cost model).
- `POST /api/v1/content-v3/title` and `POST /api/v1/content-v3/planner` — `src/routes/content-v3-steps.handler.ts` + `.routes.ts`, admin-only. zod strips unknown keys, so nothing keyword-shaped can be smuggled in; the only keyword numbers a prompt ever sees come from the server.
- `src/models/prompt.models.ts` (four template types added to both the union and the enum) and `src/services/prompt-seed.v3.ts` (seeds the step prompts too).
- **Option B semantics.** Effective only when `ISEO_V3_KEYWORD_DATA === "true"` **and** the request sends `use_keyword_data: true` (a boolean). Then the cache is read; on a miss DataForSEO is fetched under an 8 s budget. If data arrives, the V2 template is used and `<keyword_data>` (10 related for Title, 30 for Planner) goes into the **user** message; the Planner also gets `<recent_posts>`, chosen in code (Jaccard word overlap with seed + title ≥ 0.2, top 5 of at most 20). On timeout, provider failure, missing credentials or no data: V1 prompt, no block, no recent posts — tests prove the payload is byte-identical to a flag-off request — and the fallback is logged.
- **Code validation.** Title: ≤ 70 characters, valid form, numbered form needs items within `max_list_items`. Planner: article type, size not below `minimum_size`, ≤ 9 body questions, 0–5 FAQ none repeating a body question, ≤ 2 owner questions; with V2 also `demand_notes` (string ≤ 240 chars, one line, or null) and `overlap` (null, or `{ post_id, reason }` where `post_id` is one of the posts actually sent). Any failure is a failed attempt; up to 3 attempts.
- **Writer untouched.** `writer-isolation.test.ts` pins the six Writer-chain prompt hashes, proves `buildGenerationUserV3` emits nothing keyword-shaped even when fields are smuggled into params, and checks that the Writer and blueprint modules import nothing from keyword data or the steps.

### Phase 5 — A/B harness (`da27a1a`)

- `POST /api/v1/content-v3/keyword-data/ab-test` — admin-only. `src/services/ab-harness/keyword-data-ab.ts` (pure) + `keyword-data-ab.default.ts` (files) + `src/routes/content-v3-ab.handler.ts`. Up to 10 keywords; per keyword the inputs are frozen, keyword data is prefetched once, then Title → Planner run with keyword data **off** and again **forced on** (independent of the live flag). Records title, ranked questions, `demand_notes`, `overlap`, attempts, token usage, DataForSEO cost, estimated model cost (only when prices are configured), latency, prompt version. Writes `<run_id>.json` and `<run_id>.csv` under `data/ab-tests/` (git-ignored, not served). Never publishes, never writes `user_generations`, never charges.

### Cross-cutting (final commit)

- `.env.example` (keys only) with a trailing `!.env.example` in `.gitignore`; `data/ab-tests/` ignored; this report un-ignored like the billing runbook.
- Nothing deleted; `v2`, `/generatekeyword`, `/article/test` and every existing prompt unchanged.

## New env vars and config

| Variable | Required | Meaning |
|---|---|---|
| `DATAFORSEO_LOGIN` | for keyword data | DataForSEO Basic-auth login. Missing → metrics answer `503 KEYWORD_DATA_NOT_CONFIGURED`, steps run without keyword data. |
| `DATAFORSEO_PASSWORD` | for keyword data | DataForSEO Basic-auth password. Never logged. |
| `ISEO_V3_KEYWORD_DATA` | no | Option B master switch. Only the literal `true` counts. |
| `KEYWORD_METRICS_CREDIT_COST` | no | ISEO credits per metrics request. Default `0`. Malformed → `0` with a boot warning. |
| `AB_MODEL_PRICE_INPUT_PER_MTOK`, `AB_MODEL_PRICE_OUTPUT_PER_MTOK` | no | USD per million tokens so the harness can report model cost; unset → tokens only. |

Constants (`KEYWORD_DATA_DEFAULTS` in `src/config/keyword-data.config.ts`): location `2840` (United States), language `en`, cache TTL 30 days, fetch budget 8000 ms, related limits 10 (Title) / 30 (Planner), metrics max 100 keywords, rate limits 30/min for metrics and prefetch.

## How to run locally

```bash
npm install
# .env: the existing variables plus
#   DATAFORSEO_LOGIN=…  DATAFORSEO_PASSWORD=…  ISEO_V3_KEYWORD_DATA=true  KEYWORD_METRICS_CREDIT_COST=0
npm run migrate:keyword-data-cache          # or paste `npm run --silent migrations:print` into the Supabase SQL editor
npm run dev                                 # http://localhost:8080 (PORT)
```

Then register the step prompts once (idempotent; existing templates are left alone):

```bash
ADMIN_TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/admin-login \
  -H 'Content-Type: application/json' -d '{"password":"'"$ADMIN_PASSWORD"'"}' | jq -r .data.token)
curl -s -X POST http://localhost:8080/api/v1/content-v3/prompts/seed -H "Authorization: Bearer $ADMIN_TOKEN"
```

Until migration 022 is applied the cache fails open (every lookup pays DataForSEO) and logs `[keyword-data] cache unavailable`.

## Toggling the flag

Option B is on for a request only when **both** hold:

1. the server has `ISEO_V3_KEYWORD_DATA=true` (restart after changing it), and
2. the request body has `"use_keyword_data": true` (a JSON boolean; `"true"` is rejected with 400).

Anything else — flag off, request not opted in, DataForSEO unreachable, no credentials, no data — runs the step exactly as before: V1 prompt, no `<keyword_data>`, no `<recent_posts>`, `demand_notes` and `overlap` null. The response's `metadata.keyword_data` says what happened (`requested`, `effective`, `used`, `reason`), and every fallback logs `[keyword-data] fallback step=… reason=…`.

## Endpoints and curl examples

Plugin routes use the plugin's headers; admin routes use the Bearer token from `/auth/admin-login` (see above).

### 1. Keyword metrics (Option A) — plugin auth

```bash
curl -s -X POST http://localhost:8080/api/v1/generate/keywords/metrics \
  -H 'Content-Type: application/json' -H "x-api-key: $API_KEY" -H "x-site-code: $SITE_CODE" \
  -d '{"keywords":["water heater repair cost","Water Heater Replacement Cost"],"location_code":2840,"language_code":"en"}'
```

```json
{ "success": true,
  "items": [
    { "keyword": "water heater repair cost", "search_volume": 2400, "keyword_difficulty": 18, "intent": "commercial", "scope": "national", "fetched_at": "2026-11-11T10:00:00.000Z" },
    { "keyword": "water heater replacement cost", "search_volume": 1900, "keyword_difficulty": 22, "intent": "commercial", "scope": "national", "fetched_at": "2026-11-11T10:00:00.000Z" }
  ],
  "cached_count": 0, "cost_usd": 0.0102 }
```

`keyword` is echoed normalised (trimmed, lower-cased); one item per distinct keyword. Errors: `400 VALIDATION_ERROR`, `401`, `402 INSUFFICIENT_CREDITS` (only when a cost is configured), `429`, `503 KEYWORD_DATA_NOT_CONFIGURED`, `504 KEYWORD_DATA_TIMEOUT`, `502 KEYWORD_DATA_PROVIDER_ERROR`, `400 KEYWORD_DATA_BAD_REQUEST` (provider rejected location/language).

### 2. Prefetch — plugin auth

```bash
curl -s -X POST http://localhost:8080/api/v1/content-v3/keyword-data/prefetch \
  -H 'Content-Type: application/json' -H "x-api-key: $API_KEY" -H "x-site-code: $SITE_CODE" \
  -d '{"keyword":"water heater repair cost"}'
```

```json
{ "success": true, "status": "ready", "seed": { "keyword": "water heater repair cost", "search_volume": 2400, "keyword_difficulty": 18, "intent": "commercial", "scope": "national", "fetched_at": "…" }, "related_count": 30 }
```

`status: "unavailable"` (still HTTP 200) carries `seed: null`, `related_count: 0` and a `reason` (`budget`, `not_configured`, or a provider error kind).

### 3. Title step — admin

```bash
curl -s -X POST http://localhost:8080/api/v1/content-v3/title \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "seed_keyword": "water heater repair cost",
    "language": "English (US)", "niche": "plumbing", "reach": "local", "target_town": "Española",
    "search_data": { "location": "Española, NM", "national_fallback": false,
      "ranking_titles": ["Water Heater Repair Cost Guide", {"text": "How Much Does Water Heater Repair Cost?", "scope": "national"}],
      "people_also_ask": ["Is it worth repairing a water heater?"], "related_searches": ["water heater repair near me"] },
    "max_list_items": 7, "previous_titles": [],
    "use_keyword_data": true
  }'
```

`data` is `{ title, form, items, main_concern, page_kind }`; `metadata` has `attempts`, `usage`, `timings`, `keyword_data`, `prompt` (`templateType`, `source`, `version`) and `messages` (the exact system and user prompts, admin-only). A string item in `search_data` defaults to `scope: "local"`.

### 4. Planner step — admin

```bash
curl -s -X POST http://localhost:8080/api/v1/content-v3/planner \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "title": "Water heater repair cost in Española: what drives the price",
    "seed_keyword": "water heater repair cost",
    "language": "English (US)", "niche": "plumbing", "reach": "local", "target_town": "Española",
    "business_description": "Family plumbing company serving Rio Arriba County since 2009.",
    "search_data": { "people_also_ask": ["Is it worth repairing a water heater?", "How long do water heaters last?"] },
    "research": { "facts": [{"claim": "Typical repairs run $150 to $700 nationally", "scope": "national", "source_ids": [1]}],
                  "follow_up_questions": [{"question": "Can I repair a leaking tank myself?"}] },
    "minimum_size": "small",
    "use_keyword_data": true,
    "recent_posts": [
      {"post_id": 12, "title": "How much does water heater repair cost?", "seed_keyword": "water heater repair cost"},
      {"post_id": 13, "title": "Best plumbers in Española"}
    ]
  }'
```

`data` is the doc's Planner JSON plus `demand_notes` (string or null) and `overlap` (`{ post_id, reason }` or null; always present). `metadata.recent_posts` shows which posts code selected and their scores.

### 5. A/B harness — admin

See the next section.

## How to run the A/B harness

```bash
curl -s -X POST http://localhost:8080/api/v1/content-v3/keyword-data/ab-test \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "keywords": ["water heater repair cost", "tankless water heater installation", "sump pump replacement"],
    "location_code": 2840, "language_code": "en",
    "business": { "language": "English (US)", "niche": "plumbing", "reach": "local", "target_town": "Española",
                  "minimum_size": "small",
                  "recent_posts": [{"post_id": 12, "title": "How much does water heater repair cost?"}] },
    "fixtures": {
      "water heater repair cost": {
        "search_data": { "people_also_ask": ["Is it worth repairing a water heater?"] },
        "research": { "facts": [{"claim": "Typical repairs run $150 to $700 nationally", "scope": "national"}] }
      }
    },
    "save": true
  }' | jq '.data | {run_id, files, totals}'
```

- Up to 10 keywords; each runs **off** then **on** (Title → Planner). The ON arm is forced on regardless of `ISEO_V3_KEYWORD_DATA`, so the comparison can be run before the flag is enabled; `flag_env_on` records the live setting.
- `fixtures[keyword]` is how `search_data` / `research` are "fetched once and frozen": the same objects go to both arms. Keywords without a fixture run with no search data or research (the prompts allow that).
- Output: the full result in the response, plus `data/ab-tests/<run_id>.json` and `.csv` (one CSV row per keyword per arm: title, form, prompt version, keyword data used, attempts, tokens, cost, latency, article type, size, body and FAQ questions, demand notes, overlap, errors). `"save": false` skips the files.
- Costs: DataForSEO cost comes from the API; model cost is reported only when `AB_MODEL_PRICE_*` are set, otherwise tokens only.
- A failing step is recorded on its arm (`ok: false`, `error`) and the run continues.

## Tests and acceptance criteria

```bash
npm test            # 754 tests, 754 pass (baseline on main: 580)
npm run typecheck   # clean
npm run lint        # BROKEN ON MAIN BEFORE THIS BRANCH: ESLint 8 has no TypeScript parser, so
                    # `eslint .` finds no files / cannot parse .ts. Not changed here; typecheck is the gate.
```

- Existing tests pass; 174 new tests cover the client, config, normalisation, cache, service, block, rate limiter, all five routes, the step prompts, tags, recent-posts selection, both steps, the Writer isolation and the harness.
- Flag off → Title and Planner payloads byte-identical (tested at the user-message and system-prompt level).
- Writer, humanizer, intelligence, blueprint directives, SEO rules and business-context prompts unchanged byte for byte (hash-pinned); Title and Planner V1 are the design doc byte for byte (hash-pinned).
- No secrets in code or logs: credentials are read from env on demand, sent only as the `Authorization` header, and the log lines carry endpoint, status, latency and cost only. `.env` is untouched and still ignored.

## Known limitations

1. **The SERP lookup and the research step do not exist.** `search_data` and `research` are request inputs for the Title/Planner routes and fixtures for the harness. Without them the Planner returns few or no questions (its own rule) — the harness is most useful with fixtures.
2. **Title and Planner are admin-only and uncharged**, like the rest of v3. A plugin-facing, credit-gated version needs a `user_generations` type decision (the live `type` constraint is unverified) and a price.
3. **DataForSEO field names** (`keyword_info.search_volume`, `keyword_properties.keyword_difficulty`, `search_intent_info.main_intent`) follow the Labs docs; the first live call should be checked against a real response. Related keywords use depth 2 (up to 72 candidates) and the API's own volume ordering.
4. **Cache** needs migration 022; until then every lookup pays DataForSEO (logged). Expired rows are refreshed lazily on the next request; nothing refreshes them proactively.
5. **Rate limiting is per process** (pre-existing design of `rateLimitPerUser`), so the ceiling is limit × instances.
6. **Location names** in the block come from a small code→name map (US, UK, CA, AU, NZ, IE, ZA, DE, FR, ES, IT, NL, IN); other codes render as `location_code N`.
7. **Model cost in the harness** is an estimate from configured prices; without them only tokens are reported.
8. `npm run lint` is broken at baseline (see above).
9. The design doc is not tracked in the repo (`*.md` ignored); the keyword research report was not available, so it could not be reconciled against the code.

## Open decisions

| Decision | Current value | Where |
|---|---|---|
| Credits per metrics request | `KEYWORD_METRICS_CREDIT_COST=0` (free); charging code is in place for any positive integer. | `src/config/keyword-data.config.ts`, `keyword-metrics.handler.ts` |
| Default location and language | `2840` (United States), `en` | `KEYWORD_DATA_DEFAULTS` |
| `recent_posts` overlap threshold | Jaccard ≥ `0.2`, top `5`, over at most `20` posts | `src/services/content-v3-steps/recent-posts.ts` |
| Prefetch auth | plugin (`validateApiAccess`); Title/Planner/A-B admin-only | `content-v3-keyword-data.routes.ts`, `content-v3-steps.routes.ts` |
| Related-keyword depth and ordering | depth 2, `search_volume desc`, 30 fetched per seed | `dataforseo.client.ts`, `keyword-data.service.ts` |
