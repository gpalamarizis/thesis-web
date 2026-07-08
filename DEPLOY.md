# Deploy — Thesis Web v3

Οδηγίες βήμα-βήμα για **Windows cmd / PowerShell** (χωρίς WSL, χωρίς local Docker).

Ο κώδικας πάει απευθείας στο `main` του `gpalamarizis/thesis-web`. Το Railway κάνει build αυτόματα.

---

## 0. Prerequisites

- `psql` client στο PATH (μαζί με PostgreSQL installer, ή standalone: `winget install PostgreSQL.PostgreSQL`)
- Git (GitHub Desktop ή CLI)
- Railway account με πρόσβαση στο υπάρχον project `thesis-web-production-c215`

Πάρε το `DATABASE_URL` από το Railway:
Railway Dashboard → project → PostgreSQL service → **Connect** → **Postgres Connection URL**

---

## 1. Extract + αντιγραφή στον τοπικό φάκελο (cmd)

Ξεκινάς από ένα φρέσκο zip. Αν έχεις ήδη clone του v2, καθάρισέ το πρώτα.

```cmd
cd C:\
if exist thesis-web-old rmdir /s /q thesis-web-old
if exist thesis-web ren thesis-web thesis-web-old

REM Extract το zip σε C:\thesis-web (χρήση PowerShell από cmd)
powershell -Command "Expand-Archive -Path '%USERPROFILE%\Downloads\thesis-web-v3.zip' -DestinationPath 'C:\' -Force"

cd C:\thesis-web
dir
```

Πρέπει να δεις: `Dockerfile`, `package.json`, `src/`, `sql/`, `scripts/`, `README.md`, `DEPLOY.md`.

---

## 2. Git push στο main του thesis-web repo (cmd)

Αν το `C:\thesis-web` δεν είναι ήδη git repo (fresh extract), κάνε clone και overlay:

```cmd
cd C:\
git clone https://github.com/gpalamarizis/thesis-web.git thesis-web-repo
cd thesis-web-repo

REM Καθάρισε ΟΛΑ τα v2 files (κρατάς μόνο .git)
for /f "delims=" %F in ('dir /a-d /b') do del /q "%F"
for /d %F in (*) do if not "%F"==".git" rmdir /s /q "%F"

REM Αντιγραφή του v3 πάνω από
xcopy /E /I /Y C:\thesis-web\* .
xcopy /Y C:\thesis-web\.gitignore .
xcopy /Y C:\thesis-web\.dockerignore .
xcopy /Y C:\thesis-web\.env.example .

git status
git add -A
git commit -m "v3: full VB.NET parity - schema, seeds, protocol logic, all routes"
git push origin main
```

Το Railway θα ξεκινήσει build αυτόματα. Παρακολούθησε: Railway → thesis-web service → **Deployments** → latest → **View Logs**.

Αν δεις error, ο πρώτος έλεγχος είναι πάντα το **Deploy Logs** — όχι το Build Logs. Κοίτα για missing env vars, port binding, ή `Cannot find module`.

---

## 3. Migration της βάσης (PowerShell — γιατί χρειάζεται env variable)

**ΠΡΟΣΟΧΗ:** Αυτό διαγράφει ΟΛΟΥΣ τους v2 πίνακες και δεδομένα. Το v2 έχει μόνο test data, οπότε OK.

Άνοιξε **PowerShell** (όχι cmd — χρειαζόμαστε inline env var):

```powershell
cd C:\thesis-web

REM Παίρνεις το URL από Railway
$env:DATABASE_URL = "postgresql://postgres:XXXXXXXX@YYYYYY.railway.app:5432/railway"

REM Verify connection
psql $env:DATABASE_URL -c "SELECT version();"

REM STEP A: Drop v2 tables
psql $env:DATABASE_URL -f sql/drop_v2.sql

REM STEP B: Apply v3 schema
psql $env:DATABASE_URL -f sql/schema.sql

REM Verify: πρέπει να είναι 40+ πίνακες
psql $env:DATABASE_URL -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';"

REM Δες τους πίνακες
psql $env:DATABASE_URL -c "\dt"
```

**Alternative με Node script** (αν δεν θέλεις psql):

```powershell
cd C:\thesis-web
npm install
$env:DATABASE_URL = "postgresql://..."
$env:NODE_ENV = "production"
node scripts/migrate.js --drop-v2
```

Πρέπει να δείχνει `✅ Migration ολοκληρώθηκε. Πίνακες: 40+` και λίστα με όλους τους πίνακες.

---

## 4. Environment variables στο Railway

Railway Dashboard → thesis-web service → **Variables** tab. Βεβαιώσου ότι υπάρχουν:

| Variable | Τιμή |
|---|---|
| `DATABASE_URL` | Reference στο Postgres service (`${{Postgres.DATABASE_URL}}`) |
| `JWT_SECRET` | Ένα long random string (π.χ. `openssl rand -hex 32`) |
| `NODE_ENV` | `production` |
| `R2_ACCOUNT_ID` | *(optional, για documents)* |
| `R2_ACCESS_KEY_ID` | *(optional)* |
| `R2_SECRET_ACCESS_KEY` | *(optional)* |
| `R2_BUCKET` | `thesis-documents` *(optional)* |

Αν άλλαξες variables, κάνε **Redeploy** (Railway → Deployments → latest → three-dot menu → **Redeploy**).

---

## 5. Verification (PowerShell)

```powershell
REM Health
curl.exe https://thesis-web-production-c215.up.railway.app/health
REM → {"status":"ok","db":true}

REM Δημιουργία test γραφείου (αυτόματα κάνει seed 90+ δικαστηρίων + όλες τις λίστες)
$body = @{
  organizationName = "Test Δικηγορικό Γραφείο"
  email            = "admin@test.com"
  password         = "Test123456"
  firstName        = "Admin"
  lastName         = "User"
} | ConvertTo-Json

curl.exe -X POST "https://thesis-web-production-c215.up.railway.app/api/auth/register" `
  -H "Content-Type: application/json" `
  -d $body
```

Πρέπει να επιστρέψει `{"token":"...","user":{...},"organization":{...}}`. Ο πρώτος register κάνει auto-seed — μπορεί να πάρει 3-5 δευτερόλεπτα.

Έλεγξε το seed:

```powershell
psql $env:DATABASE_URL -c "SELECT count(*) FROM dikastiria;"
REM → 90+

psql $env:DATABASE_URL -c "SELECT count(*) FROM diadikasies;"
REM → 28

psql $env:DATABASE_URL -c "SELECT count(*) FROM ypotheseis_onomasies;"
REM → 35
```

Login test:

```powershell
$login = @{ email = "admin@test.com"; password = "Test123456" } | ConvertTo-Json

$resp = curl.exe -s -X POST "https://thesis-web-production-c215.up.railway.app/api/auth/login" `
  -H "Content-Type: application/json" -d $login | ConvertFrom-Json

$token = $resp.token
Write-Host "Token: $($token.Substring(0,30))..."

REM Preview protocol number - θα δώσει "1Φ/1/1" γιατί δεν υπάρχουν υποθέσεις ακόμα
REM (δουλεύει ΜΟΝΟ αν έχεις ήδη ένα φυσικό πρόσωπο με id=1)
curl.exe -H "Authorization: Bearer $token" `
  "https://thesis-web-production-c215.up.railway.app/api/cases/preview-protocol?clientType=fysiko&clientId=1"
```

---

## 6. Cloudflare R2 setup (για case documents)

**Skippable** — τα routes `/api/documents/*` απλά επιστρέφουν error αν λείπουν τα R2 credentials. Το backend δουλεύει κανονικά χωρίς αυτά.

1. Cloudflare Dashboard → **R2** → **Create bucket** → `thesis-documents`
2. **Manage R2 API Tokens** → Create Token → Object Read & Write → επίλεξε το bucket
3. Copy: **Account ID**, **Access Key ID**, **Secret Access Key**
4. Railway → Variables → πρόσθεσε `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET=thesis-documents`
5. Redeploy

---

## 7. Troubleshooting

**Build fails με `Cannot find module 'src/routes/xxx'`**
Λείπει file. Άνοιξε το repo στο GitHub και επιβεβαίωσε ότι υπάρχουν όλα σε `src/routes/`: auth, cases, fysika, nomika, people, courts, actions, lists, reports, phonebook, finance, documents.

**Build passes, request δίνει 500 `column "xxx" does not exist`**
Δεν έγινε το migration. Ξανατρέξε το βήμα 3.

**`self signed certificate` στο psql / Node**
Το `db.js` έχει ήδη `ssl: { rejectUnauthorized: false }` για production. Για local `psql`, χρησιμοποίησε: `psql "$env:DATABASE_URL?sslmode=require"`.

**Ο frontend v2 σπάει μετά το deploy**
Είναι αναμενόμενο — τα endpoint paths και schemas άλλαξαν. Επόμενο βήμα: ενημέρωση του frontend v3.

**Railway timeout στο first request**
Το auto-seed 90+ δικαστηρίων παίρνει 3-5s. Αν το Railway σκοτώνει το request, ρίξε τα max connections του pool στο `src/db.js`.

---

## 8. Επόμενο βήμα

Μόλις το backend πάει live και οι verifications περάσουν, ενημέρωση του frontend v3:

- Preview αριθμού πρωτοκόλλου στη φόρμα Νέας Υπόθεσης
- Φόρμες φυσικού / νομικού με τα 34 / 22 πεδία
- Σελίδα "Λίστες" για διαχείριση lookup tables
- Τηλεφωνικός κατάλογος
- Reports: εκκρεμείς + προσεχείς δικάσιμοι
