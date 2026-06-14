# Tradio (TextilMarkt) — Project Context

## What this is
A B2B textile/apparel order-tracking portal ("Tradio"). Three roles — **admin** (master/user),
**buyer**, **manufacturer** — collaborate on purchase orders that are split across manufacturers
and tracked stage-by-stage through production.

## Current stack
- **Frontend**: React 18 + Vite (no router lib — view state lives in `App.jsx` / `AppProvider`),
  hosted on **Vercel**.
- **Backend**: Express 4 + Mongoose 8, hosted on **Render** (via `Procfile`).
- **Database**: MongoDB Atlas.
- **Auth**: custom JWT (httpOnly cookie `tradio_token`) + bcrypt. No third-party auth provider.
- **Email**: Resend (optional — silently skipped if `RESEND_API_KEY` unset).

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
  pages/{admin,buyer,manufacturer}/...
docs/SCHEMA.md         # MongoDB schema reference (kept in sync with models/)
```

## Domain model essentials
- **Order** (`backend/src/models/Order.js`) uses a custom string `_id`
  (e.g. `ZAR-TPR-TSHRT-SS26-001`), with an embedded `assignments[]` array — one per
  manufacturer split. Each assignment has a dynamic `stages[]` array (default 10 stages:
  Material Sourcing → … → Dispatch) tracking `unitsDone/totalUnits`.
- Order status overlay is **4 values**: `Processing | On Hold | Delayed | Delivered`
  (`ORDER_STATUS_VALUES` in `Order.js`). `STATUS_FLOW` in `frontend/src/constants.js`
  (the 8-step `Order Confirmed → ... → Delivered` flow) is **legacy/unused** — don't
  validate against it.
- Updating stage N resets stages N+1.. to 0 (production is sequential).
- Manufacturers only ever see their own assignment (`enrichOrder` in `routes/orders.js`
  filters out competitors' data server-side).
- Categories are free-text; `season` is enum-restricted (`SS26, FW26, SS27, FW27, SS28`).

## Security posture (preserve all of this during any migration)
- helmet + CSP, per-route `express-rate-limit` (login, order-create, escalation, uploads, etc.)
- NoSQL-injection guard: `sanitizeBody` strips `$`-prefixed keys from request bodies
- JWT invalidated on password change via `passwordChangedAt` check
- Request logging redacts password/Authorization fields
- 14 MB JSON body limit (10 MB file → ~13.4 MB base64)

## In-flight initiative: Zoho Catalyst migration
Goal: remove Vercel + Render, move both frontend and backend to **Zoho Catalyst on the
India (IN) data center**, for data-residency reasons. MongoDB Atlas stays — but must be
confirmed to run in the **Mumbai (ap-south-1)** region.

- **Backend** → Catalyst **AppSail** (persistent Express hosting — closest to Render,
  preserves in-memory rate limiting and the Mongoose connection pool).
- **Frontend** → Catalyst **Slate** (static SPA hosting with SPA fallback + custom domains).
- **Auth** stays custom JWT/bcrypt — no Catalyst Authentication needed.
- **GitHub**: repo will live under a separate "tradio" GitHub account/org (not the user's
  personal account), connected to Catalyst's GitHub deploy integration.

See `docs/MIGRATION_PLAN.md` for the step-by-step plan and current status.

## Conventions / gotchas for future work
- `category` on Order is free-text (not enum) — don't add enum validation back.
- `Order._id` is a custom string, not ObjectId — don't assume `mongoose.Types.ObjectId`.
- Buyers can never write order status/stage fields — enforced server-side (BRD §3).
