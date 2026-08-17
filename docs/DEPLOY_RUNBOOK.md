# Deploy runbook — ISEO Credits rollout

Follow the steps **in order**. Steps 1–3 are configuration, 4–6 are the deploy itself, 7–8 verify it.

> **This service is not Render-blueprint managed.** There is no `render.yaml` in this repo, and one
> was deliberately not added: a blueprint file that Render is not configured to read would look like
> configuration while doing nothing, which is worse than no file at all. Environment variables are
> therefore set in the **Render dashboard**. Step 1 gives you a block to paste in one go.
>
> If this service is ever migrated to a blueprint, move the nine `ISEO_COST_*` integers from step 1
> into `render.yaml` as `envVars` defaults — they are integrity-sensitive, not secret, so committing
> them is fine. Secrets and `ADMIN_EMAILS` must stay dashboard-managed either way.

---

## 1. ISEO pricing variables — REQUIRED, the server will not boot without them

`src/config/credits.config.ts` validates every one of these at import and **throws, aborting boot,**
if any is missing or malformed. That is deliberate: a server that cannot price an action must not
serve one, and a silent fallback to `0` would give away free generations. There are **no in-code
default prices** — this block is the only way they reach a running process.

In the Render dashboard: **Environment → Add from .env → paste → Save**.

```
ISEO_COST_CONTENT_SMALL=6
ISEO_COST_CONTENT_MEDIUM=10
ISEO_COST_CONTENT_LARGE=14
ISEO_COST_CONTENT_REGEN_SMALL=4
ISEO_COST_CONTENT_REGEN_MEDIUM=6
ISEO_COST_CONTENT_REGEN_LARGE=8
ISEO_COST_IMAGE=5
ISEO_COST_IMAGE_REGEN=3
ISEO_COST_KEYWORDS=1
ISEO_GRANT_FREE=100
ISEO_GRANT_BASIC=220
ISEO_GRANT_STARTER=580
ISEO_GRANT_PRO=1150
```

> **The four grant keys match your real `subscription_plans.slug` values** — `free`, `basic`,
> `starter`, `pro` — verified against the production database. An earlier draft used
> `grow/scale/enterprise`, which matched none of them: because an unrecognised slug falls back to
> the FREE grant, every paying customer would have been given the free allotment. If you add or
> rename a plan, add the matching `ISEO_GRANT_<SLUG>` key at the same time. Note the 950-cent plan's
> slug is `basic` even though its display name is "Grow".

**The four `ISEO_GRANT_*` values are placeholders.** They are internally consistent but are not a
pricing decision. Confirm them against real retail prices using:

```
credits = (plan_price × target_COGS_share) / 0.0129
```

where `$0.0129` is the per-credit cost implied by a medium article at `$0.129`.

All thirteen are **PM-tunable**: changing one is an env edit plus a redeploy. No code change.

*Boot confirmation:* the logs will show one line — `💳 ISEO credit table loaded — sha256:…`. That
hash identifies which price table the deploy is running, without printing prices into the logs. If
you see the config error instead, it names the offending variable.

## 2. `ADMIN_EMAILS` — REQUIRED for the admin panel

```
ADMIN_EMAILS=someone@yourdomain.com,someone-else@yourdomain.com
```

This does **not** block boot, but the admin panel is unusable until it is set: every `/api/admin` and
`/api/v1/admin/users` route returns **403** for everyone, including you.

It fails closed on purpose. Before this change those routes had no authentication at all, so anyone
who could reach the host could grant themselves unlimited credits. An empty allowlist means nobody is
an admin, which is the safe end to fail towards.

Comma-separated, matched case-insensitively against the caller's Supabase account email. The caller
must also hold a valid Supabase JWT — being on the list is not by itself sufficient.

## 3. Secret keys

Set the real values in the dashboard (never in the repo): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`FLUX_AI_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`,
plus `DATABASE_URL`, `MONGODB_URI` and the Supabase keys.

`.env.sample` carries `replace_me` placeholders for all of these and is the reference for the full
list. `.env` is gitignored and must stay that way.

## 4. Announce the credit reset, and back up the database

**Migration 011 resets credit balances. Tell customers before you run it.**

- **Plan (included) credits are reset** to the new plan allotment. There is no honest conversion
  between the old pools — one "content credit" bought an article of any size, one "image credit"
  bought an image, and the new unit is a fraction of both. Any arithmetic mapping would enrich some
  users and rob others, and no rate would be defensible to a customer who asked.
- **Purchased credits ARE carried over.** They were paid for separately and do not expire, so they
  are summed across the three old rows and moved onto the new one. This is generous in the user's
  favour, which is the right direction to err with money.

Scope, measured against production on 2026-08-18: **12 users** hold credit rows, and **3 of them
hold 3,322 purchased credits** between them. Those 3,322 are the ones being carried over — confirm
they survive the migration before promoting.

Take a database backup before proceeding. Migration 011 runs in a single transaction and rolls back
cleanly on failure, but the reset itself is intentional and not undone by a rollback once committed.

## 5. Redeploy

Deploy the new build. Boot will now:

1. validate the credit table and abort if anything is wrong (step 1);
2. log the price-table fingerprint;
3. sync the env grants into `subscription_plans.*_credits` so Stripe checkout descriptions and CMS
   plan tables keep showing real numbers.

## 6. Run the migrations, in this order

```bash
npm run migrate:target-key     # 010 — user_generations.target_key + custom_instruction
npm run migrate:iseo-credits   # 011 — collapse to the single ISEO pool  ⚠️ resets balances
```

Order matters: 011 seeds balances from the env grants, and 010 must already have added the column
that regeneration pricing reads. Both are idempotent — safe to re-run if one is interrupted.

## 7. Spot-check two real accounts

- **A free-tier account** — balance should equal `ISEO_GRANT_FREE` (100), purchased 0.
- **A paid account that had leftover purchased credits** — included should equal that plan's grant,
  and `purchased_remaining` should equal the **sum** of its three old purchased balances.

Both should show a `credit_transactions` row explaining the migration, so the change is answerable
if a customer queries it.

## 8. Verify before treating the deploy as live

Run these against the **Render preview** first. (There is no `PROMOTION_CHECKLIST.md` in this repo —
these are the checks that matter for this change; add them to one if a shared checklist is created.)

| # | Check | Expected |
|---|---|---|
| 1 | Unset `ISEO_COST_CONTENT_MEDIUM`, boot | Exits naming that variable; does **not** boot at 0 |
| 2 | 5 concurrent `/content-v2/article` on a 10-credit account | Only the affordable number succeed; balance never negative |
| 3 | Force the Anthropic call to throw | Reservation refunded; ledger shows matching debit + credit |
| 4 | Generate, then regenerate the same `target_key` | Second charge is the lower REGEN amount |
| 5 | `is_regeneration: true` with no prior generation | Charged **full** price |
| 6 | Same as 4 and 5 for images | Same behaviour |
| 7 | `nos_of_words: "garbage"` | Priced and generated as `medium` |
| 8 | Generate, edit the keyword, regenerate | Output reflects the **new** keyword |
| 9 | Regenerate with a custom instruction | Reflected in output; price identical to a plain regen |
| 10 | Instruction attempting to override the format | Structure intact; >2000 chars truncated |
| 11 | `POST /api/v1/admin/users/1/gift-credits`, no token | **401** — before *and* after adding a new route to that router |
| 12 | `POST /content-v2/article/test`, unauthenticated | **401** |
| 13 | Change `ISEO_GRANT_PRO`, restart | `subscription_plans.content_credits` matches; Stripe description reflects it |

Then run **one real single-post generation and one regeneration** against the preview before
promoting. The WordPress plugin cannot be exercised locally, so this is the only true end-to-end
check.

---

## Rollback

The safe rollback is **redeploying the previous build**, not re-running migrations backwards.

- Migration 010 is additive (two nullable columns plus an index) and harmless to leave in place.
- Migration 011 is **not** reversible — the old per-type rows are deleted and the balances they held
  cannot be reconstructed from the pooled row. Restore from the step-4 backup if balances must be
  recovered.

Reverting the code while leaving migration 011 applied will break credit reads: the old build looks
for `credit_type IN ('images','content','keywords')`, which no longer exist. If you roll the code
back, restore the database too.
