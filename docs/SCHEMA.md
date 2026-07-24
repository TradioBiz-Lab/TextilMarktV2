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
  eta:        String | null   ISO date string or "NA" — required at creation (planned end)
  stageDate:  String | null   date set by manufacturer when working this stage (actual, not planned)
  note:       String   default: "" — latest free-text note for this stage
  description: String  default: "", max 1000 chars — static description of what this
                       stage involves, separate from `note` (the transient last-update note)
  responsibleId: ObjectId | null → users   admin or manufacturer accountable for this stage
  updates:    [StageUpdate]   embedded array — ticket-style progress log, see below
  materials:  [StageMaterial] embedded array — procurement checklist, see below
}
```

**Required at creation:** both `startDate` and `eta` must be an explicit date or the literal
`"NA"` — never blank/null — enforced in `validateAndCreateOrder` (`backend/src/routes/orders.js`).
When both are real (non-`"NA"`) dates, `startDate` must be on or before `eta`.

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

**Who can manage `updates`/`materials`:** the order's admin (any), or — for `materials`
specifically — the stage's own `responsibleId` (admin or manufacturer) in addition to any
admin. Manufacturers may only act on stages within their own assignment.

**Sequential progress rule:** when stage *N* is updated, all stages *N+1…* are reset to
`unitsDone: 0, note: ""` — production is treated as strictly sequential, you cannot be
"ahead" on a later stage.

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
