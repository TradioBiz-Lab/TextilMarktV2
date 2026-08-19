# Tradio — MongoDB Schema Reference

> **Database:** MongoDB Atlas (Mongoose 8)
> **Connection env var:** `MONGO_DB_URI`

---

## Collections Overview

| Collection     | Purpose                                                | ID Type          |
|-----------------|--------------------------------------------------------|------------------|
| `users`         | All portal users (admin / buyer / manufacturer)        | ObjectId         |
| `orders`        | Purchase orders with embedded assignment + stage data  | String (custom)  |
| `masterorders`  | Groups of related orders for the same buyer/season     | String (custom)  |
| `documents`     | Files / certs / stage-evidence linked to orders or MFRs| ObjectId         |
| `notifications` | In-app alerts per user                                  | ObjectId         |
| `auditlogs`     | Immutable action trail (admin-visible)                  | ObjectId         |
| `ribbons`       | Admin-published banner alerts                           | ObjectId         |
| `wikipages`     | Admin-authored Tech Pack/SOP reference pages             | ObjectId         |

---

## 1. `users`

Stores every portal account across all three roles.

```
{
  _id          ObjectId          auto
  email        String            unique, lowercase, required
  passwordHash String            bcrypt hash, required
  role         String            enum: ["admin", "buyer", "manufacturer"]
  adminType    String | null     enum: ["master", "user"] — only for role=admin
  company      String            required
  name         String            required
  phone        String | null
  code         String            max 5 chars, uppercase — company code (e.g. "ZAR", "TPR")
  isActive     Boolean           default: true
  mustChangePw       Boolean     default: false — force password change on next login
  passwordChangedAt  Date | null — JWTs issued before this are invalidated
  createdAt    Date              auto (timestamps)
  updatedAt    Date              auto (timestamps)
}
```

**Indexes:**
- `{ email: 1 }` — unique
- `{ role: 1, isActive: 1 }` — role-based list queries
- `{ code: 1 }` — unique, **partial** (only for `role` in `["buyer", "manufacturer"]`) —
  admins all share `code: "TRD"` and are excluded from the uniqueness constraint

**Rules:**
- `adminType` must be `null` for `buyer` and `manufacturer` roles
- Master admin (`adminType: "master"`) cannot be deactivated
- `code` is always `"TRD"` for admin users; for buyers/manufacturers it must be unique
  (used to build order IDs)

---

## 2. `orders`

Purchase orders with manufacturer splits embedded as a sub-document array, each with its
own dynamic production-stage tracker.
Uses a human-readable custom string `_id` for traceability.

```
{
  _id           String            custom — format: {BUYER}-{MFR}-{CAT}-{SEASON}-{SEQ}
                                  e.g. "ZAR-TPR-TSHRT-SS26-001"
  masterOrderId String | null     → masterorders._id, optional grouping
  buyerId       ObjectId → users  required
  product       String            required (e.g. "Classic T-Shirt"), max 300 chars
  category      String            free-text (trimmed) — NOT enum-restricted server-side;
                                  frontend suggests: TSHRT, JEANS, BEDSH, SHIRT, DRESS,
                                  JACKET, POLO, SHORTS, HOODIE
  season        String            enum: ["SS26","FW26","SS27","FW27","SS28"]
  totalQty      Number            required, min: 1
  delivery      Date              required — target delivery date
  colourways    [{name, code}]    max 40 — the colours this style is made in. Held at order
                                  level so per-colour stages (dyeing, lab dips, FPT/GPT)
                                  generate their checklist items from one list instead of the
                                  names being retyped per step. Names only — a qty-per-colour-
                                  per-size grid is deliberately out of scope.
  callout       String            default: "", max 500 chars — order-level risk/escalation
                                  note, e.g. "delayed a week — lab dip submission slipped"
  assignments   [Assignment]      embedded array, one entry per manufacturer split
  createdAt     Date              auto
  updatedAt     Date              auto
}
```

### Embedded: `assignments`

```
{
  _id       ObjectId            auto (sub-document _id)
  mfrId     ObjectId → users    required — manufacturer assigned
  qty       Number              required, min: 1
  status    String              enum (see Order Status Values below), default: "Processing"
  sub       String              split label — "M1", "M2", … (unique per order)
  note      String              latest free-text note, default: ""
  stages    [Stage]             embedded array — dynamic count, see below
  updatedAt Date                last status/stage change, default: now
}
```

**Order Status Values** (order-level overlay — does NOT reset stage progress):
`Processing` | `On Hold` | `Delayed` | `Delivered`

> ⚠️ This is a flat 4-value enum (`ORDER_STATUS_VALUES` in `backend/src/models/Order.js`),
> **not** the 8-step flow (`Order Confirmed → ... → Delivered`) referenced in some legacy
> frontend constants (`STATUS_FLOW` in `frontend/src/constants.js`). The legacy flow is
> unused by the current schema/API — don't validate against it.

### Embedded: `stages` (per assignment)

Dynamic array — count and names are set per-order at creation time (admin can define
custom stage names, or fall back to the default 12):

```
DEFAULT_STAGE_NAMES = [
  "Lab Dip Approval", "PP Sample",
  "Material Sourcing", "Knitting", "Dyeing", "Processing",
  "Cutting", "Stitching", "Finishing", "Packing", "QC", "Dispatch",
]
```

```
{
  name:       String   required — stage display name
  unitsDone:  Number   default: 0, min: 0 — cannot exceed totalUnits
  totalUnits: Number   required, min: 0 — target quantity for this stage; defaults to the
                       assignment's qty but is independently editable (not every stage
                       tracks the full order qty, e.g. "Lab Dip Approval" might target
                       3 dips, not 600 pieces)
  startDate:  String | null   ISO date string or "NA" — required at creation (planned start)
  eta:        String | null   ISO date string or "NA" — required at creation. The CURRENT
                       (revised) end date — this is the one that moves.
  baselineEta: String | null  the originally planned end date, frozen. See below.
  actualEnd:  String | null   when the stage actually finished. Auto-stamped/cleared
                       alongside `status` (never hand-edited) — see below.
  stageDate:  String | null   date set by manufacturer when working this stage (actual, not planned)
  note:       String   default: "" — latest free-text note for this stage
  description: String  default: "", max 1000 chars — static description of what this
                       stage involves, separate from `note` (the transient last-update note)
  responsibleId: ObjectId | null → users   admin, manufacturer, OR buyer accountable for this stage
  kind:       String | null   enum: ["milestone","checklist","quantity"]. null on documents
                       predating the field — read via stageKindOf(), which resolves null to
                       "quantity" (exactly the old behaviour).
  status:     String | null   enum: ["not_started","in_progress","done"]. null on legacy
                       documents — read via deriveStageStatus(), never raw.
  blocked:       Boolean  default: false — orthogonal to status; a stage can be in_progress
                       AND blocked (two colourways dyeing, the third awaiting a sample)
  blockedReason: String   default: "", max 300 chars
  updates:    [StageUpdate]   embedded array — ticket-style progress log, see below
  materials:  [StageMaterial] embedded array — procurement checklist, see below
  items:      [StageItem]     embedded array — the stage's own deliverables, see below
}
```

**Required at creation:** both `startDate` and `eta` must be an explicit date or the literal
`"NA"` — never blank/null — enforced in `validateAndCreateOrder` (`backend/src/routes/orders.js`).
When both are real (non-`"NA"`) dates, `startDate` must be on or before `eta`. There is
deliberately **no cross-stage date rule** — overlapping windows are legal and expected.

**Stage kinds.** Most real TNA steps are milestones: of the 16 steps in a Cocoblu plan only
Production counts garments. `kind` selects how a stage measures done:

| kind | progress is | `totalUnits` default at creation |
|---|---|---|
| `milestone` | `status` alone | 1 |
| `checklist` | `items[]` — N discrete deliverables | 1 |
| `quantity` | `unitsDone / totalUnits` | the assignment's qty |

**The units mirror.** `status` and `unitsDone` are always written together and can never
disagree. For `quantity` stages units are authoritative and status is derived; for the other
two, status is authoritative and `unitsDone` is set to `totalUnits` when done, else 0. This is
load-bearing: five frontend surfaces find the active stage with `unitsDone < totalUnits`, and
the mirror lets them keep working unchanged across a frontend/backend version skew (Slate
auto-deploys on push, AppSail does not). `totalUnits` must never be 0 on a non-quantity stage —
`0 < 0` is false, which would read as permanently complete.

**Baseline vs revised end date.** `eta` is the live date; `baselineEta` is what was originally
planned, so slippage (`etaVarianceDays`, computed in `enrichOrder`, never stored) is
measurable. Set at creation. For stages predating the field it is captured **lazily**: the
`/eta` and bulk routes write the *pre-update* `eta` into `baselineEta` the first time the date
changes. A read-time `baselineEta ?? eta` fallback alone would be wrong — it moves with `eta`
and pins variance at zero forever. Those stages honestly report 0 days of slippage until their
first revision; the original baseline is genuinely gone and is not invented.

**Actual end date.** `actualEnd` is set the moment a stage's derived `status` reaches `"done"`
(`deriveActualEnd()` in `Order.js`) and cleared back to `null` on reopen — the same
auto-stamp/clear shape already used for `items[].doneDate`. It answers the Excel sheet's
"Actual End Date" column: when a step *really* finished, as distinct from `eta` (when it's due).
Written at the same three call sites as `status`/`unitsDone`: the general stage-update route,
the bulk route, and the `/eta` route's kind-flip branch. Legacy stages read `null` — honest,
since there's no way to know when a pre-existing "done" stage actually closed.

**Checklist full-close gate.** A `checklist`-kind stage cannot have its `status` set to `"done"`
while any of its own `items[]` is still `"pending"` — rejected with a 400 naming how many are
left. No override (unlike the materials gate): this is the stage agreeing with its own
checklist, not an external PO dependency. `milestone` and `quantity` kinds are unaffected.

**Legacy documents are normalized on read, not migrated.** Every order read is `.lean()`, so
Mongoose never applies schema defaults to documents written before a field existed — they come
back `undefined`. `enrichOrder()` is the single serialization point and resolves them there.
Consequence: **a new stage field that isn't added to `enrichOrder` is invisible to the
frontend.**

### Embedded: `stages[].updates`

```
{
  text:   String    required, max 1000 chars
  byUser: ObjectId → users   required
  at:     Date      default: now
}
```

### Embedded: `stages[].materials`

Raw-material/trim procurement checklist for a stage — any stage may have zero or more
lines (not tied to a specific stage name). **Gating rule:** if a stage has 1+ material
lines, `unitsDone` cannot be advanced past its current value while any line's `status`
isn't `"received"` — enforced in the general stage-update route
(`backend/src/routes/orders.js`), applying uniformly to manufacturer updates and admin
Stage Override alike. Stages with an empty `materials[]` are unaffected.

```
{
  name:         String   required, max 200 chars — e.g. "Main fabric — Cotton Spandex"
  requiredQty:  Number   required, min: 0
  unit:         String   default: "" — e.g. "m", "pcs", "kg"
  supplier:     String   default: "" — free text, no separate Supplier collection
  poNumber:     String   default: ""
  expectedDate: String | null   ISO date string or "NA"
  status:       String   enum: ["pending","ordered","received"], default: "pending"
  orderedQty:   Number   default: 0, min: 0
  receivedQty:  Number   default: 0, min: 0
  note:         String   default: ""
}
```

### Embedded: `stages[].items`

The deliverables a `checklist` stage produces — a step is often several things finishing on
different days ("three lab dips, not submitted together"; "Dyeing started: Peacot, Brown,
Olivine to follow"). Distinct from `materials`, which are procurement and **gate** the stage;
items **are** the stage's own work and gate nothing.

```
{
  name:      String   required, max 200 chars — e.g. "Lab Dip — Peacot"
  colourway: String   default: "" — matches an order.colourways[].name when per-colour
  status:    String   enum: ["pending","done"], default: "pending"
  plannedDate: String | null   the originally planned due date, frozen. Same
                       lazy-backfill pattern as stage.baselineEta vs stage.eta — captured
                       on the items-update route the first time `dueDate` is revised.
  dueDate:   String | null   ISO date string or "NA" — the CURRENT (revised) due date
  doneDate:  String | null   stamped automatically when status flips to "done" — this
                       item's "actual" date
  note:      String   default: ""
}
```

Max 60 items per stage. `POST …/items` with `{ fromColourways: true }` fans out one line per
`order.colourways`, so the same colour names aren't retyped on every per-colour step.
`enrichOrder` additionally emits `itemsDone` / `itemsTotal`.

**Who can manage `updates` / `materials` / `items`:** any admin, or the stage's own
`responsibleId`. Manufacturers may only act within their own assignment. **Buyers are denied
outright on all three** — an explicit check, not a side effect of their never being
`responsibleId`, which is no longer true (see the carve-out below).

**Buyer carve-out (narrow, deliberate).** BRD §3 says buyers never write stage fields. One
exception: a buyer who is a stage's `responsibleId` may set that stage's `status`, `blocked`
and `blockedReason` — nothing else. Real TNA plans assign the approval steps (lab dip, FPT/PP/
GPT, final inspection) to the buyer, roughly a third of the plan. Dates, units, notes,
responsibility, materials, items and order status all remain forbidden, on every route.

**Stages are independent.** There is no sequential reset. The previous rule zeroed `unitsDone`
*and* `note` on every later stage on every write — including note-only saves and master
overrides — destroying typed work to maintain a property nothing read, and it is wrong for the
domain: real TNA steps overlap (FPT/PP/GPT samples run concurrently; PP approval starts before
FPT approval closes). Completing a stage while an earlier one is still open now returns a
**non-blocking `warnings[]`** on the response instead.

**Indexes:**
- `{ buyerId: 1, createdAt: -1 }` — buyer order list
- `{ "assignments.mfrId": 1, createdAt: -1 }` — manufacturer order list

**Visibility rule:** manufacturers only ever see their **own** assignment entry —
`enrichOrder()` in `routes/orders.js` filters out other manufacturers' qty/status/notes/stages.

---

## 3. `masterorders`

Optional grouping of related orders for the same buyer (e.g. one season's full program).

```
{
  _id       String            custom — format: MO-{BuyerCode}-{Season}-{NNN}
  buyerId   ObjectId → users  required
  orderName String            required, trim, max 200 chars
  season    String            enum: ["SS26","FW26","SS27","FW27","SS28"]
  createdBy ObjectId → users  required — admin who created it
  createdAt Date              auto
  updatedAt Date              auto
}
```

**Indexes:**
- `{ buyerId: 1, createdAt: -1 }`

**Notes:**
- An `order.masterOrderId` referencing a master order must belong to the **same buyer**
  (enforced at order-creation time).
- Manufacturers cannot list master orders (admin/buyer only, per `routes/masterOrders.js`).

---

## 4. `documents`

Uploaded files, certificates, and production-stage evidence. A document belongs to a
manufacturer, an order, or both — or is stage-evidence tied to a specific stage index.

```
{
  _id         ObjectId            auto
  type        String              enum — see Document Types below
  name        String              required, trim — display name

  mfrId       ObjectId → users    nullable — manufacturer the doc/cert belongs to
  orderId     String → orders     nullable — order the document belongs to

  issueDate   Date                default: now
  expiryDate  Date | null         for certs that expire

  uploadedBy  ObjectId → users    required
  issuer      String | null       issuing authority (e.g. "BSCI Global")
  version     Number              document version, default: 1
  isActive    Boolean             soft-delete flag, default: true

  stageIndex  Number | null       min: 0 — index into the relevant assignment's stages[],
                                  null for non-stage documents
  materialLineIndex Number | null min: 0 — index into stages[stageIndex].materials[],
                                  set only for PO document attachments on a specific
                                  materials/PO checklist line; requires stageIndex
  notes       String | null       free-text context, esp. for text-only stage evidence

  dataUrl     String | null       base64 data URL (inline file)
  externalUrl String | null       external link (e.g. Zoho/Drive share URL)
  fileName    String | null       original file name
  fileSize    Number | null       bytes
  mimeType    String | null       e.g. "application/pdf"

  wikiScope   String | null       enum: ["company","buyer"] — set only for wiki_* types,
                                  see Wiki below
  buyerId     ObjectId → users    nullable — set only when wikiScope is "buyer"

  createdAt   Date                auto (= uploadedAt)
  updatedAt   Date                auto
}
```

> For non-stage documents, exactly one of `dataUrl` / `externalUrl` is set. Stage-evidence
> documents (`stageIndex != null`) may have neither if `notes` alone captures the evidence.
> **Wiki (`wiki_*`) types are the one exception that's stricter, not looser: `externalUrl`
> is required and `dataUrl` is forbidden** — these are always Zoho-hosted links, never an
> inline upload (see Wiki below).

**Document Types** (`type` enum):
- General: `PO`, `buyer_order`, `tech_pack`, `cost_sheet`, `RFQ`, `terms`
- Certifications: `compliance_cert`, `factory_audit`, `chemical_cert`,
  `environmental_cert`, `insurance`
- Manufacturer profile: `mfr_profile`
- Stage evidence: `material_po`, `knitting_grn`, `knitting_qc`, `dyeing_grn`, `dyeing_qc`,
  `processing_grn`, `processing_qc`, `cutting_qc`, `stitching_qc`, `final_qc`, `packing_qc`,
  `dispatch_docs`
- Wiki (link-only): `wiki_inspection_form`, `wiki_fit_comments`, `wiki_photos` — see Wiki below

**Indexes:**
- `{ mfrId: 1, isActive: 1 }` — manufacturer cert queries
- `{ orderId: 1, isActive: 1 }` — order document queries
- `{ expiryDate: 1 }` — expiry alert cron jobs
- `{ uploadedBy: 1 }` — audit queries
- `{ createdAt: -1 }` — list sort (avoids in-memory sort on Atlas)
- `{ buyerId: 1, wikiScope: 1, isActive: 1 }` — wiki visibility queries

**Visibility rules:**
| Role         | Can see                                                              |
|--------------|------------------------------------------------------------------------|
| Admin        | All active documents                                                    |
| Buyer        | Docs for their orders + certs of manufacturers assigned to those orders, plus wiki docs (see Wiki below) |
| Manufacturer | Their own certs + docs for orders they are assigned to, plus wiki docs (see Wiki below) |

---

## 5. `notifications`

Per-user in-app alerts. Never deleted — only marked as read.

```
{
  _id     ObjectId            auto
  toUser  ObjectId → users    required — recipient
  type    String              enum: ["status", "order", "alert"]
  msg     String              required — display text
  orderId String → orders     nullable — associated order (if any)
  isRead  Boolean             default: false
  createdAt Date              auto
  updatedAt Date              auto
}
```

**Indexes:**
- `{ toUser: 1, isRead: 1 }` — unread count queries
- `{ toUser: 1, createdAt: -1 }` — notification feed
- `{ type: 1, createdAt: -1 }` — cert-expiry duplicate-alert check

**Notification types:**
| Type     | Triggered by                                      |
|----------|-----------------------------------------------------|
| `order`  | New order assigned to a manufacturer or buyer       |
| `status` | Assignment status or stage progress changed         |
| `alert`  | Certificate expiring within 30 days, or escalation  |

---

## 6. `auditlogs`

Immutable chronological record of all admin-visible actions. Records are never updated or
deleted.

```
{
  _id       ObjectId            auto
  byUser    ObjectId → users    nullable — who performed the action (null for
                                 unauthenticated events, e.g. failed login by unknown email)
  action    String              required — e.g. "Order Created", "Status Updated",
                                 "Stage Updated", "ETA Adjusted", "Login Failed"
  detail    String              required — human-readable description
  createdAt Date                auto
  updatedAt Date                auto
}
```

**Indexes:**
- `{ byUser: 1 }` — per-user action history
- `{ createdAt: -1 }` — chronological feed

---

## 7. `ribbons`

Admin-published banner alerts shown to buyers/manufacturers (or everyone).

```
{
  _id            ObjectId            auto
  message        String              required, max 160 chars
  type           String              enum: ["urgent", "warning", "info"], default: "info"
  audience       String              enum: ["all", "buyer", "manufacturer"], required
  targetUserIds  [ObjectId → users]  optional — restrict to specific users
  isActive       Boolean             default: true
  expiresAt      Date | null         optional auto-expiry
  createdBy      ObjectId → users    required — admin who created it
  createdAt      Date                auto
  updatedAt      Date                auto
}
```

**Indexes:**
- `{ isActive: 1, audience: 1 }`

---

## 8. `actionitems`

Admin-only task tracker. An admin creates an item, assigns it to another admin,
optionally links it to a customer (buyer) and/or a specific order/TNA stage, sets
priority and an ETA, and logs timestamped free-text progress updates until closing it.
Never shown to buyers or manufacturers.

```
{
  _id         ObjectId            auto
  title       String              required, max 200 chars
  detail      String              default: ""
  assigneeId  ObjectId → users    required — must be an active admin
  createdBy   ObjectId → users    required
  buyerId     ObjectId → users    nullable — customer this item relates to; null = "Internal"
  orderId     String → orders    nullable — set when lifted from a TNA stage
  stageName   String | null       which stage, when lifted from TNA
  source      String              enum: ["custom", "tna"], default: "custom"
  priority    String              enum: ["high", "medium", "low"], default: "medium"
  eta         Date | null         due date
  status      String              enum: ["open", "done"], default: "open"
  updates     [Update]            chronological progress log (see below)
  closedAt    Date | null         set when status becomes "done", cleared on reopen
  createdAt   Date                auto
  updatedAt   Date                auto
}
```

**Embedded: `updates`**
```
{
  text    String              required, max 1000 chars
  byUser  ObjectId → users    required
  at      Date                default: now
}
```

**Indexes:**
- `{ assigneeId: 1, status: 1 }` — "my open items"
- `{ buyerId: 1, status: 1 }` — per-customer grouping

---

## 9. `wikipages`

Admin-authored Tech Pack/SOP reference pages — the "Wiki." Unlike `documents`, this is
never a file: content is typed/pasted as Markdown and rendered as an in-app page. Trim
lists, packaging/wash-care guidance, and similar reference material fold into SOP pages
as their own page rather than getting a separate category. The Wiki's other three
categories (Inspection Form, Fit Comments, Photos) are link-only and live on the
`documents` collection instead (`wiki_*` types, see §4) — those are files that live on
Zoho WorkDrive, not content to author in-app.

```
{
  _id          ObjectId            auto
  title        String              required, trim, max 200 chars
  category     String              enum: ["tech_pack","sop"], required
  bodyMarkdown String              required, max 50,000 chars — plain Markdown text,
                                   sanitized at render time (never trusted as raw HTML)
  wikiScope    String              enum: ["company","buyer"], required
  buyerId      ObjectId → users    nullable — required when wikiScope is "buyer",
                                   forbidden when "company"
  createdBy    ObjectId → users    required
  updatedBy    ObjectId → users    nullable — set on every edit
  isActive     Boolean             soft-delete flag, default: true
  createdAt    Date                auto
  updatedAt    Date                auto
}
```

**Indexes:**
- `{ buyerId: 1, wikiScope: 1, isActive: 1 }`

**Visibility (same rule for `wikipages` and `documents`' `wiki_*` subset):**
| Role         | Can see                                                                 |
|--------------|--------------------------------------------------------------------------|
| Admin        | Everything — the only role that can create/edit/soft-delete              |
| Buyer        | `wikiScope: "company"` pages + `wikiScope: "buyer"` pages where `buyerId` is their own id |
| Manufacturer | `wikiScope: "company"` pages + `wikiScope: "buyer"` pages for any buyer they currently have at least one order-assignment with |

Shared scoping logic lives in `backend/src/lib/wikiAccess.js` (`canAccessWikiScope`,
`resolveAssignedBuyerIds`, `validateWikiScopeShape`) — used by both `wikiPages.js` and
`documents.js` so the two collections can never drift on this rule.

---

## 10. Materials Management + Costing Engine

Six new collections (plus a `stageMaterialSchema` extension, §1 above), all sharing one
`scopeType` discriminator: every `MaterialRequirement`/`CostSheet`/`InventoryMovement` is
tied to **either** a real Tradio `Order` **or** a manufacturer's own private `MfrProject` —
never both. This is what makes Materials Management and Costing a general-purpose
manufacturer tool, not only a Tradio-brokered-order feature.

### `stageMaterialSchema` extension (on `orders`, §1 stage sub-schema)
```
category   String   enum: ["fabric","trim","accessory","other"], default: "other" — planning
                    metadata only, does NOT feed the existing trims-order production gate
colourway  String   default: "" — matches order.colourways[].name
```
Real subdocument `_id` (was `{_id: false}`) so `MaterialRequirement.pushedTo[]` can
reference a line stably — a positional index would silently mis-point after a
stage-insert, stage-delete, or another material-line delete.

### `materialdefinitions` — the catalog
```
{ name, category, defaultUnit, defaultSupplier, spec, isActive, createdBy, createdAt, updatedAt }
```
No `scopeType` — a fabric definition is useful regardless of which client it's for.
All roles read; admin-only write. Optional soft link from requirement/cost-sheet lines
(`materialDefinitionId`) — free-text entry keeps working exactly as before.

### `materialrequirements` — the planning layer, one document per scope
```
{
  scopeType     String    enum: ["tradio_order","mfr_project"]
  orderId       String    → orders, set only when tradio_order
  mfrProjectId  ObjectId  → mfrprojects, set only when mfr_project
  createdBy     ObjectId  → users
  lines: [{
    category, name, materialDefinitionId, colourway, requiredQty, unit, supplier, note,
    status, orderedQty, receivedQty, poNumber,   // authoritative for mfr_project ONLY —
                                                  // for tradio_order these mirror whatever
                                                  // the line is pushed to (see below)
    pushedTo: [{ mfrId, stageIndex, materialLineId, pushedAt, pushedBy }]  // tradio_order only
  }]
}
```
Unique partial indexes — `{orderId}` filtered to `scopeType:"tradio_order"`,
`{mfrProjectId}` filtered to `scopeType:"mfr_project"` — enforce exactly one document
per scope. **Receiving stays single-sourced**: for `tradio_order` lines, the pushed
`stages[].materials[]` line (§1) is the one source of truth for receiving; this
collection's own status/qty fields are derived from `pushedTo[]` at read time, never
written back to directly, so there's never a second place receiving data can drift.
Push-to-stage (Phase 2) is a real, stable-id reference — no name-matching heuristic.

**Visibility**: admin/buyer see the full `tradio_order` document; a manufacturer sees
*only* lines with a `pushedTo` entry naming them (the direct analogue of `enrichOrder`'s
`viewerMfrId` stripping) — on a split order, a manufacturer never sees a competitor's
supplier/PO/quantity data pushed to someone else. `mfr_project` documents are owner-only,
full stop — see Privacy below.

### `costsheets` — fields taken directly from a real Tradio cost sheet
One document per `(scope, mfrId)` — per assignment, not per order, since a split order's
manufacturers author their own costs independently.
```
{
  scopeType, orderId | mfrProjectId, mfrId, styleRef,
  fabricSource  String   enum: ["tradio","buyer"] — TRADIO.md's fabric-risk-ownership rule
  currency, status: enum ["draft","submitted","approved"], submittedAt/By, approvedAt/By,

  // manufacturer-writable while draft (or master, any time — the on-behalf-of escape hatch)
  fabric: { name, unit, consumption, rate, supplier, materialRequirementId, materialRequirementLineId },
  process: [{label,value}], trims: [{label,value}], labelsPackaging: [{label,value}],
  extraLines: [{group: "material"|"labour", label, value}],   // open-ended escape hatch
  labour: { cuttingThreads, making, finishingPacking },
  overheadPct (default 5), rejectionPct (default 3),

  // master-admin only, always — tradio_order scope only, always null for mfr_project
  marginPct, tradioFeePct, finalNegotiatedPrice, negotiatedDiscountPct,

  // actuals — feeds the consumption-moat capture and the inventory ledger
  actualFabricConsumption, actualLabourCost, actualRejectionValue,
  createdBy
}
```
Unique partial indexes mirror `materialrequirements`, additionally keyed on `mfrId`.
**Totals are computed, never stored** — `rawMaterialTotal`, `labourTotal`,
`totalLabourAndRawMaterial`, `overheadValue`, `rejectionValue`, `marginValue`,
`tradioFeeValue`, `priceValue` (exported functions, `backend/src/models/CostSheet.js`),
same "derive, don't duplicate" discipline as `stageEtaVarianceDays`.

**The actual workflow**: manufacturer authors their own base cost (draft) → submits →
master admin reviews, sets the margin/fee layer, approves → only then does the buyer see
`{finalNegotiatedPrice, currency, status}` — never a cost line, never the margin. A
regular (non-master) admin has read access for oversight but cannot touch margin or
approve. Serialization is a deny-list, not positional: manufacturer/buyer responses strip
the four master-only source fields **and** the computed `Margin`/`Tradio fee`/`Price`
outputs derived from them — a manufacturer who authored every other term must never
recover the margin by subtracting their own subtotal from a visible price.

### `mfrmasterprojects` / `mfrprojects` — a manufacturer's own non-Tradio work
The manufacturer-owned mirror of `masterorders`/`orders`, minus TNA: no `buyerId`
(a real Tradio account), no `assignments[]`, no `stages[]` — materials + costing only.
```
mfrmasterprojects: { mfrId, buyerName, season, notes, isActive }
mfrprojects:       { mfrId, mfrMasterProjectId, styleName, buyerName, category, season,
                      totalQty, delivery, colourways: [{name,code}], notes, isActive }
```
**Privacy is the entire point of both collections**: every route scopes to
`mfrId === req.user.id` with **no admin override anywhere** — a deliberate inversion of
this app's normal admin-sees-everything convention. Tradio provides the tool; it does not
gain visibility into a manufacturer's other client relationships. `MaterialRequirement`
and `CostSheet` documents scoped to an `MfrProject` inherit this same wall.

### `inventorymovements` — the Finance-module data seam
Append-only ledger, written automatically (no manual entry) from events that already
exist in this feature — never a new burden for the manufacturer:
```
{ mfrId, materialDefinitionId, materialName, direction: "in"|"out", qty, unit,
  scopeType, orderId | mfrProjectId, orderRef,
  sourceType: "material_receipt"|"consumption"|"manual_adjustment",
  sourceRef: { stageIndex, materialLineId, costSheetId }, occurredAt, note }
```
`in` records a receiving **delta** (never the running total); `out` is written from
exactly one place — the consumption-moat capture — via an idempotent upsert keyed on
`{sourceType, sourceRef.costSheetId, direction}`, so a corrected actual replaces its
movement rather than stacking a duplicate. Unlike `consumptionrecords` (below), this
collection **does** carry `mfr_project` rows — a manufacturer's own stock ledger has to
span all their work to be useful to them — but Tradio can never read that half, same
owner-only rule as everywhere else `mfr_project` data lives. A future Finance module
computes on-hand stock as `sum(in) − sum(out)` grouped by `mfrId + materialName`; order
value is already `costsheets`' computed `priceValue`.

### `consumptionrecords` — the strategic moat (TRADIO.md §4c)
```
{ orderId, orderRef, mfrId, costSheetId, capturedAt, capturedBy,
  trigger: "assignment_delivered",
  garmentType, colourway, fabricSource, fabricWidth, fabricGsm, sizeRatio, unit,
  plannedConsumptionPerUnit, actualConsumptionPerUnit,   // the real datapoint
  totalUnitsProduced, totalActualConsumption, variancePct,
  materialRequirementLineId, note }
```
**Deliberately Tradio-brokered-only — no `scopeType`, the one exception among the scoped
collections above.** Harvesting consumption data out of a manufacturer's private
non-Tradio business would contradict `mfrprojects`' privacy promise; the trigger (an
assignment reaching `Delivered`) structurally can't fire for an `MfrProject` anyway,
since it has no assignments. Idempotent on `{orderId, mfrId, costSheetId}` — a re-`Delivered`
transition never duplicates a row. No browse UI yet; this is data capture for a future
lookup/suggestion feature, not one itself.

---

## Relationships Diagram

```
users ──────────────────────────────────────────────────────────────────┐
  │                                                                       │
  │ (buyerId)        (mfrId in assignments[])      (createdBy)          │
  ▼                  ▼                              ▼                    │
orders ────────── assignments[] ── stages[]     masterorders             │
  │  ▲                                               │                    │
  │  └────────────── (masterOrderId) ────────────────┘                   │
  │ (orderId, mfrId, stageIndex)        (uploadedBy)                     │
  ▼                                      ▼                                │
documents ◄────────────────────────────────────────────────────────────┘

notifications → toUser (users), orderId (orders)
auditlogs     → byUser (users)
ribbons       → createdBy (users), targetUserIds[] (users)
```

---

## Seeding

Run once after setting up your Atlas cluster:

```bash
node src/db/seed.js
```

This clears all collections and inserts the full demo dataset.
