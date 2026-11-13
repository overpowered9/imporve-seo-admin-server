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

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/v1/content-v3/search-data` | admin | The search data lookup alone: block, exact XML, per-call meta. Spends ~$0.002 per call. |
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
