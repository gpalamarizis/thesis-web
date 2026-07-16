# run-backend.ps1
# Unified backend deploy: myDATA integration + client extras (GAK/EAK + tax/property fields)
# All Greek strings avoided. Pure ASCII PowerShell.
#
# Prerequisites:
#   1. Extract thesis-batch.zip in Downloads first:
#        Expand-Archive -Path "$env:USERPROFILE\Downloads\thesis-batch.zip" -DestinationPath "$env:USERPROFILE\Downloads\" -Force
#   2. cd C:\thesis-web-repo
#   3. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
#   4. .\run-backend.ps1

$ErrorActionPreference = 'Stop'
$repo = 'C:\thesis-web-repo'

if (-not (Test-Path $repo)) { throw "Repo path $repo not found" }
Set-Location $repo

$src = "$env:USERPROFILE\Downloads\thesis-batch\backend"
if (-not (Test-Path $src)) {
    Write-Host ""
    Write-Host "ERROR: Source dir not found: $src"
    Write-Host ""
    Write-Host "Run this first to extract the zip:"
    Write-Host "  Expand-Archive -Path ""`$env:USERPROFILE\Downloads\thesis-batch.zip"" -DestinationPath ""`$env:USERPROFILE\Downloads\"" -Force"
    throw "Missing source dir"
}

Write-Host "=== Backend deploy starting ==="
Write-Host ""

# --------------------------------------------------------------
# PART A: myDATA integration
# --------------------------------------------------------------
Write-Host "--- Part A: myDATA integration ---"

# A1. Copy 3 backend files
Copy-Item "$src\mydata-xml.js"    -Destination "src\utils\mydata-xml.js"    -Force
Copy-Item "$src\mydata-client.js" -Destination "src\utils\mydata-client.js" -Force
Copy-Item "$src\mydata.js"        -Destination "src\routes\mydata.js"       -Force
Write-Host "OK: 3 myDATA files copied"

# A2. Mount /api/mydata in server.js
$srvPath = 'src\server.js'
$srv     = Get-Content $srvPath -Raw -Encoding UTF8

if ($srv -match "require\('./routes/mydata'\)") {
    Write-Host "SKIP: /api/mydata already mounted"
} else {
    $needle = "app.use('/api/invoices',          require('./routes/invoices'));"
    $inject = "$needle`r`napp.use('/api/mydata',            require('./routes/mydata'));"
    if ($srv.Contains($needle)) {
        $srv = $srv.Replace($needle, $inject)
        Set-Content $srvPath $srv -NoNewline -Encoding UTF8
        Write-Host "OK: /api/mydata mounted"
    } else {
        Write-Warning "server.js mount point not found - please add manually"
    }
}

# A3. Patch organization-settings ALLOWED_FIELDS
$osPath = 'src\routes\organization-settings.js'
$os     = Get-Content $osPath -Raw -Encoding UTF8

$oldLine = "  'mydata_user_id','mydata_subscription_key','mydata_environment',"
$newLine = "  'mydata_user_id','mydata_subscription_key','mydata_environment','mydata_default_invoice_type','mydata_classification_type','mydata_classification_category',"

if ($os.Contains($newLine)) {
    Write-Host "SKIP: organization-settings ALLOWED_FIELDS already patched"
} elseif ($os.Contains($oldLine)) {
    $os = $os.Replace($oldLine, $newLine)
    Set-Content $osPath $os -NoNewline -Encoding UTF8
    Write-Host "OK: organization-settings ALLOWED_FIELDS patched"
} else {
    Write-Warning "organization-settings.js ALLOWED_FIELDS line not found"
}

Write-Host ""
Write-Host "--- Part B: Client extras (GAK/EAK + tax/property) ---"

# --------------------------------------------------------------
# PART B: Client extras (GAK/EAK + tax/credentials/property fields)
# --------------------------------------------------------------

# B1. Copy 4 backend files
Copy-Item "$src\crypto.js"        -Destination "src\utils\crypto.js"         -Force
Copy-Item "$src\client-extras.js" -Destination "src\routes\client-extras.js" -Force
Copy-Item "$src\fysika.js"        -Destination "src\routes\fysika.js"        -Force
Copy-Item "$src\nomika.js"        -Destination "src\routes\nomika.js"        -Force
Write-Host "OK: 4 client-extras files copied"

# B2. Patch cases.js
$casesPath = 'src\routes\cases.js'
$cases     = Get-Content $casesPath -Raw -Encoding UTF8

# B2a. Add require
$reqOld = "const { computeProtocolNumber, previewProtocolNumber } = require('../utils/protocol');"
$reqNew = "$reqOld`r`nconst { ensureColumns } = require('./client-extras');"
if ($cases.Contains("require('./client-extras')")) {
    Write-Host "SKIP: cases.js client-extras require already present"
} elseif ($cases.Contains($reqOld)) {
    $cases = $cases.Replace($reqOld, $reqNew)
    Write-Host "OK: cases.js require added"
} else {
    Write-Warning "cases.js require needle not found"
}

# B2b. INSERT columns + placeholders
$insertOld = "arithmos_apofasis, dekti, merikos_dekti, aporriptea, old_kod, prosvalomeni
       ) VALUES (`$1,`$2,`$3,`$4,`$5,`$6,`$7,`$8,`$9,`$10,`$11,`$12,`$13,`$14,`$15,`$16,`$17,`$18,`$19)"
$insertNew = "arithmos_apofasis, dekti, merikos_dekti, aporriptea, old_kod, prosvalomeni,
         gak, eak, arithmos_eisagogikou
       ) VALUES (`$1,`$2,`$3,`$4,`$5,`$6,`$7,`$8,`$9,`$10,`$11,`$12,`$13,`$14,`$15,`$16,`$17,`$18,`$19,`$20,`$21,`$22)"

if ($cases.Contains("gak, eak, arithmos_eisagogikou")) {
    Write-Host "SKIP: cases.js INSERT already patched"
} elseif ($cases.Contains($insertOld)) {
    $cases = $cases.Replace($insertOld, $insertNew)
    Write-Host "OK: cases.js INSERT columns patched"
} else {
    Write-Warning "cases.js INSERT needle not found"
}

# B2c. INSERT VALUES
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
    Write-Host "SKIP: cases.js INSERT values already patched"
} elseif ($cases.Contains($valsOld)) {
    $cases = $cases.Replace($valsOld, $valsNew)
    Write-Host "OK: cases.js INSERT values patched"
} else {
    Write-Warning "cases.js INSERT values needle not found"
}

# B2d. UPDATE SET
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
    Write-Host "SKIP: cases.js UPDATE SET already patched"
} elseif ($cases.Contains($updOld)) {
    $cases = $cases.Replace($updOld, $updNew)
    Write-Host "OK: cases.js UPDATE SET patched"
} else {
    Write-Warning "cases.js UPDATE SET needle not found"
}

# B2e. UPDATE values
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
    Write-Host "SKIP: cases.js UPDATE values already patched"
} elseif ($cases.Contains($updValsOld)) {
    $cases = $cases.Replace($updValsOld, $updValsNew)
    Write-Host "OK: cases.js UPDATE values patched"
} else {
    Write-Warning "cases.js UPDATE values needle not found"
}

# B2f. POST ensureColumns
$postOld = "router.post('/', async (req, res) => {`r`n  const orgId = req.user.organization_id;`r`n  const b = req.body || {};"
$postNew = "router.post('/', async (req, res) => {`r`n  await ensureColumns();`r`n  const orgId = req.user.organization_id;`r`n  const b = req.body || {};"
if ($cases -match "router\.post\('/', async \(req, res\) => \{\s*await ensureColumns\(\)") {
    Write-Host "SKIP: cases.js POST ensureColumns already present"
} elseif ($cases.Contains($postOld)) {
    $cases = $cases.Replace($postOld, $postNew)
    Write-Host "OK: cases.js POST ensureColumns added"
} else {
    Write-Warning "cases.js POST needle not found"
}

# B2g. PUT ensureColumns
$putOld = "router.put('/:id', async (req, res) => {`r`n  const orgId = req.user.organization_id;"
$putNew = "router.put('/:id', async (req, res) => {`r`n  await ensureColumns();`r`n  const orgId = req.user.organization_id;"
if ($cases -match "router\.put\('/:id', async \(req, res\) => \{\s*await ensureColumns\(\)") {
    Write-Host "SKIP: cases.js PUT ensureColumns already present"
} elseif ($cases.Contains($putOld)) {
    $cases = $cases.Replace($putOld, $putNew)
    Write-Host "OK: cases.js PUT ensureColumns added"
} else {
    Write-Warning "cases.js PUT needle not found"
}

Set-Content $casesPath $cases -NoNewline -Encoding UTF8

Write-Host ""
Write-Host "================================================================"
Write-Host "  BACKEND DEPLOY COMPLETE"
Write-Host "================================================================"
Write-Host ""
Write-Host "NEXT STEPS:"
Write-Host ""
Write-Host "1. Generate encryption key (from cmd - not powershell):"
Write-Host "   node -e ""console.log(require('crypto').randomBytes(32).toString('base64'))"""
Write-Host ""
Write-Host "2. On Railway dashboard, add env variable:"
Write-Host "   Name:  THESIS_CREDENTIALS_KEY"
Write-Host "   Value: <output from step 1>"
Write-Host ""
Write-Host "3. Commit + push from cmd (git does not work from PowerShell):"
Write-Host "   cd C:\thesis-web-repo"
Write-Host "   git add -A"
Write-Host "   git commit -m ""add myDATA integration + client extras (GAK/EAK + encrypted credentials)"""
Write-Host "   git push origin main"
Write-Host ""
