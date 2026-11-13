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

## Routes

| Route | Auth | Purpose |
|---|---|---|
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
