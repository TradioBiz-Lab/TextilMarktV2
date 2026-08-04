# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is
A B2B textile/apparel order-tracking portal ("Tradio"). Three roles — **admin** (master/user),
**buyer**, **manufacturer** — collaborate on purchase orders that are split across manufacturers
and tracked stage-by-stage through production.

## Commands

There is no root `package.json` — `frontend/` and `backend/` are independent npm projects, run
from their own directories.

```bash
# Backend (Express API), from backend/
npm install
npm run dev     # node --watch src/app.js — auto-restarts on file change
npm start       # node src/app.js — no watch, used in production (Procfile/AppSail)
npm test        # node --test over tests/**/*.test.js (node's built-in runner, no test framework)
npm run test:watch

# Frontend (React + Vite), from frontend/
npm install
npm run dev      # vite dev server, default port 5173
npm run build    # vite build → frontend/dist
npm run preview  # serve the production build locally
```

No lint/format tooling (ESLint/Prettier) is configured in either package — don't assume `npm run lint` exists.

Backend requires a `.env` in `backend/` with at minimum `JWT_SECRET` and `MONGO_DB_URI` (see
`REQUIRED_ENV` in `backend/src/app.js`); `FRONTEND_URL` is additionally required when
`NODE_ENV=production`. The frontend dev server proxies to the backend via `VITE_API_URL`
(defaults to `/api`).

## Current stack
- **Frontend**: React 18 + Vite (no router lib — view state lives in `App.jsx` / `AppProvider`).
- **Backend**: Express 4 + Mongoose 8.
- **Database**: MongoDB Atlas (Mumbai / `ap-south-1` region).
- **Auth**: custom JWT (httpOnly cookie `tradio_token`) + bcrypt. No third-party auth provider.
- **Email**: Resend (optional — silently skipped if `RESEND_API_KEY` unset).
- **Hosting**: migrated from Vercel/Render to **Zoho Catalyst** (India DC) — frontend on
  **Slate** (GitHub-connected, auto-deploy on push to `main`), backend on **AppSail**
  (manual deploy only — see Architecture notes below). See `docs/MIGRATION_PLAN.md`
  (closed/historical) for the full migration write-up.

## Repo layout
```
backend/src/
  app.js              # Express bootstrap, security middleware, route mounting
  db/index.js         # Mongoose connect + model re-exports
  middleware/auth.js  # requireAuth / requireAdmin / requireMaster / sanitizeBody
  models/             # User, Order, Document, Notification, AuditLog, Ribbon, MasterOrder
  routes/             # auth, orders, documents, users, notifications, audit, ribbons,
                       # masterOrders, signup
frontend/src/
  App.jsx             # top-level view router (hand-rolled, no react-router)
  context.jsx         # AppProvider — single global data/actions store
  api.js              # axios client + per-resource API wrappers
  components/Shell.jsx # sidebar/nav shell shared across all three roles
  components/ui.jsx   # shared UI primitives (Btn, Modal, Card, DocCard/PDF viewer, etc.)
  constants.js        # T theme object (design tokens), STATUS_FLOW, DEFAULT_STAGE_NAMES
  pages/{admin,buyer,manufacturer}/...
docs/SCHEMA.md         # MongoDB schema reference (kept in sync with models/)
docs/MIGRATION_PLAN.md # Zoho Catalyst migration plan and status
```

## Architecture notes

- **No router library.** `App.jsx` holds the current view in state and switch-renders the right
  page component per role; navigation is done by calling a passed-down `onNavigate(view, params)`
  function, not by URL. When adding a new page/view, wire it into this switch rather than
  reaching for a routing library.
- **Single global store.** `frontend/src/context.jsx`'s `AppProvider` holds all fetched data
  (orders, users, documents, notifications, etc.) and all mutating actions (`createOrder`,
  `updateStage`, ...) in one React Context — there's no per-feature store. New mutations
  typically get added here, calling into `api.js`, then updating local state optimistically or
  via refetch.
- **Server-side role filtering is load-bearing.** `enrichOrder` in `backend/src/routes/orders.js`
  strips out other manufacturers' assignment data before a manufacturer-role response is sent —
  this is the actual security boundary for cross-tenant data, not a frontend-only concern.
  Buyers are blocked server-side from writing order status/stage fields (BRD §3).
- **CORS preflight workaround.** `frontend/src/api.js` sends all requests as
  `Content-Type: text/plain;charset=UTF-8` (still JSON-encoded) rather than
  `application/json`, and `backend/src/app.js`'s `express.json()` is configured to parse both
  types. This exists because Catalyst AppSail's edge answers `OPTIONS` preflight requests itself
  with no CORS headers before they reach Express — sending a CORS-"simple" content type skips
  the preflight entirely. Don't revert this without re-confirming the platform bug is fixed.
- **Catalyst PORT handling.** `backend/src/app.js` reads `X_ZOHO_CATALYST_LISTEN_PORT` before
  falling back to `PORT`/`3001`, since Catalyst AppSail injects the port under that name.
- **Single-instance assumption.** `express-rate-limit`'s in-memory store, and any in-memory
  sequential order-ID generation (e.g. for bulk order creation), are only safe because AppSail
  runs a single process today. If AppSail autoscaling is ever enabled, both need a shared/
  DB-backed store — track this as one combined item, not two, since the fix is the same shape
  for both.
- **AppSail does not auto-deploy on git push, unlike Slate.** Every backend change needs a
  manual `catalyst deploy --only appsail` from a machine with the CLI authenticated (check
  with `catalyst whoami`) — pushing to `main` alone does nothing for the backend. GitHub
  auto-deploy for AppSail is possible only via a separate **Catalyst Pipelines** setup (its
  own YAML config + console pipeline + git connection), which isn't set up today.
- **There is no separate "Production" Catalyst environment for this project** — only
  "Development" exists, and it's the one actually serving live traffic (confirmed via
  `.catalystrc`: `"project_type": "Live"` on the Development env). The console's
  "Deploy to Production" button does not mean "push the current build live" — it starts
  first-time setup of a brand-new environment, a real one-way infrastructure/billing change.
  Don't click it expecting a routine promote.

## Domain model essentials
- **Order** (`backend/src/models/Order.js`) uses a custom string `_id`
  (e.g. `ZAR-TPR-TSHRT-SS26-001`), with an embedded `assignments[]` array — one per
  manufacturer split. Each assignment has a dynamic `stages[]` array (default 10 stages:
  Material Sourcing → … → Dispatch) tracking `unitsDone/totalUnits`.
- Order status overlay is **4 values**: `Processing | On Hold | Delayed | Delivered`
  (`ORDER_STATUS_VALUES` in `Order.js`). `STATUS_FLOW` in `frontend/src/constants.js`
  (the 8-step `Order Confirmed → ... → Delivered` flow) is **legacy/unused** — don't
  validate against it.
- **Stages are tracked independently — there is no sequential reset.** Real TNA plans run
  steps in parallel (FPT/PP/GPT samples overlap; PP approval starts before FPT approval
  closes). Completing a stage while an earlier one is open returns a non-blocking
  `warnings[]` on the response rather than silently zeroing anything.
- Each stage has a `kind` (`milestone` | `checklist` | `quantity`) and an explicit `status`.
  `status` and `unitsDone` are mirrored server-side and can never disagree — see
  `docs/SCHEMA.md`, and note that the mirror is what keeps the frontend's
  `unitsDone < totalUnits` "active stage" derivations working across a deploy skew.
- `eta` is the current end date; `baselineEta` is the frozen original, so slippage is
  measurable. Legacy stages capture their baseline lazily on first revision. `actualEnd` is
  when the stage actually finished — auto-stamped/cleared alongside `status`, same shape as
  `items[].doneDate`; never hand-edited. A `checklist`-kind stage cannot be marked `done`
  while any of its own `items[]` is still pending (no override) — see `docs/SCHEMA.md`.
- Legacy stage documents are normalized in `enrichOrder` (reads are `.lean()`, so schema
  defaults never apply to them) — **a new stage field not added there is invisible to the
  frontend**.
- Categories are free-text; `season` is enum-restricted (`SS26, FW26, SS27, FW27, SS28`).

## Security posture (preserve all of this during any change)
- helmet + CSP, per-route `express-rate-limit` (login, order-create, escalation, uploads, etc.)
- NoSQL-injection guard: `sanitizeBody` strips `$`-prefixed keys from request bodies
- JWT invalidated on password change via `passwordChangedAt` check
- Request logging redacts password/Authorization fields
- 14 MB JSON body limit (10 MB file → ~13.4 MB base64)
- PDF documents render client-side via `pdf.js` onto a `<canvas>` (`frontend/src/components/ui.jsx`)
  rather than an iframe — Chrome's native PDF viewer refuses to load inside a sandboxed iframe
  lacking `allow-same-origin`, and adding that permission back would reintroduce a real
  `allow-scripts` + `allow-same-origin` sandbox-escape risk for uploaded files. Images (JPG/PNG)
  still render via a plain `<img>`.

## Conventions / gotchas for future work
- `category` on Order is free-text (not enum) — don't add enum validation back.
- `Order._id` is a custom string, not ObjectId — don't assume `mongoose.Types.ObjectId`.
- Buyers can never write order status/stage fields — enforced server-side (BRD §3) — **with
  one narrow, deliberate exception**: a buyer who is a stage's `responsibleId` may set that
  stage's `status`/`blocked`/`blockedReason` and nothing else, because real TNA plans assign
  the approval steps to the buyer. Materials and items routes carry an *explicit* buyer deny;
  do not remove it, as those checks previously excluded buyers only as a side effect of
  buyers never being assignable as `responsibleId`.
- **Tests run against an ephemeral in-memory mongod, never Atlas.** `backend/tests/helpers/db.js`
  overwrites `MONGO_DB_URI` with a `mongodb-memory-server` instance and refuses to start if the
  resulting connection host isn't local — `clearDb()` wipes every collection, and dev and prod
  share one cluster, so that guard is load-bearing. `NODE_ENV=test` also stops `src/app.js` from
  connecting/listening on import and bypasses the rate limiters (a suite would otherwise trip
  `updateLimiter`'s 120/hr). Never point a test at a real URI.
- Tests use node's built-in runner and mint JWTs directly (`tests/helpers/client.js`) rather than
  logging in, to keep bcrypt out of the hot path. The app is bound on port 0 per suite.
