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
  middleware/asyncErrors.js # forwards rejected async handlers to the error handler
  models/             # User, Order, Document, Notification, AuditLog, Ribbon, MasterOrder,
                       # ActionItem, DroppedRecord, InboundMessage,
                       # Organization, Partnership, Counter (standalone product, see below),
                       # Supplier, SupplierItem, PurchaseOrder, Bom, SpecSheet, CostSheet (standalone only)
  routes/             # auth, viewAs, orders, documents, users, notifications, audit, ribbons,
                       # masterOrders, signup, actionItems, assistant (Kriyaa), voice, inbound,
                       # review, floor, dropped, orgs, partners, suppliers, purchaseOrders, boms,
                       # costSheets, specSheets
  lib/                # email, stageMath, notify, redact, dropRecord, sarvam, ai/, inbound/,
                       # platform, authz, orgs, session, orderCreate, counters, migrate,
                       # procurement, poMath, poSync, poDraft, gst, fiscalYear, words, orgProfile, pdf/,
                       # bom, bomMath, bomAggregate, costing, costSheet, specSheet, ai/techpack
frontend/src/
  App.jsx             # top-level view router (hand-rolled, no react-router)
  context.jsx         # AppProvider — single global data/actions store
  api.js              # axios client + per-resource API wrappers
  components/Shell.jsx # sidebar/nav shell shared across all three roles
  components/ui.jsx   # shared UI primitives (Btn, Modal, Card, DocCard/PDF viewer, etc.)
  constants.js        # T theme object (design tokens), STATUS_FLOW, DEFAULT_STAGE_NAMES
  pages/admin/...      # the screens ALL roles use (Dashboard, Orders, Order detail, Documents, ...)
  pages/shared/...     # Reports, Action Items, CompanyPage (standalone: team, partners, privacy switch)
  pages/master/...     # ViewerHome: the master admin's company directory (standalone)
  pages/procurement/... # Suppliers, purchase orders, builder, receive (standalone, manufacturers)
  stores/              # feature stores (createFeatureStore): per-feature lists with live refresh
  pages/buyer/BuyerSubmitReq.jsx  # customer-only 'Submit Requirement'
  caps.js              # what each role may do in the shared screens (mirrors the server rules)
  nav.js               # the sidebar as data, built from caps
docs/SCHEMA.md         # MongoDB schema reference (kept in sync with models/)
docs/MIGRATION_PLAN.md # Zoho Catalyst migration plan and status
```

## Architecture notes

- **Icons come from `frontend/src/icons.jsx` only** (Phosphor under the hood). Never import an
  icon library directly or use emoji/text glyphs (✓ ⚠ × and so on) as icons in the UI. The wrapper
  keeps the old `size` / `strokeWidth` / `fill` props, picks a weight automatically (bold when tiny,
  fill when a `fill` colour is given), and accepts `weight="duotone"` for large decorative icons.
  To use a new icon, add one line to `icons.jsx`; to change the whole look or swap the library,
  change that one file.

- **One portal for every role.** Customers, manufacturers and admins see the same six tabs
  (Dashboard, Action Items, Kriyaa, Orders, Documents, Reports) and the same screens; admins
  also get Review Queue, Audit Log and User Setup. The server returns only the signed-in
  user's own data, and `frontend/src/caps.js` decides which controls each role gets (it mirrors
  the server's rules in `routes/orders.js` and `routes/documents.js`; the server is still the
  real gate). When adding a button to a shared screen, gate it with `capsFor(user)` /
  `canWriteStage(...)` instead of assuming the viewer is an admin. Kriyaa is open to every
  role with a role-scoped toolset (`toolsFor` in `routes/assistant.js`).

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
  Every route that returns an order must go through `enrichFor(order, req)`, never a bare
  `enrichOrder(order)`, or a manufacturer's write response leaks every other split.
  Manufacturers also cannot write plan fields (`eta`, `startDate`, `totalUnits`, `kind`,
  `responsibleId`, `description`); `PLAN_ONLY_STAGE_KEYS` in `routes/orders.js` is the gate.
- **Kriyaa tool input is untrusted.** IDs from the model are validated against strict shapes
  before they go into a loopback URL, and request bodies are rebuilt from an allowlist
  (`stageTarget` / `pick` in `routes/assistant.js`). Don't interpolate tool input into a path.
  Closing or reopening a Delivery step, and any `override`, also need a human confirmation the
  server can see (`adminConfirmed` in `routes/assistant.js`): Kriyaa must have asked, and the admin's
  own latest message must agree. A flag passed by the model cannot stand in for it.
- **Notifications and the audit log are written by the server only.** `lib/notify.js` creates
  cross-user notifications inside the order, document and assignment routes (buyer, plus all
  admins when a manufacturer is the one acting; never the actor). The browser never creates
  notifications or audit entries, so a new mutating route should call `notify` / `AuditLog.create`
  itself. The Audit Log page re-reads on open and loads older entries on demand.
- **Async route errors reach the error handler.** `middleware/asyncErrors.js` patches Express 4
  so a rejected async handler calls `next(err)` instead of hanging the request.
- **CORS preflight workaround.** `frontend/src/api.js` sends all requests as
  `Content-Type: text/plain;charset=UTF-8` (still JSON-encoded) rather than
  `application/json`, and `backend/src/app.js`'s `express.json()` is configured to parse both
  types. This exists because Catalyst AppSail's edge answers `OPTIONS` preflight requests itself
  with no CORS headers before they reach Express — sending a CORS-"simple" content type skips
  the preflight entirely. Don't revert this without re-confirming the platform bug is fixed.
- **`trust proxy` is 1, and that is verified.** AppSail's edge is the single proxy hop: with 1,
  `req.ip` is the real client and a forged `X-Forwarded-For` cannot change it (measured on the hosted
  sandbox). Rate limits rely on this; don't change it unless another proxy is added in front.
- **Catalyst PORT handling.** `backend/src/app.js` reads `X_ZOHO_CATALYST_LISTEN_PORT` before
  falling back to `PORT`/`3001`, since Catalyst AppSail injects the port under that name.
- **Single-instance assumption.** `express-rate-limit`'s in-memory store, and any in-memory
  sequential order-ID generation (e.g. for bulk order creation), are only safe because AppSail
  runs a single process today. If AppSail autoscaling is ever enabled, both need a shared/
  DB-backed store — track this as one combined item, not two, since the fix is the same shape
  for both.
- **Local sandbox.** Local dev and production share one Atlas cluster — `backend/.env.sandbox`
  (gitignored, not committed) points at an explicit, distinct database name
  (`textilmarkt_sandbox`) on that same cluster, so local work never touches real
  Cocoblu/Fitleasure/Vibemist data. Run it with `npm run dev:sandbox` (backend) +
  `npm run dev` (frontend, already proxies to `localhost:3001`), seed sample data with
  `npm run seed:sandbox`. `backend/src/db/seed.js` refuses to run (exits before deleting
  anything) unless it resolves to that exact database name — the real `backend/.env` is
  never read by these scripts. Default to sandbox for routine feature verification
  instead of creating-and-deleting a scratch order in production; reserve real Atlas
  data for changes that genuinely require it (e.g. confirming a live-environment-only
  bug like a cross-site cookie issue).
- **Hosted sandbox.** A second, fully separate Catalyst project — `Textimarkt-Sandbox`
  (id `20878000000293003`) — hosts a live, shareable copy pointed at the same
  `textilmarkt_sandbox` database, so pushing code shows up at a real URL without touching
  `TradioApp`. Lives in a **sibling git worktree**, `../TextilMarktV1-sandbox`, permanently
  bound to that project via its own `.catalystrc` — never toggle the active project inside
  `TextilMarktV1-main` to deploy there, that's the whole point of the separate directory.
  Push commits to the **`staging`** branch (`main` stays production-only); backend deploy is
  manual, same as prod: `cd ../TextilMarktV1-sandbox/backend && catalyst deploy --only appsail`.
  Frontend (Slate) auto-deploys on push to `staging` once connected in console (Configuration →
  Environment Variables → `VITE_API_URL` must point at the sandbox AppSail's `/api` URL — Slate
  needs a manual redeploy after any env var change, it doesn't rebuild automatically). Sandbox
  URLs: frontend `https://textilmarktv2-xhdvrzis.onslate.in`, backend
  `https://textilmarkt-50045068738.development.catalystappsail.in`. **Known gotcha**: Slate's
  edge caches `index.html` aggressively — a plain reload right after a redeploy can serve the
  previous build; append a cache-busting query string (`?v=...`) or wait a bit if a "just
  deployed" change doesn't appear to have landed.
- **Prod URLs** (built from `main`): frontend `https://textilmarktv2-yaybylkx.onslate.in`,
  backend `https://textilmarkt-50042744536.development.catalystappsail.in`. Smoke-check the
  hosted sites signed out only; test logins are for the local build.
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

## Standalone product, organizations and tenant isolation

The same codebase also serves a standalone product: brands and manufacturers transact directly and
Tradio's master admin is a viewer. The only fork is the `PLATFORM_MODE` env var (`tradio`, the default,
or `standalone`; read at call time by `lib/platform.js`). Unset, every behaviour below is the Tradio
portal exactly as before. On Catalyst AppSail it is set in the console (app-config.json holds no env),
and switching a database to standalone leaves every manufacturer not Tradio-enabled until the master
admin enables them in User Setup.

- **Party id versus actor id.** `requireAuth` sets `req.user.id` to the *party*: the organization's
  owner account, which is what orders, assignments, documents and stage owners reference, so every
  existing `req.user.id` comparison works for a whole team unchanged. `req.user.actorId` is the
  *person*. Use the actor for sign-in, the JWT claim, password changes, rate-limit keys (`userKey`) and
  audit attribution; the AuditLog hook swaps `byUser` to the actor itself. `publicUser()` in
  `lib/session.js` is the only shape sent to the browser (party `id`, `actorId`, org flags,
  `platformMode`). Never put `req.user.id` where a person is meant.
- **Organizations.** `Organization` (brand or manufacturer; `tradioEnabled`, `tradioCanView`),
  `Partnership` (brand and manufacturer connected; the only way to create orders between them) and
  `Counter` (atomic numbering). Orgs are created lazily by `ensureOrgForUser` and by startup migrations
  (`lib/migrate.js`). Teammates are `User`s with `orgId` and `orgRole: member`; they share the company
  code, which is why `users.code` is no longer unique.
- **One authorization module, `lib/authz.js`.** Every route that writes an order carries a guard from
  it (`orderWriteGuard`, `requireOrderOwner`, `requirePlanEditor`, `requireAssigner`,
  `requireMasterOrderOwner`, `canCreateOrders`), and `tests/routeGuards.test.js` fails if a write route
  has none. Standalone rules: a brand or manufacturer edits what its own company created; a brand
  assigns manufacturers it is connected with; a manufacturer runs the plan of its own split; Tradio
  staff act only for manufacturers that are active, `tradioEnabled` and `tradioCanView`. Privacy filters
  (`adminOrderVisibility`, `adminDocVisibility`, `privateScopeIds`) hide companies that opted out.
- **Server-numbered IDs.** The browser sends `id: 'auto'` and the server numbers the order or master
  order (`lib/counters.js`), so two people creating at once never clash. `createdBy` and
  `createdByRole` always come from the session (`lib/orderCreate.js` strips anything the client sends).
  **Deploy order matters:** an older backend would store the literal id `auto`, so deploy the backend
  (`catalyst deploy --only appsail`) before the frontend that sends it, in every environment.
- **View as.** Master admin only, in `routes/viewAs.js` and `middleware/auth.js`. Standalone: read-only
  (`VIEW_ONLY` 403 on any write outside a short allowlist) unless started with `act` for a
  Tradio-enabled manufacturer, re-checked on every request; a company with `tradioCanView: false`
  refuses (`VIEW_BLOCKED`) and only its owner can change that (`POST /api/orgs/me/privacy`).
- **Frontend mirrors, the server decides.** `caps.js` has role-level caps (`capsFor`) and per-order
  questions (`orderCaps`, `canEditMasterOrder`, `canEditPlan`, `orderOwner`). Role-level write caps that
  depend on who created an order or which split it is are deliberately admin-only there, so a call site
  that forgets to ask the per-order helper fails closed. A brand or manufacturer never receives a user
  list: choices for customers, manufacturers and step owners come from `/api/partners` (`usePartners`)
  and from the order's own parties.
- **Kriyaa** has agentic order tools (`list_master_orders`, `list_partners`, `create_master_order`,
  `create_order`); the creating ones need a human confirmation the server can see (`userConfirmed`).
- **Tenant isolation is tested, not assumed.** `tests/tenantIsolation.test.js` runs a cross-company
  matrix in both modes (two brands, two manufacturers). Every new resource must be added to it before
  its phase counts as done. Write each new route's scoping with one helper per resource, never a bare
  model read.
- **Procurement: suppliers and purchase orders** (standalone only; `/api/suppliers` and
  `/api/purchase-orders` answer 404 in the Tradio portal, `requireProcurement` in `lib/procurement.js`).
  - *Who.* A manufacturer's own session (a master admin sees it through view-as, read-only unless acting
    for a Tradio-enabled factory). Brands get 403 on both routers and never see who a factory buys from:
    `enrichOrder(..., { hideSupply })` blanks `supplier`, `poNumber`, `supplierId` and `poId` on material
    lines for brands, and `PO_HIDDEN_FROM_BRANDS` (`supplier_po`, `material_po`) keeps those documents
    out of their lists. Suppliers and catalog items carry `visibility: 'private'` (reserved for a future
    marketplace; nothing reads another company's rows).
  - *Scoping.* Every row has `ownerOrgId`; each router has one `mine(req)` helper and answers 404 (never
    403) for another company's id. All three resources are in the `tenantIsolation` matrix.
  - *Money is the server's.* `lib/poMath.js` works in whole paise: tax per line, CGST+SGST when the
    supplier and the factory are in the same state, IGST otherwise, one combined GST figure when a state
    is unknown, round-off to the rupee. The browser mirror is `frontend/src/lib/poCalc.js`; both suites run
    the same cases from `backend/tests/fixtures/poMath.cases.json`, so a drift fails a test. GSTIN check
    characters are validated (`lib/gst.js`, mirrored in the frontend). Client-sent totals are ignored.
  - *Numbers and lifecycle.* `PO-<company code>-<FY>-NNNN` from `allocatePoId` (Indian financial year, in
    IST). draft, then `sending` (an atomic claim; one older than 2 minutes is a crashed send and may be
    retried), then sent, acknowledged, partially received, closed; cancelled is final. Supplier and company
    details are frozen on the PO at send. Receipts tolerate 10 percent over the ordered quantity (cloth is
    measured, not counted).
  - *The order's material lines.* `lib/poSync.js` is the only thing that moves them: send marks a linked
    line ordered (with `poId`, supplier and expected date), receiving brings it in (which opens the
    production step's materials gate), cancelling releases it. A line is found by its recorded position and
    name, falling back to the name alone if steps moved. `lib/authz.js` `mayRunStep` lets a manufacturer
    work the materials and checklist of every step of its own split in standalone (the Tradio portal still
    needs the step's named owner).
  - *PDF and email.* `lib/pdf/` uses pdfkit with Noto Sans bundled in `backend/assets/fonts` (for the rupee
    sign), no browser engine. The as-sent PDF is stored as a `supplier_po` Document: it cannot be uploaded,
    edited or deleted by hand (409), the frontend treats it as a system document (`isSystemDoc`), and it is
    kept out of the order's Compliance tab. Email goes through `sendEmailDetailed` (attachments, reply-to
    the sender, "<company> via TextilMarkt"); with no `RESEND_API_KEY` the PO is still marked sent and the
    UI says nothing was emailed. Tests swap the mailer with `setMailerForTests`.
  - *Frontend.* Lists and the PO's items use `DataTable` (cards on phones). `stores/procurement.jsx` mounts
    the suppliers and POs stores once for every procurement view (`ProcurementProviders`). The builder's
    `reconcileLines` (in `lib/procurement.js`) keeps lines valid when the supplier changes: a catalog tie to
    another supplier's item is dropped (the server refuses it) and blank lines take the new supplier's
    rate by name. Deep link `#po=<id>` opens a PO. On phones the builder adds `has-action-bar` to `body`,
    which lifts the Kriyaa button above the pinned totals bar (`--kriyaa-bottom`).
  - *Deploy.* `pdfkit` is a new dependency (`predeploy` runs `npm install`) and `backend/assets/fonts` ships
    with the backend. Seed data: `seedProcurement` in `db/seed.js` (6 suppliers, 5 catalog items, 3 POs for
    Tiruppur Textiles).
- **Bills of materials, tech pack reading and cost sheets** (standalone only; `/api/boms`,
  `/api/cost-sheets`, `/api/spec-sheets`).
  - *BOM.* One per order and factory (`Bom`), private to the company like POs: sizes with a ratio, colours
    with their pieces, and lines (fabric, process, trims, labels, other) with consumption (per size when it
    differs), wastage, supplier and rate. Quantities are never stored: `lib/bomMath.js` works them on every
    read exactly as the factory's own 5117/5118 fabric plan does (checked against that sheet and against an
    independent implementation; fixture `tests/fixtures/bomMath.cases.json`). Drafts save with optimistic
    concurrency (`updatedAt`); freezing makes the master list (a BOM with AI lines still needing a look
    cannot be frozen); a change after that is `revise`, a new version that keeps the line ids.
  - *Shopping list.* `GET /api/boms/aggregate` groups the latest frozen BOM of every order (or one master
    order) by item, spec, unit, supplier and, for cloth, colour, less what is already on a non-cancelled PO.
    `POST /api/boms/generate-pos` turns it into one draft PO per supplier through `lib/poDraft.js`, the same
    builder hand-made POs use. PO lines carry `bomRefs` that only the server can set (a browser's are
    ignored), which is how a need is not ordered twice and how a cancelled PO gives it back.
  - *Tech pack reading.* `lib/ai/techpack.js` sends the PDF to Claude with a prompt that asks for facts the
    pack states and never a consumption; `POST /api/boms/extract` turns the answer into a draft (lines marked
    `source: 'ai'`, `needsReview`) and keeps the pack's measurement spec as a `SpecSheet` (shared by the order's
    brand and factory, corrected by the factory, used later by QC). Tests swap the reader
    (`setTechPackReaderForTests`); `node scripts/read-techpack.mjs <file.pdf>` runs the real model on a pack
    (needs a valid `ANTHROPIC_API_KEY`; `ANTHROPIC_TECHPACK_MODEL` overrides the model).
  - *Cost sheets.* `lib/costing.js` is the approved Fitleasure core costing sheet line for line (all six real
    styles reproduce its figures; fixture `tests/fixtures/costing.cases.json`). A factory drafts a sheet (seeded
    from a frozen BOM if it likes), `share` freezes that version, tells the brand's team in the app (a
    notification with a `link` such as `#cost=<id>`) and emails them the PDF, and the brand comments and
    approves. Approval is the brand's alone (a Tradio view-as session is read-only, so staff cannot do it for
    them). A change is `revise`, a new version; sharing it marks older ones `superseded`. A brand never sees a
    draft, the factory's `internalNote`, or the BOM it came from. Tradio's fee line is forced to 0 unless the
    factory is managed by Tradio. Routes use `requireCosting` (factory or brand) and scope per side.
  - *Kriyaa.* Factories get `get_bom`, `shopping_list`, `generate_draft_pos` (confirmed: it creates several
    records) and `share_cost_sheet` (confirmed: it tells the customer); factories and brands both get
    `list_cost_sheets` and `get_cost_sheet`. Nothing the model is offered can approve a cost sheet: that is the
    brand's own decision. Every call goes through the caller's session, so scoping applies mechanically.
  - *Frontend.* The BOM is a tab on the factory's order (`pages/bom/`), the Shopping List and Cost Sheets are
    sidebar screens (`pages/procurement/ShoppingListPage.jsx`, `pages/costing/`). The editors keep what a
    person types as strings and work live figures with `lib/bomCalc.js` and `lib/costCalc.js`, which are
    byte-for-byte copies of the server's files (`src/__tests__/mathParity.test.js` fails if either drifts and
    runs both against the backend fixtures). Notifications carry a `link` (`#cost=<id>`) that opens a screen.
    Material lines use the shared `.gl-*` styles (a grid on wide screens, a card per line on phones).
    A bill of materials can also be filled from Excel or CSV (`BOM_COLUMNS` and `linesFromRows` in `lib/bomUi.js`,
    through the shared `SpreadsheetImport`): the rows are appended to the draft for the person to check and save,
    never saved on their own. A supplier is matched to the company's book by name, exactly or by the one
    supplier whose name holds the typed text; ambiguous or unknown names are left blank and counted.
    The plan can be a size and colour grid (each colour's own pieces for every size, `colours[].sizes`; an
    Excel sheet with a column per size imports it): `bomMath.js` then works that colour from its figures, a
    line bought for the whole order over the pieces of each size across the colours, and a cost sheet seeded
    from it averages consumption over the grid's own size mix. The editor never shows half a grid
    (`toDraft` makes the rest whole by the ratio).
  - *Live refresh.* `/api/floor/feed` carries per-company versions: a factory gets `suppliers`,
    `purchase-orders`, `boms` and `cost-sheets`; a brand gets `cost-sheets` (shared ones only).
- **Stock and goods received** (standalone only; `/api/inventory`, `/api/grns`; `requireInventory`, a manufacturer's own
  session). Private to the company like POs, brands get 403 and a posted note's PDF (`goods_receipt`) is hidden from them.
  - *The ledger is the truth.* `StockLedger` rows are never edited or deleted; a balance is their sum
    (`lib/inventory/stock.js`), per item and location (`store` or `jw:<supplierId>` for stock held by a job worker).
    Each row has a unique `key`, so writing a movement twice records it once. `takeStock` never lets a location go
    below zero, even when two issues race: the row written later loses and is removed.
  - *A goods received note (`Grn`)* is drafted (from a PO's outstanding lines, by hand, by Kriyaa or from a challan
    photo), checked, and posted by `lib/inventory/grn.js`: claim, ledger rows, the PO's receipt (guarded by the GRN id),
    material lines, PDF, posted. Posting again after a crash finishes the job without receiving twice. The number is
    given at posting. `POST /purchase-orders/:id/receive` is now a thin wrapper that makes and posts a GRN, so every
    receipt has a number, a PDF and a stock movement. Stock gets `qty - rejectedQty`; over 10% over the PO is refused.
  - *Items* are named as the factory writes them (`name` + `unit` make the `key`); a received line with no item finds
    or makes one (`itemFor`, `guessCategory`). Evidence photos are `Attachment`s (one request each, magic-byte checked,
    at most 12 a note, kept after posting), never `Document`s.
  - *Issues to orders* (`StockIssue`) are how what an order really used is known; a return only takes back what was
    issued to that order. A count (`/adjustments`) puts the book right and needs a reason.
- **Run it locally.** `npm run dev:local` (backend) starts an ephemeral in-memory mongod, seeds a
  standalone environment and blanks the email key, so nothing touches Atlas and no email is sent. It
  uses the same seed logins as `npm run seed:sandbox` (never run that against the shared sandbox DB
  casually: it wipes it).

## Domain model essentials
- **Order** (`backend/src/models/Order.js`) uses a custom string `_id`
  (e.g. `ZAR-TPR-TSHRT-SS26-001`), with an embedded `assignments[]` array — one per
  manufacturer split. Each assignment has a dynamic `stages[]` array (default 13 stages:
  Lab Dip Approval, PP Sample, Material Sourcing → … → Dispatch, Delivery; imported or custom
  TNAs can have any number) tracking `unitsDone/totalUnits`. **Every plan ends in a mandatory
  Delivery step** (`isDelivery`); closing it marks that split `Delivered`, reopening it reverts
  it to `Processing`. See docs/SCHEMA.md.
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
- **Dropping is recorded.** Deleting a style or an empty master order first writes a `DroppedRecord`
  (full snapshot, who, when, why), then removes the live document; a failed record write aborts the
  drop. Admins edit master orders (name, season) and drop styles from the Orders page; the record is
  viewable on the Audit Log page. See docs/SCHEMA.md.
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
- **Buyers never write the Delivery step**, even when they own it: closing it marks the split
  Delivered. Only Tradio or the manufacturer confirms delivery (enforced in `routes/orders.js`, and
  hidden in `caps.js`).
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
