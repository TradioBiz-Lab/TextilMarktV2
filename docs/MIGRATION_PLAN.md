# Migration Plan: Vercel + Render → Zoho Catalyst (India DC)

**Goal:** Move the frontend off Vercel and the backend off Render onto Zoho Catalyst,
running on Catalyst's **India (IN)** data center, for data-residency compliance.
MongoDB Atlas stays, but must be on the **Mumbai (ap-south-1)** region.

**Status legend:** ☐ not started · ◐ in progress · ☑ done

**Overall status: core migration complete.** Backend (AppSail) and frontend (Slate,
GitHub-connected) are both live, wired together, and login/auth works end-to-end.
Remaining work is cleanup (credential rotation, old-stack decommission) — see Phase 6.

---

## Phase 0 — Prerequisites

- ☑ **Zoho Catalyst account on the India DC** — logged in as `rajeev@tradiobiz.com`,
  org "rajeev" (60049849796), project **TradioApp**, confirmed on India DC
  (`timezone: Asia/Kolkata`).
- ☑ **MongoDB Atlas cluster region** — confirmed Mumbai (`ap-south-1`).
- ☑ **GitHub repo** — [TradioBiz-Lab/TextilMarktV2](https://github.com/TradioBiz-Lab/TextilMarktV2).
- ☑ **Catalyst CLI** installed & authenticated (`zcatalyst-cli` v1.26.2).
  Note: `catalyst login` / `catalyst init` / `catalyst deploy appsail` (interactive
  name prompt) all use raw-mode terminal prompts that can't be driven by an agent —
  a human runs these directly; Claude verifies via `catalyst whoami`, generated
  files, or `--name`/other flags that bypass the prompt where possible.
- ☑ **Catalyst ↔ GitHub connection** — done via the Slate "Deploy App" flow (console
  already had `TradioBiz-Lab` org repos listed, no separate OAuth step needed).

---

## Phase 1 — Code onto GitHub

- ☑ `git init`, initial commit, pushed to `TradioBiz-Lab/TextilMarktV2` via the
  `AnkitB-Tradio` collaborator account.

---

## Phase 2 — Scaffold Catalyst project structure

- ☑ AppSail resource **"Textilmarkt"** created, repointed from the placeholder
  `appsail-nodejs/` scaffold to the real `backend/` folder (`catalyst.json` →
  `appsail[0].source: "backend"`).
- ☑ `backend/app-config.json` added — start command `node src/app.js`, stack `node20`.
- ☑ `backend/src/app.js` PORT resolution patched to read
  `X_ZOHO_CATALYST_LISTEN_PORT` before falling back to `PORT`/3001.
- ☑ Slate app scaffolded and repointed to `frontend/` the same way
  (`frontend/cli-config.json`, `frontend/.catalyst/slate-config.toml`).
- ☑ **Gotcha (hit twice):** `catalyst init`/`deploy` operate on the *current working
  directory* — running from `~` instead of the repo root silently scaffolds into the
  wrong place. Always `pwd`-check first.

---

## Phase 3 — Backend → AppSail

- ☑ Env vars set in Catalyst console: `MONGO_DB_URI`, `JWT_SECRET`, `JWT_EXPIRES_IN`,
  `NODE_ENV=production`, `RESEND_API_KEY`, `FRONTEND_URL`, `EMAIL_FROM`.
- ☑ `/api/health` returns `200 {"ok":true,"db":"connected"}`.
- ☑ **Major gotcha — Atlas Network Access.** Atlas's IP allowlist only had two fixed
  IPs whitelisted (from the original Render setup). Catalyst AppSail has no fixed
  outbound IP, so every DB connection attempt hung/failed silently. **Fix:** added
  `0.0.0.0/0` to Atlas's IP Access List. This is the standard approach for PaaS/
  serverless backends without a static-IP add-on (same as Vercel/Render) — security
  then relies on the DB user's password strength, not network-level restriction.
- ☑ **Major gotcha — CORS preflight silently broken at the platform level.**
  Catalyst AppSail's edge answers `OPTIONS` preflight requests itself with a bare
  `200` and **no CORS headers**, before the request ever reaches our Express app's
  own (correctly-configured) `cors` middleware. Real browsers require valid preflight
  headers to proceed with the actual request; `curl` doesn't check CORS at all, which
  made this very hard to isolate (every curl test "worked", every real-browser POST
  failed with a generic `503`). Ruled out along the way: stale cookies, rate limiting,
  API Gateway (confirmed via docs + console — only applies to Functions/Web Client,
  not AppSail), HTTP/2 vs 1.1.
  **Fix implemented:** [frontend/src/api.js](../frontend/src/api.js) sends all request
  bodies as `Content-Type: text/plain` (a CORS-"simple" content type, so browsers skip
  the preflight entirely) while still JSON-encoding the body; `backend/src/app.js`'s
  `express.json()` now also parses `text/plain` bodies to match. This sidesteps the
  platform bug entirely rather than depending on Catalyst to fix it.
- ☑ Database was empty on first connect (fresh Atlas cluster never seeded) — inserted
  the 6 demo users from `backend/src/db/seed.js` directly (users only, no sample
  orders/documents, per explicit request) rather than running the full seed script.
- ☑ Resend email — the hardcoded fallback `from` address (`noreply@textilmarkt.com`)
  used an unverified domain, causing a 403 from Resend's API. Fixed via
  `EMAIL_FROM=TextilMarkt <noreply@tradiobiz.com>` (an already-verified domain) — no
  code change needed since `email.js` already reads this env var with a fallback.
- ◐ `express-rate-limit`'s in-memory store works as-is (AppSail is a single persistent
  process) — **revisit if AppSail autoscaling is ever enabled** (shared store needed).

---

## Phase 4 — Frontend → Slate

- ☑ Deployed via CLI initially, then **migrated to a GitHub-connected Slate app**
  (`textilmarktv2`, source `frontend/` in `TradioBiz-Lab/TextilMarktV2`, branch
  `main`, Auto Deploy on) so future frontend changes deploy automatically on push.
  The original CLI-deployed app and an unrelated legacy `textilmarktv1` (connected to
  the old `TextilMarktV1` repo) were both deleted.
- ☑ `VITE_API_URL` set to the AppSail URL (`.../api`) as a Slate app variable — Vite
  bakes this in at build time, so it's set at deploy-config level, not in a committed
  `.env`.
- ☑ SPA fallback / build path (`dist`) auto-detected correctly by Slate's React+Vite
  preset — no manual rewrite config needed (unlike Vercel's `vercel.json`).
- ☑ Live at `textilmarktv2-yaybylkx.onslate.in`; login confirmed working end-to-end
  by the user (multiple accounts — master, buyer, manufacturer).
- ☐ Custom domain mapping (currently on the auto-generated `.onslate.in` subdomain).

---

## Phase 5 — CORS & cookies

- ☑ `FRONTEND_URL` in AppSail's env vars kept in sync with the live Slate URL (updated
  when the GitHub-connected app replaced the CLI one).
- ☑ CORS resolved via the `text/plain` preflight-avoidance trick (see Phase 3).
- ☑ Full login → session flow verified working cross-origin (Slate domain ↔ AppSail
  domain, different subdomains, cookies working via `withCredentials`).

---

## Phase 6 — Cutover (remaining work)

- ☐ **Rotate exposed credentials** — the Atlas DB user password and the Resend API
  key were both visible in screenshots taken during debugging this session. Treat as
  compromised: reset the Atlas password and regenerate the Resend key, then update
  `MONGO_DB_URI`/`RESEND_API_KEY` in both `backend/.env` and the Catalyst console.
  (`JWT_SECRET` was also exposed twice but has already been regenerated fresh.)
- ☐ Custom domain mapping for the Slate app (optional).
- ☐ Monitor Catalyst logs for a few days under real usage.
- ☐ Decommission the Render service.
- ☐ Decommission the Vercel project.

---

## Non-goals (unchanged)

- No rewrite of MongoDB models/queries — Mongoose + Atlas unchanged structurally.
- No change to auth scheme (custom JWT/bcrypt) — Catalyst Authentication not adopted.
- No change to domain/business logic in `routes/` or `pages/`.
