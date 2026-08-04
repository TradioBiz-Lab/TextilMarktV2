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

  createdAt   Date                auto (= uploadedAt)
  updatedAt   Date                auto
}
```

> For non-stage documents, exactly one of `dataUrl` / `externalUrl` is set. Stage-evidence
> documents (`stageIndex != null`) may have neither if `notes` alone captures the evidence.

**Document Types** (`type` enum):
- General: `PO`, `buyer_order`, `tech_pack`, `cost_sheet`, `RFQ`, `terms`
- Certifications: `compliance_cert`, `factory_audit`, `chemical_cert`,
  `environmental_cert`, `insurance`
- Manufacturer profile: `mfr_profile`
- Stage evidence: `material_po`, `knitting_grn`, `knitting_qc`, `dyeing_grn`, `dyeing_qc`,
  `processing_grn`, `processing_qc`, `cutting_qc`, `stitching_qc`, `final_qc`, `packing_qc`,
  `dispatch_docs`

**Indexes:**
- `{ mfrId: 1, isActive: 1 }` — manufacturer cert queries
- `{ orderId: 1, isActive: 1 }` — order document queries
- `{ expiryDate: 1 }` — expiry alert cron jobs
- `{ uploadedBy: 1 }` — audit queries
- `{ createdAt: -1 }` — list sort (avoids in-memory sort on Atlas)

**Visibility rules:**
| Role         | Can see                                                              |
|--------------|------------------------------------------------------------------------|
| Admin        | All active documents                                                    |
| Buyer        | Docs for their orders + certs of manufacturers assigned to those orders|
| Manufacturer | Their own certs + docs for orders they are assigned to                 |

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
