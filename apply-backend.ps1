# apply-backend.ps1
# myDATA integration backend deploy
#
# Usage:
#   cd C:\thesis-web-repo
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
#   .\apply-backend.ps1

$ErrorActionPreference = 'Stop'
$repo = 'C:\thesis-web-repo'

if (-not (Test-Path $repo)) { throw "Repo path $repo not found" }
Set-Location $repo

$src = "$env:USERPROFILE\Downloads\thesis-mydata\backend"
if (-not (Test-Path $src)) { throw "Source dir not found: $src (extract thesis-mydata.zip in Downloads first)" }

# --- 1. Copy new files ---
Copy-Item "$src\mydata-xml.js"    -Destination "src\utils\mydata-xml.js"    -Force
Copy-Item "$src\mydata-client.js" -Destination "src\utils\mydata-client.js" -Force
Copy-Item "$src\mydata.js"        -Destination "src\routes\mydata.js"       -Force
Write-Host "OK: 3 backend files copied"

# --- 2. Mount /api/mydata in server.js ---
$srvPath = 'src\server.js'
$srv     = Get-Content $srvPath -Raw -Encoding UTF8

if ($srv -match "require\('./routes/mydata'\)") {
    Write-Host "SKIP: /api/mydata already mounted"
} else {
    $needle  = "app.use('/api/invoices',          require('./routes/invoices'));"
    $inject  = "app.use('/api/invoices',          require('./routes/invoices'));`r`napp.use('/api/mydata',            require('./routes/mydata'));"
    if ($srv.Contains($needle)) {
        $srv = $srv.Replace($needle, $inject)
        Set-Content $srvPath $srv -NoNewline -Encoding UTF8
        Write-Host "OK: /api/mydata mounted"
    } else {
        Write-Warning "server.js mount point not found - add manually: app.use('/api/mydata', require('./routes/mydata'));"
    }
}

# --- 3. Patch organization-settings ALLOWED_FIELDS ---
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
    Write-Warning "organization-settings.js ALLOWED_FIELDS line not found - add manually"
}

Write-Host ""
Write-Host "=== Backend patches applied. Now commit + push from cmd: ==="
Write-Host "  cd C:\thesis-web-repo"
Write-Host "  git add -A"
Write-Host "  git commit -m ""add myDATA integration"""
Write-Host "  git push origin main"
