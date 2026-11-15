# Content v3 on the server

The design is `docs/content-v3-prompt-drafts.md` (a byte-identical copy of the plugin repo's file; the prompt equality tests read it). Progress and the requirement table live in the plugin repo, `docs/CONTENT_V3_PROGRESS.md`. This file is the operator's view: switches, routes, storage, logs. Each phase adds its part.

## Switches

| Variable | Effect |
|---|---|
| `CONTENT_V3_ENABLED` | Master switch. Only `true` turns it on. Each site must ALSO switch on "Use Content v3" in the plugin. Off = every site uses v2: **this is the rollback**, with no data loss. |
| `CONTENT_V3_MAX_ATTEMPTS` | 1–3, default 3. |
| `CONTENT_V3_TIMEOUT_*_MS` | Per-attempt timeout per step (search data 30 s, title 60 s, research 120 s, planner 90 s, writer 300 s, meta 60 s). |
| `CONTENT_V3_SESSION_TTL_DAYS` | Abandoned wizard sessions are purged after this (default 7). |
| `MODEL_PRICES_JSON` | Optional price table override for the cost log. |
| `ISEO_V3_KEYWORD_DATA` | Unchanged meaning (docs/KEYWORD_DATA_V3.md). |

## Search data lookup (phase 2)

DataForSEO Google organic, Live mode, advanced, depth 10, People Also Ask click depth 1, language from the wizard (decided 30 Oct). `services/search-data/`.

- Nationwide business, or a post marked "Not about a specific location": one call at the country.
- Local post: one call at the Target town (resolved on DataForSEO's free locations list, accent-insensitive, "Town, ST" understood). Thin (fewer than `SEARCH_DATA_THIN_THRESHOLD` questions or related searches) → a second call at the country with the town taken out of the keyword. No state-level call.
- Merge: local first, duplicates removed, caps 10 titles / 8 questions / 8 related, every item scoped. Only LOCAL ranking domains are kept for the Research competitor filter.
- A town DataForSEO does not list: `SEARCH_DATA_TOWN_ALIASES_JSON` (nearest listed city), else coordinates when the caller has them, else one country call with the keyword as typed (logged `town=unresolved`). Open question for Zaid; the alias map is the working value.
- Failures never block the title: a failed town call still runs the country call; if nothing returns, the Title prompt works from the keyword. A task-level error (inside a 200) is retried once.
- Results are stored in the wizard session and reused on Regenerate title.
- Log: `[search-data] seed="…" mode=local location="Española, NM" national_fallback=yes local=t9/q6/r2 national=t8/q6/r3 merged=t10/q8/r5 town=listed cost_usd=0.0043 ms=5298`
- Real run, 14 Nov: "water heater repair Española" at Española, NM → town call thin (2 related) → country call → merged block as above, $0.0043, 5.3 s. Field names confirmed: organic `title`/`domain`/`url`; `people_also_ask.items[].title`; `related_searches.items` strings.

## Research (phase 4)

PROMPT 2 on the Perplexity Agent API (`services/research/`), request shape checked against Perplexity's docs on 14 Nov: `POST https://api.perplexity.ai/v1/agent` with `instructions` (the doc text, template `content_v3_research`), `input` (the doc's data block), `tools: [{ type: "web_search", max_results, filters: { search_domain_filter }, user_location }]`, `response_format: { type: "json_schema", json_schema: { name: "research", schema } }`, `effort` (and optional `model`).

- Competitor filter: the LOCAL ranking domains from the search data lookup as `-domain` entries, max 20; government, education, encyclopedia and major news domains never filtered (`RESEARCH_FILTER_SKIP_DOMAINS` adds more).
- `user_location { city, region, country }` when the post has a Target town.
- Every source number is mapped to its search result; a fact, question or local condition without a match is dropped. Caps 15 / 10 / 6 in code. Facts get tokens S1…, local conditions continue the numbering; each token maps to one URL and date for the Writer's links.
- Up to 3 attempts (timeout `CONTENT_V3_TIMEOUT_RESEARCH_MS`). If all fail, or `PERPLEXITY_API_KEY` is unset, the run continues without research.
- Stored in the wizard session for Regenerate and Change Image.
- Cost: `usage.cost.total_cost` from Perplexity, in the `[model-call] step=research` line; summary `[research] run=… facts=… questions=… local_conditions=… dropped=f/q/c … cost_usd=…`.
- **Not run live yet: needs `PERPLEXITY_API_KEY`, and Zaid's choice of model and effort (working value `PERPLEXITY_EFFORT=low`).** Built and tested against a mocked provider.

## The article (phase 8)

`POST /api/v1/content-v3/article` (plugin auth, **paid exactly like v2**: same price for the chosen size, reserve before the model runs, refund on any failure; regeneration priced from a prior `content_v3`/`content_v2` row for the same wizard slot; a second request for the same session while one runs is refused). Everything Approve title produced is read from the wizard session; step 2's choices come in the body. A missing session answers 409 `session_expired`.

- **Writer draft 2**: system prompt = the core + `<rules_no_invention>`, `<rules_reader_first>`, `<rules_human_style>`, `<rules_seo>`, `<rules_local_seo>`, `<rules_formatting>` (the core's own order), identical for every article, sent with `cache_control`. Measured 14 Nov: 8,399 cached tokens on the second call, writer cost $0.114 → $0.067. User message = `<niche_profile>`, `<blueprint>`, `<recent_headings>`, then the data tags in the doc's order.
- **Templates**: core `content_v3_system`, `rules_seo` `content_v3_seo_rules`, `rules_reader_first` `content_v3_business_context`, plus four new `content_v3_rules_*`. **Until `/prompts/seed?mode=replace` has run, the three shared templates still hold the pre-v3 texts in production; the server then uses the doc text from code and logs `still holds the pre-v3 text`.** A core without `===WRITER_JSON===` is never used.
- **Post-processing** (no em-dash stripping, no `<hr>`): HTML allowlist; the first use of up to 4 sources becomes a link, other tokens removed, unknown tokens logged; TOC as `<nav class="iseo-toc">` after the summary (Medium and Large by default); disclaimer before the last two sections only when a text exists (`content_v3_disclaimers` ships empty); FAQ read from the HTML.
- **Validator**: errors (structure, summary, FAQ count, last two sections, numbered items, question headings, fixed labels, keyword in the first 100 words, vague back-references, word count, Regulated ≥ 3 sources) and warnings (repeated first words, recent headings, em dashes, bold, unknown tokens, the Writer's claims to check). Errors → the Writer runs once more; still failing → `needs_review` (wizard: "Use anyway / Regenerate"). Humanizer thresholds (V10) wait for that document.
- **Meta** (interim U4): the existing v3 meta wording minus the FAQ part, with the existing length enforcement, on the final article.
- **Records**: `user_generations` row type `content_v3` (model = the writer model), `content_v3_posts` row (picks, fingerprint, headings, validator), and `[content-v3] cost run=… search_data=… title=… research=… planner=… writer=… meta=… total=…`.
- **Measured 14 Nov** (no research key): Medium standard article via the tester 1,388 words, first try, writer $0.139; Small regulated article via the wizard 976 words, $0.26 total, `needs_review` because a Regulated post needs 3 sources and there was no research.
- `POST /api/v1/content-v3/article/test` (admin, no credits) now runs this chain end to end (search data → title if none → research → planner → writer) with the tester's `blueprint_pins`.

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/v1/content-v3/search-data` | admin | The search data lookup alone: block, exact XML, per-call meta. Spends ~$0.002 per call. |
| `POST /api/v1/content-v3/research` | admin | Research alone (optionally after a search data lookup with `run_search_data: true`): mapped research, the `<research>` XML, cost. |
| `POST /api/v1/content-v3/article` | plugin | The paid v3 article (above). |
| `POST /api/v1/content-v3/article/test` | admin | The full chain, no credits, with blueprint pins and rendered prompts. |
| `GET /api/v1/content-v3/blueprint/options`, `POST …/blueprint/preview` | admin | Tester pools and a model-free blueprint preview. |
| `GET /api/v1/content-v3/status` | plugin | `{ enabled, keyword_data }`. The plugin caches it 5 minutes. |
| `POST /api/v1/content-v3/session/clear` | plugin | Wizard Leave: deletes the session row. Works with v3 off. |
| `POST /api/v1/content-v3/prompts/seed` | admin | Registers templates; `?mode=replace` makes every doc-sourced prompt active, backing the old value up as "pre-v3" first. Nothing is deleted. |
| `POST /api/v1/content-v3/prompts/backup-pre-v3` | admin | The backup alone. |
| `GET /api/v1/content-v3/prompts/check` | admin | Active DB text vs the doc text per prompt; `all_equal` must be true before launch. |

## Storage (migrations 022, 023, 024)

Paste `npm run --silent migrations:print` into the Supabase SQL editor (or run `npm run migrate:keyword-data-cache`, `npm run migrate:content-v3-store`, `npm run migrate:content-v3-runs`). All three are idempotent, record themselves in `schema_migrations`, and have a reversal (`npm run --silent migrations:print -- --down`).

**v3 needs 023 and 024.** While their tables are missing, `GET /content-v3/status` answers `enabled: false` even with `CONTENT_V3_ENABLED=true`, the v3 routes answer `v3_disabled`, and every site stays on v2 (`[content-v3] switched on but its tables are missing …` in the log). Deploying the code before the migrations is therefore safe.

- `content_v3_sessions` (023): one row per wizard session (user + website + the plugin's `iseo_tk_…` key), JSONB, expires after the TTL, deleted on Submit and Leave.
- `content_v3_posts` (023): one row per post (blueprint picks, fingerprint, headings, type, proof level, validator report); a regeneration replaces its row; Leave deletes it; rows older than 365 days are purged.
- `content_v3_runs` (024): one row per article request (status, credits, step costs, timings, the stored answer for replay); purged after 90 days.
- `content_v3_quota` (024): daily counters per account for the free steps and delivered articles; purged after 30 days.
- `keyword_metrics_cache`, `keyword_related_cache` (022): DataForSEO Labs results. Optional: without them keyword data is fetched each time (`cache unavailable` in the log).

## Logs

One line per model attempt, never content:

```
[model-call] step=title model=claude-sonnet-5 prompt=content_v3_title@v3#d0881236 attempt=1/3 outcome=ok in=812 out=96 cache_read=1490 cache_write=0 cost_usd=0.001234 ms=2345 run=iseo_tk_…
```

`prompt=` is the template, the DB version (or `code` for the in-code fallback) and the first 8 hex of the sha256 of the exact text sent, so two runs with the same hash sent byte-identical system prompts. `cache_read > 0` on the second article proves prompt caching. Per article, one summary line: `[content-v3] cost run=… <step>=<usd> … total=<usd>`.

## Rollout and rollback (runbook)

Content v3 is off until two switches are on: the server's `CONTENT_V3_ENABLED` and each site's "Use Content v3" (Settings → Content Features). With either off, every site generates exactly as before (v2). Nothing below changes v2.

### Render environment

| Variable | When | Value |
|---|---|---|
| `CONTENT_V3_ENABLED` | Step 4 (staging), later production | `true` to enable; unset = off (**the rollback**) |
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | Before step 4 | Already set for keyword data; the search data lookup uses the same account |
| `PERPLEXITY_API_KEY` | Before step 4 | **Missing.** Without it research is skipped: articles quote no figures, and every Regulated article fails the 3-source check and needs review |
| `PERPLEXITY_EFFORT`, `PERPLEXITY_MODEL` | With the key | Zaid's choice; working value `low`, no model |
| `ISEO_V3_KEYWORD_DATA` | Optional | `true` lets sites with the keyword-data beta setting use it in the v3 Title/Planner |
| `CONTENT_V3_MAX_ATTEMPTS`, `CONTENT_V3_TIMEOUT_*_MS`, `CONTENT_V3_SESSION_TTL_DAYS`, `SEARCH_DATA_*`, `RESEARCH_FILTER_SKIP_DOMAINS`, `MODEL_PRICES_JSON` | Optional | Defaults are in `.env.example` |
| `CONTENT_V3_STORE` | **Never on Render** | Local development only |

### Steps

1. **Deploy** the server with `CONTENT_V3_ENABLED` unset. `GET /api/v1/content-v3/status` answers `enabled: false`; every site stays on v2.
2. **Migrations** (Supabase SQL editor, paste `npm run --silent migrations:print`): 022 (keyword data cache), 023 (wizard sessions, post history) and 024 (run ledger, daily counters). Idempotent. v3 stays reported off until 023 and 024 exist (see Storage).
3. **Prompts** (admin token): `POST /api/v1/content-v3/prompts/seed?mode=replace` — registers every v3 template and makes the doc text active for the doc-sourced ones, backing each old value up first as a version labelled `pre-v3` (nothing is deleted). Then `GET /api/v1/content-v3/prompts/check` must answer `all_equal: true`. Until this runs, the server uses the doc text from code for the three templates the Writer shares with the old chain and logs `still holds the pre-v3 text`.
4. **Staging**: set `CONTENT_V3_ENABLED=true` on a staging server; on one test site switch "Use Content v3" on (the plugin re-checks the server within 5 minutes; saving the setting re-checks at once). Fill Business details: niche, local/nationwide, towns served, proof level, point of view.
5. **Smoke test** on that site: Generate title → Approve (step 2 shows type, size, owner questions) → Generate AI Post → publish. Then a bulk project of 5 including a Regulated niche. Watch the logs (below).
6. **Production**: set `CONTENT_V3_ENABLED=true`, switch one real site on, then the rest.

### What to watch

- `[model-call] … outcome=…` one line per model attempt; `cache_read` > 0 on the Writer after the first article (prompt caching works).
- `[content-v3] cost run=… total=…` per article. Measured in the 10-keyword run (14 Nov, all steps, no research, keyword data off): Small $0.14 first try / $0.18 with the second Writer run; Medium $0.13 / $0.21–0.25; Large $0.29 (with the second run). Research adds the Perplexity cost once the key exists. Keyword data on (same run) added $0.41 of DataForSEO keyword lookups for 10 articles, about $0.04 each, while migration 022's cache is missing; those lookups are logged per call (`[dataforseo]`), not in this line. The image is not in this line (v2 image route, unchanged).
- `[content-v3] validator … — writing once more (U2)` — how often the Writer needs its second run (7 of 10 in the 10-keyword run).
- `validator=fail(…)` with `word_count` on Medium and Large: the Writer wrote about 70% of the body word targets on Medium and about 55% on Large in that run (Small about 95%), so Large articles came out under 2,400 words. A tuning decision for the team lead (aims, ranges or a length note in the second run).
- `[content-v3] article … validator=fail(…)` — articles that needed review.
- `[search-data] … local=failed(…)` and `[research] failed` — provider trouble (the chain continues without them).
- `REFUND FAILED (will retry)` — a refund failed and is retried every 10 minutes; it should clear on its own.
- `REFUND APPLIED, LEDGER NOT UPDATED` or `REFUND STATE UNKNOWN` — a person checks the credit ledger for that user and amount, then sets the run row to `refunded` (credits returned) or `refund_pending` (not returned). The code never retries these, so a refund is never paid twice.
- `[content-v3] swept N run(s) whose process stopped` — articles cut off by a deploy or crash; the charged ones are refunded automatically.
- `[content-v3] cost over ceiling` — an article that cost us more than its size's ceiling (`CONTENT_V3_COST_CEILING_USD_JSON`); billing is unchanged.
- One run's every line: search the logs for `run=<session key>`; `GET /api/v1/content-v3/admin/trail?run=<key>` (admin) shows its ledger, generation and post rows.

### Rollback

- **Everything**: unset `CONTENT_V3_ENABLED`. Changing an env var restarts the server: articles being written at that moment are failed and refunded during the shutdown (or by the sweep a minute after boot), and the plugin shows a plain "try again" message. Within 5 minutes every site uses v2 (status cache); a wizard that started under v3 gets `v3_disabled` on its next step and falls back to v2. No data is lost: sessions expire after 7 days, post history stays, and refunds still run while v3 is off.
- **One site**: switch "Use Content v3" off in its settings.
- **One prompt**: in Prompts (V3), activate the version labelled `pre-v3` (or any earlier version). Activation now switches atomically (the new version is activated before the others are deactivated).
- **Code**: redeploy the previous commit; the migrations are additive and can stay.
