# Manual Test Checklist — Connect, Login & Credits

One pass ≈ 30 min. Run the full matrix on **Chrome (Windows)**, **Chrome (Mac)**, and **Safari (Mac)** — ideally including the Mac that originally failed.

## Before you start

- You need: a WordPress site with the plugin installed, wp-admin access, and **fresh company-domain emails** (Gmail/Outlook are rejected by design; each verified email works **once ever**).
- Repeat runs need fresh state: a new account **and** a new site domain **and** a new email per grant test. Ask a dev to reset the QA rows between full passes.
- If anything fails, capture: **screenshot + DevTools Console + Network tab** (enable "Preserve log" first), and any `error_id` shown.

## A. Plugin onboarding — create account (happy path)

- [ ] wp-admin → ImproveSEO onboarding → **Create Free Account & Connect** → opens a **new tab** (not a popup window)
- [ ] Sign up with email + password → lands on **"Verify your company email"** step
- [ ] Gmail address → rejected with "use your company email" message
- [ ] Company email → code arrives (**check spam too** — note which folder)
- [ ] Wrong code → "Incorrect code (4 attempts left)" countdown
- [ ] Correct code → tab shows "Connected! Closing…" → WP tab auto-advances to **"Free starter credits have been added"** (screen 3)
- [ ] Finish onboarding → dashboard shows the site connected; credits visible

## B. Sign in (existing account) & skip path

- [ ] "I already have an account — Sign In" → sign in works; **Forgot password?** link opens in a new tab
- [ ] On the verify step choose **"Skip for now"** → still connects, screen 3 shows **"already used free credits / no credits"** variant (not the credits-added one)

## C. Google sign-in in the connect tab ⚠️ (the original Safari failure)

- [ ] "Continue with Google" inside the connect tab → completes without a blocked popup
- [ ] **Safari specifically**: after the Google redirect the flow still finishes — either the WP tab advances automatically **or** the tab redirects back to wp-admin and connects (redirect fallback). No infinite "Connecting your site…"
- [ ] Google-only account later tries password login → gets "This account uses Google sign-in" hint

## D. Repeat-connection rules (one credit grant, ever)

- [ ] Reconnect the same site on the same account → connects, says **reconnected**, no new credits
- [ ] New account + already-used site → connects, "this website already used its free credits"
- [ ] Same account + second site → blocked with **website limit** message (free plan = 1)
- [ ] Re-using an already-used email for the code → "This email has already been used"

## E. Failure behavior (must self-diagnose, never spin forever)

- [ ] Kill Wi-Fi (or enable an aggressive ad-blocker) mid-connect → within ~15 s the **connection check panel** appears and names a likely cause; restore network → retry works
- [ ] On the WP "waiting" screen, wait 20 s → the **"Connect in This Window Instead"** box appears; clicking it completes the flow in the same tab

## F. CMS dashboard flows

- [ ] Login / logout at account.improveseoplugin.com
- [ ] **Forgot password** → reset email arrives → new password works
- [ ] **Magic link** tab → link arrives → signs in
- [ ] Websites page: list loads; **Add Website** = two steps (URL → email verify, skippable); delete own site works
- [ ] Unverified (web) signup tries to log in → sees "verify your email", not "invalid credentials"

## Sign-off

| Browser / OS | Pass | Notes |
|---|---|---|
| Chrome / Windows | ☐ | |
| Chrome / Mac | ☐ | |
| Safari / Mac (original failing machine if possible) | ☐ | |
