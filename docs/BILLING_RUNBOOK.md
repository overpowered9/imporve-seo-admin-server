# Billing & notifications runbook

Operational guide for the Credits & Subscriptions module. Covers the scheduled
jobs (BILL-007, BILL-008), the email outbox (BILL-006), and the ledger monitor
(BILL-004).

---

## 1. Where the copy lives (for the copy owner)

Final marketing wording for the two lifecycle emails is pending. **Swapping it
in requires changing one file and no logic.**

**File:** `src/services/email.service.ts`
**Functions:** `creditsExpiringPlaceholder` and `inactivityPlaceholder`

Replace only the strings. Every variable is already computed and passed in.

### Credit expiry — `CreditExpiryPayload`

| Variable | Example | Meaning |
|---|---|---|
| `firstName` | `Sam` | First name, or the email local-part |
| `expiringAmount` | `100 credits (50 content, 40 image, 10 keyword)` | What expires, itemised |
| `expiryDate` | `September 1, 2026` | Expiry date, UTC |
| `remainingAfter` | `20 credits` | Balance left after expiry (purchased credits survive) |
| `pieces` | `40` | Complete articles-with-image the expiring credits buy |
| `leadTimeLabel` | `in 14 days` / `today` | Which warning this is |
| `ctaUrl` | `https://…/credits` | Link to the credits page |

### Inactivity — `InactivityPayload`

| Variable | Example | Meaning |
|---|---|---|
| `firstName` | `Sam` | |
| `creditBalance` | `120 credits` | Total available at send time |
| `pieces` | `40` | What that balance buys |
| `nearestExpiry` | `September 1, 2026` or `null` | Next expiry, if any |
| `planName` | `Grow` | Current plan |
| `daysInactive` | `21` | Days since the last generation |
| `ctaUrl` | `https://…/overview` | Link back into the product |

Both templates must keep their `html` **and** `text` parts. A receipt that
renders empty in a plain-text client is a receipt the customer did not get.

⚠️ `LIFECYCLE_EMAILS_ENABLED` stays **false** until this copy is final — the
placeholder subjects literally read `[PLACEHOLDER]`.

---

## 2. Configuration

| Variable | Default | Effect |
|---|---|---|
| `BILLING_EMAILS_ENABLED` | **`true`** | Outbox worker. Set `false` to halt delivery; jobs still queue |
| `LIFECYCLE_EMAILS_ENABLED` | `false` | Notification scheduler. Keep off until copy is final |
| `LEDGER_MONITOR_ENABLED` | `false` | Hourly ledger gap check. Turn on *after* the transactions backfill |
| `CREDIT_EXPIRY_LEAD_DAYS` | `14,3,0` | Lead times. Signed off. Comma-separated days |
| `INACTIVITY_EMAIL_DAYS` | `14` | Consecutive inactive days before the nudge |
| `INACTIVITY_COOLDOWN_DAYS` | `60` | Minimum gap between inactivity emails. Signed off |
| `NOTIFICATION_BATCH_SIZE` | `100` | Rows per page |
| `NOTIFICATION_INTERVAL_MS` | `86400000` | Scheduler period (daily) |
| `EMAIL_WORKER_INTERVAL_MS` | `60000` | Outbox drain period |
| `LEDGER_MONITOR_GRACE_MINUTES` | `15` | How long after an event a missing row is a gap |

Changing lead times is a config edit. No code change, no logic change.

---

## 3. Everyday operations

### See who WOULD be emailed (safe, default)

```bash
npm run notify
```

Dry run. Claims nothing, queues nothing, prints the full recipient list with
the dedupe key each send would use. **Read this list before every first run
after a predicate change** — a wrong predicate here emails real customers.

### Send for real

```bash
npm run notify -- --apply
npm run notify -- --job credit_expiry --apply    # one job only
```

### Flush the email queue by hand

```bash
npm run email:drain                # render only, send nothing
npm run email:drain -- --apply
npm run email:drain -- --apply --limit 100
```

Use after an ESP outage, or to check what is queued before enabling the worker.

### Check for missing ledger rows

```bash
npm run monitor:ledger-gaps
npm run monitor:ledger-gaps -- --grace 60
```

Exits non-zero when gaps are found, so it can be wired to cron/alerting.

### Backfills (dry run by default)

```bash
npm run backfill:payment-defaults            # BILL-001 — run FIRST
npm run backfill:cancellation-flags          # BILL-005 — orphaned schedules
npm run backfill:transactions                # BILL-004 — slowest, run LAST
# add -- --apply to each once the dry-run output looks right
```

---

## 4. Pausing

- **Stop all lifecycle email:** `LIFECYCLE_EMAILS_ENABLED=false`, redeploy.
- **Stop delivery but keep queueing:** `BILLING_EMAILS_ENABLED=false`. Jobs
  accumulate and are delivered when re-enabled — the safer pause, nothing lost.
- **Stop one job:** empty its lead times (`CREDIT_EXPIRY_LEAD_DAYS=`) or set the
  threshold impossibly high (`INACTIVITY_EMAIL_DAYS=99999`).

---

## 5. Verifying sends

Every send attempt is logged with template, event key, recipient and result.
To answer "did this user get their receipt?":

```sql
SELECT template, event_key, status, attempts, sent_at, last_error
FROM   email_sends
WHERE  user_id = :id
ORDER  BY created_at DESC;
```

Statuses: `pending` (queued), `sending` (claimed by a worker), `sent`,
`failed` (will retry), `dead_letter` (gave up — alerted), `suppressed`
(deliberately not sent; `last_error` says why).

Anything stuck in `sending` for more than a few minutes means a worker crashed
mid-batch. Safe to reset:

```sql
UPDATE email_sends SET status = 'pending'
WHERE status = 'sending' AND updated_at < NOW() - INTERVAL '15 minutes';
```

---

## 6. Testing end to end in staging

Seed a near-term expiry on a test account:

```sql
UPDATE credit_balances
SET    cycle_started_at = NOW() - INTERVAL '1 month' + INTERVAL '3 days'
WHERE  user_id = :test_user_id;
```

```bash
npm run notify                    # confirm the account appears
npm run notify -- --apply
npm run email:drain -- --apply
```

For inactivity, backdate the last generation instead:

```sql
UPDATE user_generations SET created_at = NOW() - INTERVAL '20 days'
WHERE user_id = :test_user_id;
```

Mark test accounts `is_internal = TRUE` in production so they are never
included in a real run.

---

## 7. Alerting

| Log pattern | Meaning |
|---|---|
| `🚨 [email-outbox] DEAD LETTER` | An email will never be delivered |
| `🚨 [ledger-monitor]` | A billing event completed with no ledger row |
| `🚨 BILLING DISCLOSURE MISMATCH` | A customer was charged an amount they were not shown |
| `queued N of M scanned — unusually high` | A candidate predicate probably broke |

The disclosure mismatch is the most serious: the confirmation dialog and the
invoice disagreed. Investigate before responding to any dispute.

---

## 8. Stripe test-mode verification (do this before trusting any of it)

None of this module has executed against real Stripe. The prior round's
proration filter read `line.proration`, which is `undefined` on API version
`2025-10-29.clover` — every upgrade would have quoted **$0.00** and it passed
every automated check. Test mode is the gate, not a formality.

```bash
stripe listen --forward-to localhost:8080/api/v1/stripe/webhook
```

Use `sk_test_…` only. Never live.

1. **Upgrade mid-cycle.** The amount in the dialog **must equal** the invoice,
   to the cent.
2. **Decline** (`4000 0000 0000 0002`) — stays in the dialog, retry works.
3. **3DS** (`4000 0027 6000 3184`) — completes without leaving the flow.
4. **Double-click confirm** — one subscription, one charge.
5. **Cancel → resubscribe to a different plan** — banner gone, and check the
   Stripe dashboard for **leftover schedule objects**. This is the silent
   failure most worth seeing with your own eyes.
6. **Leave the confirm dialog open across a billing boundary**, then confirm.
   The stale `proration_date` should be rejected and silently repriced — confirm
   the warning appears in the logs rather than a failed upgrade.
