# Migration Plan: Vercel + Render → Zoho Catalyst (India DC)

**Goal:** Move the frontend off Vercel and the backend off Render onto Zoho Catalyst,
running on Catalyst's **India (IN)** data center, for data-residency compliance.
MongoDB Atlas stays, but must be on the **Mumbai (ap-south-1)** region.

**Status legend:** ☐ not started · ◐ in progress · ☑ done

---

## Phase 0 — Prerequisites (human steps, before any code changes)

These need a person in a browser — I can't drive OAuth/account flows.

- ☑ **Zoho Catalyst account on the India DC** — logged in as `rajeev@tradiobiz.com`,
  org "rajeev" (60049849796), project **TradioApp** confirmed on India DC
  (`timezone: Asia/Kolkata` in `.catalystrc`).
- ☑ **Confirm MongoDB Atlas cluster region.**
  Confirmed: Mumbai (`ap-south-1`). No cluster migration needed.
- ☑ **Create the "tradio" GitHub repo** — [TradioBiz-Lab/TextilMarktV2](https://github.com/TradioBiz-Lab/TextilMarktV2),
  code pushed (see Phase 1).
- ☑ **GitHub push access** — working via AnkitB-Tradio collaborator account.
- ☑ **Install & authenticate the Catalyst CLI** — `zcatalyst-cli` v1.26.2 installed,
  logged in as `rajeev@tradiobiz.com`. (Note: `catalyst login` and `catalyst init`
  both use interactive arrow-key/list prompts that require a real terminal — Claude
  cannot drive these directly; the human runs them, Claude verifies via
  `catalyst whoami` / checking generated files afterward.)
- ☐ **Connect Catalyst ↔ GitHub** (Catalyst console → GitHub integration → authorize
  against the tradio GitHub account, scoped to `TradioBiz-Lab/TextilMarktV2`).

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

- ☑ `catalyst init appsail --force` → created AppSail resource **"Textilmarkt"**
  (scaffolded initially into a placeholder `appsail-nodejs/` folder with a hello-world
  Express app).
- ☑ Reconciled scaffold with existing backend — rather than keeping a separate
  placeholder folder:
  - `catalyst.json`'s `appsail[0].source` repointed from `appsail-nodejs` → `backend`
  - Added `backend/app-config.json` (AppSail's required config: start command
    `node src/app.js`, stack `node20`, memory 256MB — **stack version to be confirmed
    against Catalyst console's supported list before deploy**)
  - Patched `backend/src/app.js` PORT resolution to read
    `X_ZOHO_CATALYST_LISTEN_PORT` (what AppSail actually injects) before falling back
    to `PORT`/3001
  - Deleted the placeholder `appsail-nodejs/` folder and `catalyst-debug.log`
  - Added `.catalystrc` and `catalyst-debug.log` to `.gitignore` (machine-local CLI
    state, not shared project config — same rationale as gitignoring `.vercel/`)
- ☑ `catalyst init slate --force` → created Slate app **"textilmarkt"** (React + Vite
  preset, auto-detected). **Gotcha hit twice**: `catalyst init` operates on the current
  working directory — running it from `~` (home) or forgetting `cd` into the repo
  scaffolds into the wrong place entirely. Always `pwd`-check before running
  `catalyst init`/`project:use`.
- ☑ Reconciled Slate scaffold with existing `frontend/` (same pattern as AppSail):
  - `catalyst.json`'s `slate[0].source` repointed to `frontend`
  - Copied the two files Slate needs into `frontend/`: `cli-config.json` (dev command)
    and `.catalyst/slate-config.toml` (framework `react-vite`, install `npm install`,
    build `npm run build`, build path `dist`, deployment `default`) — all match our
    existing Vite config already, no changes needed there
  - Deleted the placeholder `textilmarkt/` scaffold folder + `catalyst-debug.log`
- ☑ Commit `catalyst.json`, `backend/app-config.json`, `frontend/cli-config.json`,
  `frontend/.catalyst/slate-config.toml` to the repo

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
