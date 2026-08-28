# PM handoff — ISEO Credits go-live

Everything that could be done in code is done and pushed. What remains needs credentials or an
irreversible decision, so it needs a person.

**Read section 0 first. It is time-sensitive.**

---

## 0. URGENT — rotate these credentials

Production secrets were pasted into a chat transcript. Treat all of them as compromised and rotate
them **before** go-live. In rough priority order:

| Secret | Where | Why it matters |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API | Bypasses row-level security — full read/write on the whole database |
| `DATABASE_URL` password | Supabase → Settings → Database | Direct Postgres access |
| `ANTHROPIC_API_KEY` | console.anthropic.com | Billable; abuse costs money immediately |
| `OPENAI_API_KEY` | platform.openai.com | Same |
| `SUPABASE_ANON_KEY` | Supabase → Settings → API | Public-ish, but rotate with the service key |
| `MONGODB_URI` password | MongoDB Atlas → Database Access | Prompt data |
| `MAILGUN_API_KEY` | Mailgun → API keys | Can send mail as your domain |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe dashboard | Test-mode keys, but rotate anyway |

Update each in the Render dashboard as you rotate it. Never commit them — `.env` is gitignored and
must stay that way.

**Separate finding:** your Stripe keys are **test-mode** (`sk_test_` / `pk_test_`) while
`NODE_ENV=production`. If you expect live payments, that is a bug in its own right.

---

## 1. Status — what is already done

| # | Item | Status |
|---|---|---|
| — | Backend code (security, credits, regen, image prompt) | ✅ pushed to `main` |
| — | WordPress plugin code | ✅ pushed to `stable-merges-aug` |
| — | user-cms | ✅ pushed to `main`, Vercel live (HTTP 200) |
| — | admin frontend | ✅ pushed to `main`, Vercel live |
| 6 | **Redeploy the two CMS apps** | ✅ **already done** — both auto-deploy from `main` |

## 2. Status — what still needs you

| # | Step | Blocked on | If skipped |
|---|---|---|---|
| 1 | Set 13 `ISEO_*` vars on Render | Render login | **Server will not boot — full outage** |
| 2 | Set `ADMIN_PASSWORD` | Render login | Admin panel rejects everyone |
| 3 | Redeploy the backend | Render login | Nothing below works; security holes stay open |
| 4 | Run 2 migrations | Step 3 first + a backup | Every generation returns 402 |
| 5 | Pull the plugin update in WordPress | WP admin login | Regen always full price; custom instructions never sent |

---

## 3. Step-by-step

### Step 1 — ISEO variables (do this before redeploying)

Render → your service → **Environment** → **Add from .env** → paste → **Save**:

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

The server **refuses to start** if any is missing. That is deliberate — a server that cannot price
an action must not serve one, and defaulting to `0` would give content away.

**Your decision on the four grants.** These are placeholders derived from your real prices at a 30%
COGS share (`credits = plan_price × 0.30 / 0.0129`). The grant keys match your actual plan slugs —
`free`, `basic`, `starter`, `pro` — which was verified against the database. Note `basic` is the
950-cent plan even though it displays as "Grow".

For reference, what a grant buys: a medium article costs 10, a small 6, a large 14, an image 5.
So `pro = 1150` ≈ 115 medium articles/month.

> If you ever add a plan, add its `ISEO_GRANT_<SLUG>` at the same time. The server now refuses to
> boot if a **paid** plan has no grant, naming the missing variable — added specifically because
> this class of mistake would otherwise silently give paying customers the free allotment.

### Step 2 — Admin access

```
ADMIN_PASSWORD=<a long random string>
```

There are **no admin accounts** — the panel is protected by this one shared password. Anyone who
knows it is an admin; anyone who does not cannot get in. Until it is set, nobody can sign in.

Make it long and random (use a password manager). It guards every credit-granting route, so treat
it like a production secret: never commit it, and share it only with people who need panel access.

To revoke someone's access, change this value and redeploy — that signs everyone out immediately.

This does not block boot, but until it is set nobody can sign in and every admin route returns 503
— including for you. That is intentional: before this release those routes had **no authentication
at all**, so anyone on the internet could grant themselves unlimited credits.

### Step 3 — Redeploy the backend

Render → **Manual Deploy** → *Deploy latest commit* (`main`).

Confirm in the logs:

- `💳 ISEO credit table loaded — sha256:…` — config accepted
- `💳 Synced env credit grants into 4 subscription plan row(s).` — plan coverage passed

If you instead see `Invalid ISEO credit configuration — refusing to start`, it names the missing
variable. Add it and redeploy.

Then confirm the security fix is live:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  https://imporve-seo-admin-server-nzbm.onrender.com/api/admin/prompt-templates
```

Must print **401**. It currently prints **200** — anyone can read it today.

### Step 4 — Migrations ⚠️ irreversible

**Back up the database first.** Supabase → Database → Backups.

**Announce to customers first.** Plan credits are reset to the new allotment; purchased credits are
carried over.

Measured scope against production: **12 users** hold credit rows; **3 of them hold 3,322 purchased
credits** between them. Those 3,322 must survive.

Render → **Shell**:

```bash
npm run migrate:target-key      # adds user_generations.target_key — safe, additive
npm run migrate:iseo-credits    # ⚠️ collapses to one pool and RESETS plan balances
```

Order matters, and both must run **after** step 3. Running them against the old build would delete
rows it still queries, breaking credits for everyone.

Verify:

```sql
SELECT credit_type, COUNT(*) AS users,
       SUM(included_remaining) AS plan, SUM(purchased_remaining) AS purchased
FROM credit_balances GROUP BY credit_type;
```

Expect **one** row, `credit_type = 'iseo'`, 12 users, and `purchased = 3322`. If purchased is not
3322, stop and restore the backup.

### Step 5 — WordPress plugin

The code is on branch **`stable-merges-aug`**.

1. WP admin → **WP Pusher** → Installed packages → confirm the branch it tracks is
   `stable-merges-aug`. If it tracks something else, tell the developer which branch and it will be
   merged across.
2. Click **Update** to pull the latest commit.
3. Hard-refresh the Create Post screen (Ctrl-Shift-R) so the new CSS/JS load.

Then verify both fixes:

- **Typing:** click *Regenerate content* → the instructions box should accept text and the counter
  should climb. (This was the "can't type" bug.)
- **Image:** *Regenerate image* → type `a boy shooting a penalty on a football pitch` → Regenerate.
  The new image should show that scene, not the previous one.

---

## 4. Verification after go-live

Full command list in `docs/API_TESTING_GUIDE.md`. The four that matter most:

| Check | Expected |
|---|---|
| `GET /api/admin/prompt-templates` unauthenticated | **401** (is 200 today) |
| `POST /api/v1/admin/users/1/gift-credits` unauthenticated | **401** |
| Generate, then regenerate the same post | Second charge is **lower** |
| Regenerate an image with an instruction | `data.prompt_used` starts `Photograph exactly this scene:` |

---

## 5. Known limitations to be aware of

1. **Balance reset is not reversible** by rolling the code back. Reverting the code while the
   migration is applied is *worse* — the old build queries per-type rows that no longer exist. If
   you roll back, restore the database too.
2. **Legacy `/generate/*` routes are not overdraft-proof.** Correctly priced, but two simultaneous
   requests can both pass. Only `/content-v2/article` and `/content-v2/image` are atomic.
3. **A wizard reload before regenerating charges full price.** The regeneration key is minted per
   wizard session. Deliberate — failing towards full price is the safe direction.
4. **Rate limit is per server instance.** With N instances the effective ceiling is 120×N/min.
5. **Admin is one shared password, not per-person accounts.** There is no way to tell two
   operators apart, and revoking one person means rotating `ADMIN_PASSWORD` for everyone.
6. **Image fidelity is not guaranteed.** The prompt now instructs the model to depict the user's
   scene and not substitute a different subject, and that wording is tested — but how closely the
   image model obeys is an empirical question. If `prompt_used` is correct and the image still
   ignores it, that is prompt tuning, not a code bug.
