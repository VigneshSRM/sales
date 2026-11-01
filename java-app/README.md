# Sales Pipeline Autopilot — Java 17 build

Same application as the Node.js reference implementation (`/home/user/sales`, root of this repo),
rebuilt for the blueprint's Java 17 stack to the extent this sandbox allows.

## Stack

- **Runtime:** Eclipse Temurin **Java 17.0.9** (`bin/java` verified: `openjdk version "17.0.9"`)
- **Language level:** Java 11-compatible source (valid Java 17 code)
- **HTTP server:** `com.sun.net.httpserver` (JDK built-in) on `0.0.0.0:8080` (PORT env to override)
- **Datastore:** local JSON file with atomic writes + hash-chained `audit_log` (34 tables, mirroring the blueprint schema; Flyway/MariaDB not reachable from this sandbox)
- **No third-party dependencies** — the only jar present is `ecj-4.10.jar`, used solely as the compiler.

## Why ECJ 4.10 as compiler

The sandbox has no `javac`/JDK, and Maven Central / Adoptium / GitHub release assets are all
network-blocked, so no modern `javac` or ECJ ≥ 3.29 could be downloaded. ECJ 4.10 (from
facebook/buck's repo, verified working) compiles `-source 11 -target 11`, and the resulting
class files run on the Java 17 runtime. The canonical production build remains Maven +
Spring Boot 3.3 WAR (`pom.xml` in this directory) per blueprint §43.

## Build & run

```bash
./build.sh          # compiles with ECJ and runs on Java 17 (port 8080, PORT to override)
./build.sh build    # compile only
```

`JAVA_HOME` must point to a Java 17 runtime (defaults to the jdk4py Temurin 17.0.9 install).

## Modules (mirrors the 8 blueprint modules)

| Class | Responsibility |
|---|---|
| `Json` | dependency-free JSON parser/serializer |
| `Db` | 34-table file store, hash-chained audit log, atomic writes |
| `Scoring` | 100-pt / 5×20 lead scoring, tiers A≥75/B/C/D, SLAs 15m/4h/24h, round-robin routing |
| `Workflow` | rules R01–R16 evaluation + 14/21/30-day stale-deal sweep |
| `Seed` | 8 users, 6 RBAC roles, settings, feature flags, templates E1–E8, sequences SEC-01..NU-06 |
| `Views` | server-rendered dark admin UI |
| `Server` | all HTTP routes: public capture/booking/ICS/unsubscribe, authenticated `/api/v1/*`, `/app/*` admin |
| `Main` | bootstrap + background scheduler (outbox, stale sweep) |

## Smoke test results (this sandbox, port 8090)

`/health` UP · login 302 → `/app` · public capture → score/tier/booking link · availability slots
09:30–16:30 IST · booking → ICS · unsubscribe bad-token → 400 · all 9 `/app/*` pages 200 ·
`/api/v1/{leads,deals,tasks,sequences,meetings,audit,notifications,settings,reports/funnel}` 200.

Seed logins (password `ChangeMe#2026`): admin@, founder@, sales.manager@, rep1@, rep2@, sdr@,
delivery@, viewer@ — all `@infeara.local`.
