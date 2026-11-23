# Runbook: deploy, roll back, back up

For Ankit, and for anyone (person or agent) who ships TextilMarkt. Written 18 Nov 2026 in Phase 1 of the tech
foundation programme (`docs/FOUNDATION_PLAN.md`). Where a step depends on something not yet confirmed, it says so.

Golden rules:

1. **Backend first, then frontend.** Slate rebuilds the frontend the moment `main` is pushed; AppSail (the backend)
   only changes when someone runs `catalyst deploy`. A new frontend talking to an old backend is how things break.
2. **Deploy only committed code that CI has passed.** Never deploy a folder with uncommitted changes in it.
3. **Never run scripts, seeds or `node src/app.js` against Live's database** from a laptop. Tests use an in-memory
   database and do not read `backend/.env` (`src/loadEnv.js`).
4. **Write down what you deployed** (the tag, step 4 below). Rollback is "deploy the previous tag".

---

## 1. What exists today

| | Live | Test (today: the "hosted sandbox") |
|---|---|---|
| Git branch | `main` | `staging` |
| Folder on Ankit's Mac | `TextilMarktV1-main` | `TextilMarktV1-sandbox` |
| Catalyst project | `TradioApp` | `Textimarkt-Sandbox` (id 20878000000293003) |
| Frontend (Slate) | https://textilmarktv2-yaybylkx.onslate.in | https://textilmarktv2-xhdvrzis.onslate.in |
| Backend (AppSail) | https://textilmarkt-50042744536.development.catalystappsail.in | https://textilmarkt-50045068738.development.catalystappsail.in |
| Database | the shared Atlas cluster, **very likely the database named `test`** (to confirm, section 5.2) | same cluster, database `textilmarkt_sandbox` |
| Mode | tradio (no `PLATFORM_MODE`) | standalone (`PLATFORM_MODE=standalone`) |
| Where its settings come from | `TextilMarktV1-main/backend/.env`, uploaded with each deploy | `TextilMarktV1-sandbox/backend/.env`, uploaded with each deploy |

"Development" is the only Catalyst environment in each project and it is the one serving traffic. **Never click
"Deploy to Production"** in the Catalyst console: it creates a new paid environment, it does not promote a build.

Node: AppSail's managed runtimes go up to Node 20 (`backend/app-config.json`: `"stack": "node20"`). CI tests on 20 and
22; `.nvmrc` says 20 for local work. Node 20 stopped getting security fixes from the Node project in April 2026; moving
off it needs either a newer AppSail runtime from Zoho or a custom (container) runtime. Tracked as a later decision.

---

## 2. Before every Live deploy

- [ ] The change is committed on `main` locally, and the same commit is green in CI
      (GitHub, repository TextilMarktV2, Actions tab, or `gh run list --branch main`).
- [ ] `git status` in `TextilMarktV1-main` shows nothing uncommitted.
- [ ] If it changes data shape or adds a script, it was tried on Test first.
- [ ] You know the tag of what is live now (section 4), so you can go back to it.
- [ ] It is a quiet time for customers (Indian working hours are busiest).

## 3. Deploy to Live

From Terminal on the Mac where the Catalyst CLI is signed in:

```bash
cd "/Users/ankitbera/Documents/Claude/Projects/Tradio Consolidated/TextilMarktV1-main"
```

```bash
catalyst whoami
```

Check it shows the Tradio account. Then deploy the backend:

```bash
cd backend && catalyst deploy --only appsail
```

Wait for it to finish, then check the backend from outside (it should say `"ok":true`, `"db":"connected"`, `"node":"20"`):

```bash
curl -s https://textilmarkt-50042744536.development.catalystappsail.in/api/health
```

If that is not right, stop and roll back the backend (section 6). If it is right, push the frontend:

```bash
cd .. && git push origin main
```

Slate rebuilds in a few minutes. Open the Live site **signed out** with `?v=` and the time on the end (Slate caches the
old page), for example `https://textilmarktv2-yaybylkx.onslate.in/?v=1518`, and check the sign-in page loads.

## 4. Record what is live (one command after a good deploy)

Run it inside `TextilMarktV1-main` (the `Tradio Consolidated` folder above it is not a git repository):

```bash
T=live-$(date +%Y-%m-%d)-1 && git tag $T && git push origin $T
```

Push the one tag by name, never `--tags`, which would also publish unrelated local tags (such as
`archive/tna-2026-10`). Use `-2`, `-3` for a second deploy the same day. `git tag --list 'live-*'` shows the history. Tags are never moved
or deleted; a new deploy gets a new tag.

**The first tag.** No `live-*` tag exists yet. Live's backend was last deployed from `eeb3699` (3 Nov), if nothing has
been deployed since; once you confirm that, tag it so there is something to roll back to:
`git tag live-2026-11-03-1 eeb3699 && git push origin live-2026-11-03-1` (inside `TextilMarktV1-main`).

---

## 5. Backups (Phase 1: please do these once, then every quarter)

Nobody knows today whether Live is backed up. These steps find out, and prove a restore works. Menu names in Atlas
move around a little; if a name differs, look for the nearest match and tell me what you saw.

### 5.1 Find the cluster tier and whether backups are on

1. Open https://cloud.mongodb.com and sign in.
2. Top left, pick the **organization** and then the **project** that holds the TextilMarkt cluster.
3. Left menu: **Clusters** (sometimes called **Database**). You see one cluster card.
4. On the card, note the **tier** label: `M0` (free), `Flex`, `M2`/`M5` (older shared), or `M10` and up (dedicated).
5. Left menu: **Backup**. Note what it shows:
   - **M0:** Atlas has no backups at all for free clusters. Live has **no backup** today. Go to 5.3 Path B now.
   - **Flex / M2 / M5:** one automatic snapshot a day, cannot be turned off, no on-demand snapshots. Note the date
     of the newest one and how many are kept.
   - **M10+:** note whether **Cloud Backup** is on, the schedule (Snapshot Schedule), and the newest snapshot date.
6. Send me: the tier, whether backups are on, the newest snapshot date, and how many are kept.

### 5.2 Confirm which database Live uses, and how big it is

1. On the cluster card, click **Browse Collections** (Data Explorer).
2. The left column lists databases. Look for one holding `users`, `orders`, `masterorders`, `documents`.
   I expect it to be called **`test`**, because Live's connection string names no database and MongoDB's default is
   `test`. You should also see `textilmarkt_sandbox` (Test).
3. Note the **storage size** of each database (shown beside its name, or in the cluster's Metrics tab).
4. Send me: the database names and sizes. **Do not rename or delete anything.**

### 5.3 One trial restore (never into the Live cluster)

The restore goes into a **new, separate Atlas project**, so a slip cannot touch Live. This project also becomes the
home of Test later (Phase 1 proposal, section 8 of this file).

**Create the safe target first**

1. Atlas, top left project picker, **New Project**. Name it `TextilMarkt Test`. No members to add. Create.
2. In it, **Create** a cluster. If 5.2 showed Live under about 400 MB, the free **M0** is enough; otherwise
   **Flex**. Region: **Mumbai (ap-south-1)**, same cloud provider as Live. Name it `test-restore`.
3. **Database Access**, add a user `restore-admin` with a generated password, role "Read and write to any
   database". Save the password in your password manager.
4. **Network Access**, add your current IP.

**Path A: restore an Atlas snapshot (Flex / M2 / M5 / M10+ only)**

1. Go back to the **Live project**, left menu **Backup**, **Snapshots**.
2. On the newest snapshot, choose **Restore** (or the `...` menu, then Restore).
3. Choose **Restore to another cluster**, then the project **TextilMarkt Test** and the cluster **test-restore**.
   **Stop and re-read the target before confirming: a restore replaces everything in the target cluster. It must
   say `test-restore`, never the Live cluster.**
4. Confirm. It takes minutes to an hour. If Atlas refuses because of the tier (Flex snapshots cannot go to every
   tier), make `test-restore` a Flex cluster and try again, or use Path B.

**Path B: copy with MongoDB's own tools (works on every tier, including M0)**

You run these yourself; never paste a connection string into a chat. Install the tools once:

```bash
brew install mongodb/brew/mongodb-database-tools
```

In the **Live** project, Database Access, add a temporary user `backup-reader` with the role "Only read any
database". Get its connection string from the cluster's **Connect**, **Drivers** screen. Then, in a folder outside
the code, for example your Desktop:

```bash
mongodump --uri "PASTE-LIVE-READER-STRING-HERE" --db test --gzip --archive=live-$(date +%Y-%m-%d).gz
```

(If 5.2 showed Live under another name, put that name after `--db`.) Then load it into the safe target, using the
`test-restore` connection string and the `restore-admin` user, under a name that cannot be mistaken:

```bash
mongorestore --uri "PASTE-TEST-RESTORE-STRING-HERE" --gzip --archive=live-$(date +%Y-%m-%d).gz --nsFrom 'test.*' --nsTo 'livecopy.*'
```

Afterwards, delete the `backup-reader` user in the Live project (it is only needed while dumping), and keep the
`.gz` file somewhere private (it contains customer data); it is itself a backup.

**Check the restore**

In the `TextilMarkt Test` project, Browse Collections, database `livecopy` (Path B) or `test` (Path A). Compare the
document count of `users`, `orders`, `masterorders` and `documents` with the same collections in Live. Open one
order and one document. Send me the counts. The copy stays for the Phase 2 migration trial.

### 5.4 If backups turn out to be off

Decide with me, but the cheapest real protection is: move Live to a tier with automatic snapshots (Flex), or keep M0 and
run the Path B `mongodump` weekly to a private, encrypted place. Until then, run Path B before every Live deploy that
changes data.

---

## 6. Roll back

### Backend (AppSail)

There is no "previous version" button confirmed for AppSail. Rolling back means deploying the previous tag. Because
Live's settings still travel inside `backend/.env` (section 7), that file has to be copied in:

```bash
cd "/Users/ankitbera/Documents/Claude/Projects/Tradio Consolidated/TextilMarktV1-main"
```

```bash
git worktree add ../rollback-live live-2026-11-18-1
```

(put the tag you want to go back to in place of `live-2026-11-18-1`)

```bash
cp .catalystrc ../rollback-live/ && cp backend/.env ../rollback-live/backend/.env
```

```bash
cd ../rollback-live/backend && npm ci && catalyst deploy --only appsail
```

Check `/api/health` as in section 3. Afterwards remove the folder (the `.env` copy goes with it):

```bash
cd "/Users/ankitbera/Documents/Claude/Projects/Tradio Consolidated/TextilMarktV1-main" && git worktree remove --force ../rollback-live
```

### Frontend (Slate)

Fastest: Catalyst console, project **TradioApp**, **Slate**, the `textilmarkt` app, **Deployment History**, open the
current deployment, **Deployment Overview**, **Rollback**, Confirm. Slate can only go back **one** deployment. For
anything older, revert the commit on `main` (`git revert <commit>`), let CI pass, and push; Slate rebuilds from it.

### Data

A bad data change is undone from a backup (section 5), not by a code rollback. That is why section 5 comes first.

---

## 7. Moving Live's settings out of the deployed `.env` (do on Test first)

Today the backend's secrets and settings come from `backend/.env` on the deploying machine and are uploaded with every
deploy. That stops a pipeline (it has no such file) and puts secrets in the upload. Catalyst's documentation says
variables set in the AppSail console override `app-config.json` and the code, and `dotenv` never overwrites a
variable that is already set, so console values win over the file. **But** on 15 Oct the Test backend ignored console
variables in practice, so this must be proven on Test before Live:

1. **Test project only.** Catalyst console, project `Textimarkt-Sandbox`, **AppSail**, the service, **Configuration**,
   **Environment Variables**. Add each variable from `TextilMarktV1-sandbox/backend/.env` with the same name and value
   (copy from the file in your editor; do not send them to anyone). Save.
2. Tell me. I deploy Test from a clean folder **without** a `.env` and check `/api/health` (on Test it shows the mode).
3. If it works: repeat step 1 on `TradioApp` for Live, then deploy Live from a clean folder at a quiet time, check
   health and sign in. Keep `backend/.env` on your Mac as the record until a month has passed.
4. If it does not work: nothing changes; we go back to deploying with the file and I raise it with Zoho support.

---

## 9. Keeping the coordinators' photos and voice notes in Stratus

A coordinator's photos and voice notes are kept in the database unless the backend is told to use Zoho Catalyst's file
storage (Stratus). Live's database is small, so Stratus should be on before coordinators use the app in earnest. Every
other document (tech packs, measurement sheets and so on) stays in the database either way.

Buckets (private, permission template Authenticated, versioning off):

| Project | Bucket | URL |
|---|---|---|
| `TradioApp` (Live) | `tradio-textilmarkt-live-floor` | `https://tradio-textilmarkt-live-floor-development.zohostratus.in` |
| `Textimarkt-Sandbox` (Test) | not created yet | |

The Catalyst SDK works only on AppSail, never on a laptop, so it is proven on the server itself, in this order:

1. **Deploy the backend with the bucket named but Stratus still off.** Add one line to `backend/.env` on the deploying
   Mac, then deploy as in section 3. Nothing changes for anyone: files still go to the database.

   ```
   STRATUS_BUCKET=tradio-textilmarkt-live-floor
   ```

2. **Run the check, signed in as a master admin.** In the browser, on the Live site, open the developer console
   (View, Developer, JavaScript Console) and paste this. It writes a few bytes to the bucket, reads them back and removes
   them, and records the result in the Audit Log as "Storage Checked".

   ```js
   fetch('https://textilmarkt-50042744536.development.catalystappsail.in/api/field-updates/storage/check', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: '{}' }).then(r => r.json()).then(console.log)
   ```

   It should print `ok: true` with three steps, `write`, `read` and `remove`, each `ok: true`. If any step fails, **stop
   here**, leave Stratus off and send me what it printed: the message says which step failed and why.

3. **Only after a clean check, switch it on.** Add a second line to `backend/.env` and deploy the backend again:

   ```
   FILE_STORE=stratus
   ```

4. **Confirm.** As a coordinator, send an update with a photo. As an admin, open Field Updates and check the photo shows.
   In the Catalyst console, the bucket should now list a file under `field-updates/`.

To go back: remove the `FILE_STORE` line and deploy. New files go to the database again, and files already in the bucket
still open, because each document remembers where its file is kept. Do not delete the bucket or empty it while any
document points at it.

If `FILE_STORE=stratus` is set and the bucket name is missing or wrong, sending a photo fails with "Photos cannot be
saved right now" and nothing is half-saved; an update with words alone still goes through.

---

## 8. Phase 1 proposals (for decision)

### 8.1 Separate Test (and later Standalone) from Live's cluster

Today Live, Test and the local sandbox are three databases on **one** cluster, reached with connection strings that
can all see each other's databases. A wrong `.env` or a script with the wrong name can write to Live, and on 17 Oct
an agent probably did.

**Proposal:** a separate Atlas **project** `TextilMarkt Test` (created in 5.3) with its own cluster. Test and the
local sandbox move there (Phase 3 rebuilds Test anyway); Standalone gets its own project later, the same way. Each
project has its own database users, so a Test password **cannot** open Live at all, whatever database name it names.
Live keeps its cluster and gets an explicit database name in its connection string (decided after 5.2).

| Option | Isolation | Cost | Work |
|---|---|---|---|
| A. Separate Atlas project and cluster per environment (recommended) | Full: different users, different hosts | M0 free; Flex a few dollars a month each | Small; Phase 3 |
| B. Same cluster, separate database users limited to one database each | Good against mistakes, not against cluster-wide problems | None | Small, but one cluster still shared |
| C. Leave as is | None | None | None |

### 8.2 Deploying the backend from a pipeline

| Option | How | For | Against |
|---|---|---|---|
| A. Keep manual, with this runbook and tags (now) | You run section 3 | Nothing new to learn | Depends on one Mac; easy to forget the order |
| B. Catalyst Pipelines | A `catalyst-pipelines.yaml` in the repo runs `catalyst deploy` inside Zoho when `main` changes; set up in the console with the GitHub integration | Stays inside Catalyst; no Catalyst token leaves Zoho | Newer product, little Node/AppSail example material; needs settings in the console first (section 7) |
| C. GitHub Actions running the Catalyst CLI | A deploy job after CI passes, using a Catalyst token kept in GitHub secrets; could deploy backend then trigger the frontend in the right order | Deploys only what CI passed; one place to watch | A Catalyst token stored in GitHub; needs section 7 first |

**Recommendation:** stay on A until section 7 is proven, then try B on Test. Whichever is chosen, deploys become
"only after CI is green, backend before frontend", and Live keeps a manual approval step.
