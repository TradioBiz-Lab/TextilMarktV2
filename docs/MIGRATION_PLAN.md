# Migration Plan: Vercel + Render → Zoho Catalyst (India DC)

**Goal:** Move the frontend off Vercel and the backend off Render onto Zoho Catalyst,
running on Catalyst's **India (IN)** data center, for data-residency compliance.
MongoDB Atlas stays, but must be on the **Mumbai (ap-south-1)** region.

**Status legend:** ☐ not started · ◐ in progress · ☑ done

---

## Phase 0 — Prerequisites (human steps, before any code changes)

These need a person in a browser — I can't drive OAuth/account flows.

- ☐ **Confirm/create the Zoho Catalyst account on the India DC.**
  The DC is chosen at signup and is **irreversible**. If an existing Zoho account is on
  US/EU, a fresh `.in` account is needed.
- ☐ **Confirm MongoDB Atlas cluster region.**
  Must be Mumbai (`ap-south-1`). If it's not, plan a live migration to a Mumbai cluster
  (separate sub-task — Atlas supports cross-region live migration with minimal downtime).
- ☐ **Create the "tradio" GitHub repo** (empty, no README) under the tradio account/org.
- ☐ **Generate a GitHub Personal Access Token** for the tradio account (classic or
  fine-grained, `repo` scope) — used once to push, then stored in macOS keychain.
- ☐ **Install & authenticate the Catalyst CLI**: `npm install -g zcatalyst-cli`, then
  `catalyst login` (browser auth against the IN-DC account).
- ☐ **Connect Catalyst ↔ GitHub** (Catalyst console → GitHub integration → authorize
  against the tradio GitHub account, scoped to the new repo).

---

## Phase 1 — Get the code onto GitHub (tradio account)

- ☐ `git init` in repo root
- ☐ `.gitignore` review (already exists — verify `node_modules`, `.env`, build output
  (`frontend/dist`) are excluded)
- ☐ Initial commit
- ☐ `git remote add origin https://github.com/<tradio-org>/<repo>.git`
- ☐ Push (`git push -u origin main`) using the tradio PAT

---

## Phase 2 — Scaffold Catalyst project structure

- ☐ `catalyst init` in repo root → choose:
  - **AppSail** resource for the backend
  - **Slate** (or Web Client Hosting, TBD after CLI confirms Slate availability on IN DC)
    for the frontend
- ☐ Review generated `catalyst.json` / project config; reconcile with existing
  `backend/` and `frontend/` folder layout (avoid restructuring more than necessary)

---

## Phase 3 — Backend → AppSail

- ☐ Confirm AppSail Node runtime version matches `backend/package.json` engines
  (currently no `engines` pin — add one to match local Node version)
- ☐ Add AppSail-required config (start command `node src/app.js`, port binding —
  AppSail injects `PORT`, which `app.js` already reads via `process.env.PORT`)
- ☐ Environment variables — move from `.env` (local only) into Catalyst's env var config:
  - `JWT_SECRET`
  - `JWT_EXPIRES_IN`
  - `MONGO_DB_URI` (→ Mumbai Atlas connection string)
  - `FRONTEND_URL` (→ new Slate domain, for CORS allow-list in `app.js`)
  - `RESEND_API_KEY`
  - `NODE_ENV=production`
- ☐ Verify `trust proxy` setting (`app.js:86`) works correctly behind Catalyst's
  reverse proxy — required for `express-rate-limit` keying by real client IP
- ☐ **Rate limiting**: AppSail is a persistent process (unlike serverless Functions), so
  `express-rate-limit`'s default in-memory store continues to work as-is — **no rework
  needed** as long as AppSail doesn't horizontally scale to multiple instances. If AppSail
  autoscaling is enabled, revisit (shared store needed).
- ☐ Smoke-test `/api/health` against the deployed AppSail URL
- ☐ Re-run through each route group manually (auth, orders, documents, users,
  notifications, audit, ribbons, masterOrders, signup) against the new backend URL

---

## Phase 4 — Frontend → Slate (or Web Client Hosting)

- ☐ Update `frontend/src/api.js` `baseURL` — `VITE_API_URL` env var → new AppSail URL
  (or relative `/api` if same-origin via Catalyst routing — **TBD, investigate during
  setup whether Catalyst can route `/api/*` to AppSail under the same Slate domain**)
- ☐ Build: `npm run build` → `frontend/dist`
- ☐ Configure SPA fallback (all routes → `index.html`) — equivalent of
  `frontend/vercel.json` rewrites, in Slate's config
- ☐ Set up custom domain mapping (if a custom domain is in use) + SSL
- ☐ Remove `frontend/vercel.json` once Slate config replaces it

---

## Phase 5 — Cross-cutting: CORS & cookies

- ☐ Update `ALLOWED_ORIGINS` / `FRONTEND_URL` in `backend/src/app.js` to the new Slate
  domain
- ☐ Re-verify cookie settings (`sameSite`, `secure`) in `routes/auth.js` —
  if frontend and backend end up **same-origin** under Catalyst, `sameSite=lax` may be
  usable instead of `none` (simplification, not required)
- ☐ Test full login → session-restore → logout flow end-to-end on new domains

---

## Phase 6 — Cutover

- ☐ Run both old (Vercel/Render) and new (Catalyst) stacks in parallel briefly
- ☐ Update DNS / public URLs to point at Catalyst
- ☐ Monitor logs (Catalyst console) for the first 24–48h — watch for CORS errors,
  rate-limit false positives, Mongo connection issues from new region
- ☐ Decommission Render service
- ☐ Decommission Vercel project

---

## Open questions / decisions to confirm during setup

1. **Slate vs. Web Client Hosting** — Slate is the richer option (custom domains, preview
   deploys); Web Client Hosting docs explicitly say "suitable for basic apps." Default to
   Slate unless CLI/console steers otherwise.
2. **Same-origin routing** — can Catalyst serve the Slate frontend and AppSail backend
   under one domain (`/api/*` → AppSail), simplifying CORS/cookies to same-site? Check
   in Catalyst console once project is scaffolded.
3. **AppSail autoscaling** — if enabled, rate-limiter stores need to move to a shared
   backend (Catalyst Cache or similar). Default assumption: single instance, no change.
4. **Atlas Mumbai migration** — if the current cluster isn't already in `ap-south-1`,
   this becomes its own sub-plan (live migration, connection string rotation, downtime
   window).

---

## Non-goals (explicitly out of scope for this migration)

- No rewrite of MongoDB models/queries — Mongoose + Atlas unchanged structurally.
- No change to auth scheme (custom JWT/bcrypt) — Catalyst Authentication not adopted.
- No change to domain/business logic in `routes/` or `pages/`.
