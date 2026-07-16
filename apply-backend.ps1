# apply-backend.ps1
# Εφαρμογή myDATA batch στο backend (C:\thesis-web-repo)
#
# Χρήση:
#   cd C:\thesis-web-repo
#   .\apply-backend.ps1
# (Το script υποθέτει ότι έχεις κατεβάσει το thesis-mydata.zip στο ~\Downloads και το extractάρεις.)

$ErrorActionPreference = 'Stop'
$repo = 'C:\thesis-web-repo'

if (-not (Test-Path $repo)) { throw "Repo path $repo not found" }
Set-Location $repo

# --- 1. Copy new files από ~\Downloads\thesis-mydata\backend\ ---
$src = "$env:USERPROFILE\Downloads\thesis-mydata\backend"
if (-not (Test-Path $src)) { throw "Δεν βρήκα $src — extract πρώτα το thesis-mydata.zip στο Downloads." }

Copy-Item "$src\mydata-xml.js"    -Destination "src\utils\mydata-xml.js"    -Force
Copy-Item "$src\mydata-client.js" -Destination "src\utils\mydata-client.js" -Force
Copy-Item "$src\mydata.js"        -Destination "src\routes\mydata.js"       -Force
Write-Host "OK: 3 backend files copied"

# --- 2. Mount /api/mydata στο server.js (αν δεν υπάρχει ήδη) ---
$srvPath = 'src\server.js'
$srv     = Get-Content $srvPath -Raw -Encoding UTF8

if ($srv -match "require\('./routes/mydata'\)") {
    Write-Host "SKIP: /api/mydata already mounted"
} else {
    # Το βάζουμε ακριβώς μετά το invoices mount για συνέπεια
    $needle  = "app.use('/api/invoices',          require('./routes/invoices'));"
    $inject  = "app.use('/api/invoices',          require('./routes/invoices'));`r`napp.use('/api/mydata',            require('./routes/mydata'));"
    if ($srv.Contains($needle)) {
        $srv = $srv.Replace($needle, $inject)
    } else {
        # Fallback: πρόσθεσέ το πριν το 404 handler
        $marker = "// 404 handler"
        if ($srv.Contains($marker)) {
            $srv = $srv.Replace($marker, "app.use('/api/mydata',            require('./routes/mydata'));`r`n`r`n// 404 handler")
        } else {
            throw "Δεν βρήκα το σημείο mount στο server.js — mount χειροκίνητα: app.use('/api/mydata', require('./routes/mydata'));"
        }
    }
    Set-Content $srvPath $srv -NoNewline -Encoding UTF8
    Write-Host "OK: /api/mydata mounted"
}

# --- 3. Patch organization-settings ALLOWED_FIELDS (για τα defaults invoice type + classifications) ---
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
    Write-Warning "Δεν βρήκα την αναμενόμενη γραμμή στο organization-settings.js — πρόσθεσε manual τα 3 fields στο ALLOWED_FIELDS: mydata_default_invoice_type, mydata_classification_type, mydata_classification_category"
}

Write-Host ""
Write-Host "=== Backend patches εφαρμόστηκαν. Τώρα κάνε commit + push από cmd: ==="
Write-Host "  cd C:\thesis-web-repo"
Write-Host "  git add -A"
Write-Host "  git commit -m ""add myDATA integration (sandbox, 1.1 + 2.1, manual send/cancel)"""
Write-Host "  git push origin main"
