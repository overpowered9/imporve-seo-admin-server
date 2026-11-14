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

## Storage (migration 023)

Apply with `npm run migrate:content-v3-store`, or paste `npm run --silent migrations:print` into the Supabase SQL editor. Code deployed first is safe: the store fails open (`[content-v3] store unavailable`).

- `content_v3_sessions`: one row per wizard session (user + website + the plugin's `iseo_tk_…` key), JSONB, expires after the TTL, deleted on Leave.
- `content_v3_posts`: one row per generated v3 article (blueprint picks, fingerprint, headings, type, proof level, validator report); rows older than 365 days are purged.

## Logs

One line per model attempt, never content:

```
[model-call] step=title model=claude-sonnet-5 prompt=content_v3_title@v3#d0881236 attempt=1/3 outcome=ok in=812 out=96 cache_read=1490 cache_write=0 cost_usd=0.001234 ms=2345 run=iseo_tk_…
```

`prompt=` is the template, the DB version (or `code` for the in-code fallback) and the first 8 hex of the sha256 of the exact text sent, so two runs with the same hash sent byte-identical system prompts. `cache_read > 0` on the second article proves prompt caching. Per article, one summary line: `[content-v3] cost run=… <step>=<usd> … total=<usd>`.

## Rollout and rollback (filled in fully in phase 13)

1. Deploy with `CONTENT_V3_ENABLED` unset. Apply migration 023. Run `POST /prompts/seed?mode=replace`, then `GET /prompts/check`.
2. Staging: set `CONTENT_V3_ENABLED=true`, switch "Use Content v3" on in one test site.
3. One production site, then all.
4. Rollback: unset `CONTENT_V3_ENABLED` (sites fall back to v2 within 5 minutes). Prompt rollback: activate the "pre-v3" version in the admin panel.
