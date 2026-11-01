# Sales Pipeline Autopilot — Infeara Revenue OS

Local-first sales system built from the **Sales Pipeline Autopilot blueprint v1.0** (`sales_11zon.pdf`, "Approved for build"): capture every lead, score it, engage automatically, and book the meeting — without a single cloud dependency.

## Run

```bash
npm install
npm run seed     # idempotent: users, reference data, templates, sequences, rules
npm start        # http://localhost:8080
```

- Public lead form: `http://localhost:8080/`
- Public booking page: `http://localhost:8080/book`
- Admin console: `http://localhost:8080/app` — seed logins (password `ChangeMe#2026`):
  `admin@`, `founder@`, `sales.manager@`, `rep1@`, `rep2@`, `sdr@`, `delivery@`, `viewer@` (all `@infeara.local`)
- Health: `GET /health`

## What's implemented (blueprint mapping)

| Module | Blueprint section | Implementation |
|---|---|---|
| Capture | §21–22 | `POST /api/v1/public/leads` — validation, honeypot, consent (DPDP), email-hash dedupe/merge, source touch, 60-second outbox auto-response |
| Scoring & routing | §20, §18 | 100-point / 5-factor score with JSON breakdown, tiers A–D, first-touch SLAs (15m/4h/24h), round-robin routing (`src/scoring.js`) |
| CRM | §15–16 | Leads, companies, contacts, deals with gated stage machine (append-only `deal_stage_history`), activities, tasks |
| Engagement | §27–28 | 6 seeded sequences (SEC-01…NU-06), templates E1–E8, outbox table, suppression, feature-flagged SMTP/IMAP |
| Scheduling | §32–33 | Slot engine (working hours, buffer, daily cap, 4h lead time, lunch block), unique `(rep, start)` constraint against double-booking, ICS invites, reminders, no-show flow |
| Workflow | §30–31 | 16 follow-up rules as **data** in `workflow_rule`, evaluated on events, incl. the 14/21/30-day stale-deal rule; every execution logged |
| Analytics | §35 | Manager cockpit, funnel, weighted forecast, `/api/v1/reports/*` |
| Platform | §17, §24, §54 | RBAC roles, cookie sessions, append-only hash-chained audit log, notifications, feature flags, audit-logged CSV export, DSR/unsubscribe workflow |

## Deployment note

The blueprint specifies **Java 17 / Spring Boot 3.3 / WAR on Tomcat 10.1 / MariaDB 11.4**. This sandbox has no JDK and no access to Maven Central, so the runnable build here uses **Node.js + Express + local SQLite** (same role as MariaDB: the only datastore, local-only). The module boundaries (`platform`, `authn`, `crm`, `capture`, `engagement`, `scheduling`, `workflow`, `analytics`), the 34-table schema (`src/db.js`), the API surface (`/api/v1/...`), and all business rules map 1:1 to the blueprint, so porting to the Java stack is mechanical. In production, run the WAR on Tomcat 10.1 with MariaDB bound to 127.0.0.1 per blueprint §56.
