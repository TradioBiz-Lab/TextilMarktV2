# Tech foundation plan

Phase 0 output, written 18 Nov 2026. Read-only: no code, branch, deployment or database was changed to produce it.
Environments are called **Live**, **Test** and **Standalone** below. "Sandbox" appears only where it is the literal
name of something that exists today (a folder, a database, a Catalyst project).

---

## 1. What I checked, and what I found

How: `git` on both branches (`main` at `eeb3699`, `staging` at `a42bc6e`, both identical to `origin`), a trial merge
with `git merge-tree` (writes nothing), reading the code on both branches, GitHub Actions history (`gh run list`), and
running all four test suites on this Mac (Node 26, the only Node installed here). Secrets were never printed: database
settings were compared by a script that prints only "same host / different host" and database names.

| Claim in the brief | Verdict | Evidence and notes |
|---|---|---|
| main is Live (TradioApp), staging is the hosted sandbox (Textimarkt-Sandbox) | Confirmed | Both CLAUDE.md files; worktrees `TextilMarktV1-main` on `main`, `TextilMarktV1-sandbox` on `staging`. |
| Branches split on 7 Oct 2026, about 112 and 111 commits apart | Confirmed | Merge base `a2d5aec` (7 Oct). main has 112 commits staging lacks, staging has 111 main lacks. **But** about 85 of those on each side are the *same changes* carried across by hand (Releases 3 to 5, the Oct 13-15 UI work, Partner Directory v1, the 27 Oct bug fixes), recorded twice under different commit ids. The real difference is smaller than the counts suggest. |
| Only on main: style import, replen, NPD requests, style-request review queue, top-bar search, locked measurement sheets, hidden factory names | Confirmed, **incomplete** | All present on main and absent on staging. Also main-only, not in the brief: Back that restores filters and scroll (`navState.js`), the Replen phase itself, the Partner Directory upgrades of 27 Oct (Live status, the **Live gate** on assigning manufacturers, brands, NCR/Jaipur/Kolkata clusters, machine count; staging has only the first version), Amazon link shortening, product link editor for customers, notification text with style names, the 3 Nov bug-bash security hardening (`ad9cd52`) and dependency patches (`5299a73`), and ten one-off data scripts. Full table in section 2. |
| Only on staging: PLATFORM_MODE, orgs and teams, party vs actor id, `lib/authz.js`, startup migrations, suppliers/POs, BOM, tech pack reading, cost sheets, stock, goods received, job work, Twilio, demo files | Confirmed, **plus** | Also staging-only: `Counter` numbering, `/api/orgs` and `/api/partners` (brand-manufacturer partnerships, not the Partner Directory), view-as "act" mode, company page and master-admin directory, feature stores, `DataTable`, `nav.js`, the quick-capture camera, hash deep links (`#po=`, `#cost=`, `#grn=`), `/api/health` reporting the mode, and the in-memory local runner `npm run dev:local`. |
| Uploaded files are base64 inside MongoDB | Confirmed, wider than files | `documents.dataUrl`, style `photos` and `imageDataUrl`, `manufacturers.imageData` / `thumbData`, `inboundmessages.dataUrl`, `stylerequests.data` and `styleimportuploads.data` (Buffers); on staging also `attachments.data`. Phase 4 must cover all of these, not just Documents. |
| Live and sandbox databases share one Atlas cluster | Confirmed | Live `.env`, local `.env.sandbox` and the hosted sandbox's `.env` all point at the same host. Both sandboxes use database `textilmarkt_sandbox`. |
| Backend deployed by hand; CI on Node 22, AppSail on Node 20 | Confirmed | `.github/workflows/ci.yml` uses Node 22; `backend/app-config.json` says `stack: node20` on both branches. No `engines` field and no `.nvmrc`. I found no code or dependency that needs more than Node 20, so the gap is a risk, not a live bug. |
| No URL per screen | Confirmed, **partly** | main has none. staging has three hash links (`#po=`, `#cost=`, `#grn=`, via `parseDeepLink` in `App.jsx`) that notifications already use. Phase 5 can build on that. |
| Very large files | Confirmed | Lines on main: `routes/orders.js` 3,173, `AdminOrderDetail.jsx` 2,056, `components/ui.jsx` 1,465, `routes/assistant.js` 889 (1,186 on staging). Next tier: `constants.js` 765, `context.jsx` 755, `QuickStageModal.jsx` 729, `routes/documents.js` 723. |
| Test suites not run; Atlas backups unknown | Tests now run; backups still unknown | See below. I cannot see Atlas, so backups are a Phase 1 task for you. |

### Test results (18 Nov 2026, Node 26 on this Mac)

| Suite | main | staging |
|---|---|---|
| Backend (`node --test`, in-memory MongoDB) | **697 / 697 pass** (92 s) | **1,126 / 1,126 pass** (with `PLATFORM_MODE=tradio`, see finding 1) |
| Frontend (`vitest`) | **183 / 183 pass** (25 files) | **469 / 469 pass** (33 files) |

GitHub Actions agrees: the last runs on `main` (`eeb3699`, plus the weekly scheduled runs on 9 and 16 Nov) and on
`staging` (`a42bc6e`, 27 Oct) are green. I did not run `npm run build` locally; CI builds both on every push.

### New findings the brief did not have

1. **The staging tests quietly change mode from a local file.** The first staging run failed 380 of 1,126 tests,
   all with `NOT_TRADIO_ENABLED`. Cause: `src/app.js` starts with `import 'dotenv/config'`, so the test run loaded
   `TextilMarktV1-sandbox/backend/.env`, which sets `PLATFORM_MODE=standalone`. CI has no `.env`, so CI passes. The
   same line means a test run on your Mac also loads Live's `backend/.env` into memory (the in-memory database guard
   still protects Live, and did). Fix in Phase 2: tests must set the mode themselves and never read `.env`.
2. **Live's connection string names no database.** The Live `MONGO_DB_URI` has no database name and the code passes
   no `dbName`, so MongoDB's driver uses its default database, which is called `test`. Very likely the Cocoblu,
   Fitleasure and Vibemist data lives in a database literally named `test`. Please confirm in Atlas (Phase 1 steps).
   It matters for backups, restores, and because the new "Test" environment must never be confused with it.
3. **Deploys ship the local `.env` file.** There is no `.catalystignore`, and env variables in `app-config.json` are
   empty, so the settings Live runs on come from `backend/.env` on whichever machine runs `catalyst deploy`. Your
   notes from 15 Oct say the hosted sandbox goes down if it is deployed without that file. On main the bundle also
   carries `.env.sandbox`. This blocks any pipeline deploy (Phase 1) until settings live in the Catalyst console.
4. **Startup migrations would run on Live.** staging's `runStartupMigrations` runs in every mode on every boot. On
   Live's data it would: drop the unique index on `users.code` (main relies on it to stop two customers getting the
   same company code), create an Organization for every customer and factory, and create a Partnership for every
   customer-factory pair found in orders. Each step is written to be repeatable, but none has a dry run and none is
   limited to standalone. Phase 2 must gate or reshape this before anything reaches Live.
5. **Two "server picks the id" implementations.** main numbers `id: 'auto'` styles and master orders with a retry
   loop in the routes; staging uses an atomic `Counter`. Converging needs one, and the counter's starting value must
   be seeded above every id already on Live.
6. **The trial merge conflicts in 86 files**, including `orders.js`, `assistant.js`, `documents.js`, `auth.js`,
   `App.jsx`, `api.js`, `caps.js`, `ui.jsx`, `AdminOrderDetail.jsx`, the seed and both lock files. A single
   `git merge` is not a sensible way to converge; see section 4.

---

## 2. Feature by feature

### Only on main (all of this is on Live today)

| Feature | Main files | Proposed in standalone mode | Decision needed? |
|---|---|---|---|
| Style import from Excel/CSV (preview, create as NPD/Replen) | `lib/styleImport.js`, `routes/styleImports.js`, `StyleImportModal.jsx` | **Shared.** A brand imports straight into its own master orders. | Yes, Q1 |
| Customer style-request review queue (master admin approves) | `routes/styleRequests.js`, `StyleRequest`, `StyleRequestsPage.jsx` | **Live only.** In standalone there is no Tradio in the middle to approve. | Yes, Q1 |
| Order replen (delivered styles only) and Tradio's Add replen | `ReplenRequestModal.jsx`, `createReplenFrom` | **Shared**, the brand creates the replen itself; the "delivered only" rule stays. | Yes, Q2 |
| New Product Development request | `NpdRequestModal.jsx`, `CustomerActions.jsx` | Request form **Live only**; in standalone the brand creates the NPD style directly. | Yes, Q2 |
| Top-bar search | `GlobalSearch.jsx`, `search.js` | **Shared**, unchanged (it searches only what the user already has). | No |
| Measurement labels and Locked Measurement (master admin locks) | `routes/documents.js` lock route | **Shared**, but someone other than Tradio must be able to lock. | Yes, Q3 |
| Factory names hidden from customers | `enrichOrder(..., { forBuyer })`, `forViewer` | **Live only.** In standalone the brand chose the factory itself. | Yes, Q4 (confirm) |
| Partner Directory v2 (Live status, brands, clusters, machine count) | `routes/manufacturers.js`, `lib/partners.js` | **Tradio staff only in both modes** (Tradio's private CRM). | No |
| Live gate: only a Live-status manufacturer can be given a style | `lib/liveManufacturers.js` | **Live only.** In standalone a Partnership is the gate. | Yes, Q4 |
| Back restores filters, tabs, scroll | `navState.js`, `App.jsx` | **Shared.** | No |
| Replen phase, Amazon link shortening, product link editor, notification text | `lib/phases.js`, `lib/links.js`, `ProductLinkEditor.jsx`, `notifText.js` | **Shared.** | No |
| Bug-bash hardening and dependency patches (3 Nov) | `ad9cd52`, `5299a73` | **Shared**, and must be re-applied to staging's code paths too, not only kept. | No |
| Kriyaa style-import tools (`preview_style_import`, `create_styles_from_import`) | `routes/assistant.js` | Admins in Live; in standalone, a brand for its own master orders. | Yes, with Q1 |
| One-off data scripts (`setBrand`, `movePhase`, `shortenAmazonLinks` ...) | `backend/scripts/` | Keep on main as history; not features. | No |

### Only on staging (none of this is on Live)

| Feature | Staging files | Live behaviour after convergence |
|---|---|---|
| Platform mode switch | `lib/platform.js`, `/api/health` | Live stays `tradio` (the default when unset). |
| Organizations, teams, party vs actor id | `Organization`, `lib/orgs.js`, `lib/session.js`, `middleware/auth.js` | Applies in both modes: every request gets a party and an actor. This is the deepest change (slice a). |
| One authorization module | `lib/authz.js`, `tests/routeGuards.test.js` | Both modes. Every main-only write route (style requests, replen, lock, product link, import) needs a guard before the guard test passes. |
| Server numbering | `Counter`, `lib/counters.js` | Both modes, replacing main's retry loop (finding 5). |
| Startup migrations | `lib/migrate.js` | Must not touch Live until trialled on a copy (finding 4). |
| Partnerships, `/api/orgs`, `/api/partners`, company page, master directory | `routes/orgs.js`, `routes/partners.js`, `pages/shared/CompanyPage.jsx`, `pages/master/` | Standalone only, or hidden in Live. |
| Suppliers and purchase orders, PO PDF and email | `routes/suppliers.js`, `routes/purchaseOrders.js`, `lib/pdf/`, `pdfkit` | Standalone only (already answers 404 in tradio mode). |
| BOM, tech pack reading, spec sheets, cost sheets | `routes/boms.js`, `routes/costSheets.js`, `routes/specSheets.js`, `lib/bom*`, `lib/costing.js` | Standalone only (404 in tradio mode). |
| Stock, goods received, job work, quick capture | `routes/inventory.js`, `routes/grns.js`, `routes/jobwork.js`, `lib/inventory/` | Standalone only (404 in tradio mode). |
| Twilio WhatsApp adapter | `lib/inbound/twilio.js` | Off unless `WHATSAPP_PROVIDER=twilio`; usable by either mode later. |
| Frontend plumbing: feature stores, `DataTable`, `nav.js`, hash deep links, visual refresh | `stores/`, `nav.js`, `lib/` | Shared; needs care where main's UI moved on since (Shell, Dashboard, Orders). |
| Local in-memory runner | `scripts/dev-local.mjs` | Shared dev tool. |
| Demo range and its files | `db/demo*.js`, `demo-docs/`, `demo-images/` ... | Stays off main (CI guard). |

### Decisions I need from you

- **Q1. Import in standalone.** Should a standalone brand import a sheet straight into styles (my proposal), or should
  its factory approve, the way the master admin does in Live?
- **Q2. Replen and NPD in standalone.** Brand creates them directly (my proposal), or sends them to the factory as a
  request?
- **Q3. Who locks a measurement sheet in standalone?** Options: the brand's owner account; or either side, with the
  other side told. Proposal: the brand.
- **Q4. Live-only rules.** Confirm that "factory hidden from customers" and the Live gate apply in Live only.
- **Q5. Unique company codes in Live.** Teams need several users to share a code, which is why staging drops the
  unique index. Proposal: keep codes unique per Organization (staging already does) and accept losing it on `users`.

---

## 3. Phases, with rough effort

Effort is my working time in sessions like this one, plus your time in consoles. These are estimates from reading the
code, not commitments.

| Phase | What | My effort | Your effort | Size and risk |
|---|---|---|---|---|
| 1. Make Live safe | Backup check and trial restore, `RUNBOOK.md`, Node 20 everywhere (CI, `engines`, `.nvmrc`), move settings out of the deployed `.env` into the console, `.catalystignore`, Test-database separation proposal, pipeline options | 1 to 2 sessions | 1 to 2 hours in Atlas and Catalyst | Small. The settings move is the one step that can take Live down if done wrong; the runbook will have a rollback. |
| 2. Converge | Five slices on an integration branch (section 4) | 8 to 12 sessions, slice (a) alone 3 to 4 | Decisions Q1 to Q5; one trial on a Live copy; review before merge | **Large and the riskiest phase.** I will stop after slice (a) to report before going on. |
| 3. Environments | Tag old staging, rebuild Test from main, new Standalone project and database, CI guard | 1 session | About 1 hour in Catalyst and Atlas | Small, once Phase 2 is merged. |
| 4. Files out of MongoDB | Compare Catalyst Stratus and others against current docs, migration script with dry run | 2 to 3 sessions | Choose the store, create the bucket | Medium: a large data move on Live, but reversible if old fields are kept until verified. |
| 5. Real URLs | Proposal first, then build on staging's hash links, keep Back and saved filters | 2 to 3 sessions | Approve the proposal | Medium: touches every screen's navigation. |
| 6. Split the giant files | Small no-behaviour-change steps, tests green after each | 3 to 5 sessions | Little | Low per step; safest done after Phase 2, so the split is done once. |

---

## 4. How Phase 2 should converge (the merge slices)

**Approach.** Cut `integration/foundation` from `main`. Do not `git merge staging` (86 conflicting files, and much of
staging's history duplicates main's under other ids). Instead, for each slice, bring over staging's new files as they
are, then hand-port staging's changes into the shared files (`orders.js`, `assistant.js`, `documents.js`, `auth.js`,
`App.jsx`, `api.js`, `caps.js`), with main's version as the base, because main is what Live runs. Each slice ends
with both backend suites green in **both** modes and the frontend suite green.

**Slice 0 (groundwork, before a).** Tests never read `.env` and set their own mode; a test helper that runs a file
in both modes; a "Live cannot reach standalone routes" test (every standalone route answers 404 in tradio mode,
and no standalone link or menu entry is in the Live frontend).

**Slice a. Organizations, party and actor ids, authz, counters, migrations.** The deep one. Every `req.user.id`
in main's newer routes (style requests, replen, lock, product link, import, search) must be checked for "party or
person?". Every main-only write route gets an `authz` guard. Counter seeding starts above Live's highest ids.
Migrations become a script with a dry run (and an explicit apply) instead of running silently on boot in Live; for
standalone they can stay on boot. Trialled on a copy of Live's database before you merge.

**Slice b. Suppliers and purchase orders.** Mostly new files; `pdfkit` and fonts arrive. Tenant isolation matrix.

**Slice c. BOM, tech pack reading, cost sheets.** New files plus Kriyaa tools; the `assistant.js` merge is the hard
part.

**Slice d. Stock, goods received, job work.** New files; `poSync` and material-line changes to `orders.js`.

**Slice e. Twilio.** Small; `inbound.js` and the webhook.

**Trial on a copy of Live.** In Phase 1 or early Phase 2 I will give you steps to restore a Live backup into a
separate, clearly named database on a non-Live cluster (or an Atlas snapshot restore). Migrations and the integration
branch are run against that copy only, never against Live, and you compare counts before and after.

---

## 5. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Live data in a database named `test` (finding 2) | A restore, a cleanup or the new "Test" environment could target it by mistake | Confirm in Atlas; set an explicit database name in Phase 1 only after a backup, or at least document it in the runbook. |
| No known backup | One bad script or migration and Live data is gone | Phase 1 first step: confirm backups and do one trial restore. |
| Live and Test share a cluster | A wrong `.env` can point a test at Live; an agent likely touched Live on 17 Oct | Phase 1 proposal: separate cluster or project for Test and Standalone, separate database users. |
| Deploy depends on a local `.env` (finding 3) | Deploy from anywhere else, or a pipeline, would run Live without its settings | Move settings to the Catalyst console, add `.catalystignore`, then verify `/api/health`. |
| Startup migrations on Live (finding 4) | Drops a unique index and writes new collections on first boot | Dry-run script, trial on a copy, explicit apply. |
| Slate deploys the frontend on push, AppSail does not | Merging to `main` puts a new frontend in front of the old backend | Runbook order: deploy backend first, then push `main`. Phase 1 pipeline options address this. |
| Mode typo falls back to tradio | A Standalone deploy with a missing or misspelt `PLATFORM_MODE` quietly becomes the Tradio portal on the Standalone database | Phase 3: the Standalone deploy refuses to start unless the mode is set explicitly. |
| Party vs actor regressions | Wrong id in a check can show one company's data to another | Tenant isolation matrix extended to main-only features, run in both modes. |
| Node 26 here, 22 in CI, 20 on AppSail | A test can pass here and fail on AppSail | Phase 1: Node 20 in CI and locally. |
| Inspection module comes next | Choices here could box it in | Keep files on object storage (Phase 4), keep `SpecSheet` and measurement sheets shareable, keep URLs for a style and a step (Phase 5). |

---

## 6. What I could not verify

- Atlas: tier, backups, snapshot schedule, which database Live really uses, database users. Needs you in the console.
- Catalyst: env variables set in each console project today, and whether the CLI uploads `.env` (inferred from your
  15 Oct note and the absent `.catalystignore`, not observed).
- The size of the base64 data on Live (would need a read of Live, which the rules forbid).
- Behaviour on Node 20 and 22 (only Node 26 is installed here; CI covers 22).
