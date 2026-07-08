# Thesis Web v3

Multi-tenant SaaS backend για το νομικό σύστημα διαχείρισης υποθέσεων **Thesis**.
Migration 1:1 από την παλιά VB.NET desktop εφαρμογή.

## Stack

- Node.js 20 + Express 4
- PostgreSQL 15+ (Railway)
- JWT auth (bcryptjs)
- Cloudflare R2 για case documents (S3-compatible)
- Deploy: Railway (Dockerfile)

## Νέα σε v3 σε σχέση με v2

- Πλήρες schema από VB.NET reverse-engineering (34-field `fysika_prosopa`, 22-field `nomika_prosopa`, όλα τα πεδία `dikastiria_energeies`)
- Auto-seed 90+ ελληνικών δικαστηρίων + 30+ τμημάτων σε κάθε νέα εγγραφή γραφείου
- Auto-seed διαδικασιών, εξελίξεων, θέσεων στην υπόθεση, ονομασιών, χωρών, πόλεων
- Πλήρης λογική αριθμού πρωτοκόλλου: `<CLIENT_ID><Φ|Ν>/<αρ_υπόθεσης_πελάτη>/<συνολικός>` (π.χ. `5Φ/3/127`)
- Reports: εκκρεμείς υποθέσεις, ημερολόγιο δικαστικών ενεργειών, ημερολόγιο λοιπών ενεργειών
- Ενοποιημένος τηλεφωνικός κατάλογος (UNION όλων των contact tables)
- Έγγραφα υποθέσεων σε Cloudflare R2 με presigned URLs

## Structure

```
thesis-web/
├── Dockerfile
├── package.json
├── .env.example
├── scripts/
│   └── migrate.js              # runner για drop_v2 + schema
├── sql/
│   ├── drop_v2.sql             # καθαρίζει τους v2 πίνακες
│   └── schema.sql              # πλήρες v3 schema (40+ tables)
└── src/
    ├── server.js               # Express app
    ├── db.js                   # pg pool
    ├── middleware/auth.js      # JWT verify + role
    ├── utils/
    │   ├── protocol.js         # <ID><Φ|Ν>/<n>/<total>
    │   └── query.js            # pickAllowed / buildInsert helpers
    ├── seed/
    │   ├── courts.js           # 90+ ελληνικά δικαστήρια
    │   ├── lookups.js          # διαδικασίες, ονομασίες, θέσεις, ...
    │   └── seedOrg.js          # wrapper για νέα οργάνωση
    └── routes/
        ├── auth.js             # /register, /login, /me
        ├── cases.js            # ypotheseis + preview-protocol
        ├── fysika.js           # φυσικά πρόσωπα (34 fields)
        ├── nomika.js           # νομικά πρόσωπα
        ├── people.js           # δικηγόροι/αντίδικοι/σχετικά
        ├── courts.js           # δικαστήρια + τμήματα
        ├── actions.js          # δικαστικές ενέργειες + tasks
        ├── lists.js            # generic CRUD για λίστες
        ├── reports.js          # εκκρεμείς / προσεχείς / tasks
        ├── phonebook.js        # ενοποιημένος τηλεφωνικός
        ├── finance.js          # ώρες/πάγια/αμοιβές/έξοδα
        └── documents.js        # R2 upload / signed URL / delete
```

## API Endpoints (highlights)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/register` | + auto-seed δικαστηρίων & λιστών |
| POST | `/api/auth/login` | JWT |
| GET | `/api/cases/preview-protocol?clientType=..&clientId=..` | Preview `5Φ/3/127` |
| GET,POST,PUT,DELETE | `/api/cases[/id]` | ypotheseis CRUD |
| GET,POST,PUT,DELETE | `/api/fysika[/id]` | 34 fields |
| GET,POST,PUT,DELETE | `/api/nomika[/id]` | 22 fields |
| GET,POST,PUT,DELETE | `/api/people/lawyers[/id]` | δικηγόροι γραφείου |
| GET,POST,PUT,DELETE | `/api/people/opposing-lawyers[/id]` | |
| GET,POST,PUT,DELETE | `/api/people/opponents[/id]` | αντίδικοι |
| GET,POST,PUT,DELETE | `/api/people/related[/id]` | σχετικά πρόσωπα |
| GET,POST,PUT,DELETE | `/api/courts[/id]` | δικαστήρια |
| GET,POST,PUT,DELETE | `/api/actions/court[/id]` | δικαστικές ενέργειες |
| GET,POST,PUT,DELETE | `/api/actions/exelixi[/id]` | εξελίξεις |
| GET,POST,PUT,DELETE | `/api/actions/task[/id]` | λοιπές ενέργειες |
| GET,POST,PUT,DELETE | `/api/lists/:list[/id]` | διαδικασίες, θέσεις, ονομασίες, ... |
| GET | `/api/reports/pending` | εκκρεμείς υποθέσεις |
| GET | `/api/reports/upcoming-hearings?from=&to=` | δικάσιμοι |
| GET | `/api/reports/pending-tasks` | ημερολόγιο λοιπών ενεργειών |
| GET | `/api/reports/summary` | dashboard metrics |
| GET | `/api/phonebook?q=` | ενοποιημένος τηλ. κατάλογος |
| GET,POST,PUT,DELETE | `/api/finance/:resource[/id]` | ores, pagia-exoda, amoives, exoda-synergati |
| GET,POST,DELETE | `/api/documents[/id]` | R2 upload/download URL |

## Deploy

Δες [DEPLOY.md](./DEPLOY.md).

## Test user (μετά από `/api/auth/register`)

Το v2 test user (`admin@test.com` / `Test123456`) χάνεται όταν κάνεις drop τους v2 πίνακες.
Δημιουργείς νέο μέσω `POST /api/auth/register` — αυτόματα φορτώνει όλα τα δικαστήρια και τις λίστες.
