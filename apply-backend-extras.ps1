# apply-backend-extras.ps1
# Εφαρμογή client-extras batch (ΓΑΚ/ΕΑΚ + φορολογικά/ιδιοκτησιακά credentials)
#
# Χρήση:
#   cd C:\thesis-web-repo
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
#   .\apply-backend-extras.ps1
#
# Απαιτείται: πρέπει ήδη να τρέξεις το apply-backend.ps1 (myDATA batch) πρώτα.

$ErrorActionPreference = 'Stop'
$repo = 'C:\thesis-web-repo'

if (-not (Test-Path $repo)) { throw "Repo path $repo not found" }
Set-Location $repo

$src = "$env:USERPROFILE\Downloads\thesis-client-extras\backend"
if (-not (Test-Path $src)) { throw "Δεν βρήκα $src — extract πρώτα το thesis-client-extras.zip στο Downloads." }

# --- 1. Copy new backend files ---
Copy-Item "$src\crypto.js"         -Destination "src\utils\crypto.js"          -Force
Copy-Item "$src\client-extras.js"  -Destination "src\routes\client-extras.js"  -Force
Copy-Item "$src\fysika.js"         -Destination "src\routes\fysika.js"         -Force
Copy-Item "$src\nomika.js"         -Destination "src\routes\nomika.js"         -Force
Write-Host "OK: 4 backend files copied (crypto, client-extras, fysika, nomika)"

# --- 2. Patch cases.js ---
$casesPath = 'src\routes\cases.js'
$cases     = Get-Content $casesPath -Raw -Encoding UTF8

# 2a. Add require στην κορυφή αν λείπει
$reqNeedle = "const { computeProtocolNumber, previewProtocolNumber } = require('../utils/protocol');"
$reqAdd    = "const { computeProtocolNumber, previewProtocolNumber } = require('../utils/protocol');`r`nconst { ensureColumns } = require('./client-extras');"
if ($cases.Contains("require('./client-extras')")) {
    Write-Host "SKIP: client-extras require already present"
} elseif ($cases.Contains($reqNeedle)) {
    $cases = $cases.Replace($reqNeedle, $reqAdd)
    Write-Host "OK: client-extras require added"
} else {
    Write-Warning "Δεν βρήκα το require needle — πρόσθεσε manual: const { ensureColumns } = require('./client-extras');"
}

# 2b. Patch INSERT (POST /) — προσθέτω gak, eak, arithmos_eisagogikou
$insertOld = "arithmos_apofasis, dekti, merikos_dekti, aporriptea, old_kod, prosvalomeni
       ) VALUES (`$1,`$2,`$3,`$4,`$5,`$6,`$7,`$8,`$9,`$10,`$11,`$12,`$13,`$14,`$15,`$16,`$17,`$18,`$19)"
$insertNew = "arithmos_apofasis, dekti, merikos_dekti, aporriptea, old_kod, prosvalomeni,
         gak, eak, arithmos_eisagogikou
       ) VALUES (`$1,`$2,`$3,`$4,`$5,`$6,`$7,`$8,`$9,`$10,`$11,`$12,`$13,`$14,`$15,`$16,`$17,`$18,`$19,`$20,`$21,`$22)"

if ($cases.Contains("gak, eak, arithmos_eisagogikou`n       ) VALUES") -or $cases.Contains("gak, eak, arithmos_eisagogikou`r`n       ) VALUES")) {
    Write-Host "SKIP: INSERT already patched"
} elseif ($cases.Contains($insertOld)) {
    $cases = $cases.Replace($insertOld, $insertNew)
    Write-Host "OK: INSERT columns + placeholders patched"
} else {
    Write-Warning "Δεν βρήκα το INSERT needle — patched χειροκίνητα"
}

# 2c. Patch INSERT VALUES array
$valsOld = "        b.old_kod || null,
        b.prosvalomeni || null,
      ]"
$valsNew = "        b.old_kod || null,
        b.prosvalomeni || null,
        b.gak || null,
        b.eak || null,
        b.arithmos_eisagogikou || null,
      ]"

if ($cases.Contains("b.gak || null")) {
    Write-Host "SKIP: INSERT values already patched"
} elseif ($cases.Contains($valsOld)) {
    $cases = $cases.Replace($valsOld, $valsNew)
    Write-Host "OK: INSERT values patched"
} else {
    Write-Warning "Δεν βρήκα το INSERT values needle"
}

# 2d. Patch UPDATE SET clauses (PUT /:id)
$updOld = "prosvalomeni            = COALESCE(`$15, prosvalomeni),
         updated_at              = NOW()
       WHERE aa = `$16 AND organization_id = `$17"
$updNew = "prosvalomeni            = COALESCE(`$15, prosvalomeni),
         gak                     = COALESCE(`$16, gak),
         eak                     = COALESCE(`$17, eak),
         arithmos_eisagogikou    = COALESCE(`$18, arithmos_eisagogikou),
         updated_at              = NOW()
       WHERE aa = `$19 AND organization_id = `$20"

if ($cases.Contains("gak                     = COALESCE")) {
    Write-Host "SKIP: UPDATE SET already patched"
} elseif ($cases.Contains($updOld)) {
    $cases = $cases.Replace($updOld, $updNew)
    Write-Host "OK: UPDATE SET clauses patched"
} else {
    Write-Warning "Δεν βρήκα το UPDATE SET needle"
}

# 2e. Patch UPDATE values array
$updValsOld = "        b.old_kod ?? null,
        b.prosvalomeni ?? null,
        id, orgId,
      ]"
$updValsNew = "        b.old_kod ?? null,
        b.prosvalomeni ?? null,
        b.gak ?? null,
        b.eak ?? null,
        b.arithmos_eisagogikou ?? null,
        id, orgId,
      ]"

if ($cases.Contains("b.gak ?? null")) {
    Write-Host "SKIP: UPDATE values already patched"
} elseif ($cases.Contains($updValsOld)) {
    $cases = $cases.Replace($updValsOld, $updValsNew)
    Write-Host "OK: UPDATE values patched"
} else {
    Write-Warning "Δεν βρήκα το UPDATE values needle"
}

# 2f. Add ensureColumns call σε POST και PUT handlers
# Το POST ξεκινά με "router.post('/', async (req, res) => {" — εισάγουμε awaitensure στην αρχή του body
$postNeedle = "router.post('/', async (req, res) => {`r`n  const orgId = req.user.organization_id;`r`n  const b = req.body || {};"
$postAdd    = "router.post('/', async (req, res) => {`r`n  await ensureColumns();`r`n  const orgId = req.user.organization_id;`r`n  const b = req.body || {};"
if ($cases -match "router\.post\('/', async \(req, res\) => \{\s*await ensureColumns\(\)") {
    Write-Host "SKIP: POST ensureColumns already present"
} elseif ($cases.Contains($postNeedle)) {
    $cases = $cases.Replace($postNeedle, $postAdd)
    Write-Host "OK: ensureColumns added to POST"
} else {
    Write-Warning "Δεν βρήκα το POST needle — πρόσθεσε manual: await ensureColumns() στη αρχή του POST handler"
}

$putNeedle = "router.put('/:id', async (req, res) => {`r`n  const orgId = req.user.organization_id;"
$putAdd    = "router.put('/:id', async (req, res) => {`r`n  await ensureColumns();`r`n  const orgId = req.user.organization_id;"
if ($cases -match "router\.put\('/:id', async \(req, res\) => \{\s*await ensureColumns\(\)") {
    Write-Host "SKIP: PUT ensureColumns already present"
} elseif ($cases.Contains($putNeedle)) {
    $cases = $cases.Replace($putNeedle, $putAdd)
    Write-Host "OK: ensureColumns added to PUT"
} else {
    Write-Warning "Δεν βρήκα το PUT needle — πρόσθεσε manual: await ensureColumns() στην αρχή του PUT handler"
}

Set-Content $casesPath $cases -NoNewline -Encoding UTF8

Write-Host ""
Write-Host "=== Backend extras batch εφαρμόστηκε. ==="
Write-Host ""
Write-Host "ΣΗΜΑΝΤΙΚΟ: Στο Railway → Variables πρόσθεσε την encryption key:"
Write-Host "  1. Στο local terminal (cmd) τρέξε αυτό για generation:"
Write-Host "     node -e ""console.log(require('crypto').randomBytes(32).toString('base64'))"""
Write-Host "  2. Στο Railway dashboard: Variables → New Variable:"
Write-Host "     KEY:   THESIS_CREDENTIALS_KEY"
Write-Host "     VALUE: <το output του command>"
Write-Host "  3. Αν δεν το βάλεις, θα δουλέψει με fallback από το JWT_SECRET (χειρότερη ασφάλεια)."
Write-Host ""
Write-Host "Μετά commit + push από cmd:"
Write-Host "  cd C:\thesis-web-repo"
Write-Host "  git add -A"
Write-Host "  git commit -m ""add client-extras batch: GAK/EAK + tax/credentials/property fields with AES-256-GCM encryption"""
Write-Host "  git push origin main"
