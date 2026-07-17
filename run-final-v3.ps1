# run-final-v3.ps1
# Complete deploy v3: platform + Viva + team + access + signup + courts report + email + GDPR.
# Pure ASCII.

$ErrorActionPreference = 'Stop'

function U([string]$b) { [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b)) }
$voitheia   = U 'zpLOv86uzrjOtc65zrE='
$symdromee  = U 'zqPPhc69zrTPgc6/zrzOrg=='
$gdprLabel  = 'GDPR'
$reportLabel = U 'zpHOvc6xzr/Pgc6sIM6UzrnOus6xz4PPhM63z4HOr8+Jzr0='

# =========== BACKEND ===========
if ((Get-Location).Path -eq 'C:\thesis-web-repo') {
    $src = "$env:USERPROFILE\Downloads\thesis-final-v3\backend"
    if (-not (Test-Path $src)) { throw "Extract thesis-final-v3.zip first" }

    if (-not (Test-Path 'src\services'))   { New-Item -ItemType Directory -Path 'src\services'   | Out-Null }
    if (-not (Test-Path 'src\middleware')) { New-Item -ItemType Directory -Path 'src\middleware' | Out-Null }

    Copy-Item "$src\viva.js"          -Destination "src\services\viva.js"            -Force
    Copy-Item "$src\email.js"         -Destination "src\services\email.js"           -Force
    Copy-Item "$src\subscriptions.js" -Destination "src\routes\subscriptions.js"     -Force
    Copy-Item "$src\platform.js"      -Destination "src\routes\platform.js"          -Force
    Copy-Item "$src\accessControl.js" -Destination "src\middleware\accessControl.js" -Force
    Copy-Item "$src\case-access.js"   -Destination "src\routes\case-access.js"       -Force
    Copy-Item "$src\users-admin.js"   -Destination "src\routes\users-admin.js"       -Force
    Copy-Item "$src\auth.js"          -Destination "src\routes\auth.js"              -Force
    Copy-Item "$src\cases.js"         -Destination "src\routes\cases.js"             -Force
    Copy-Item "$src\finance.js"       -Destination "src\routes\finance.js"           -Force
    Copy-Item "$src\courts-report.js" -Destination "src\routes\courts-report.js"     -Force
    Copy-Item "$src\gdpr.js"          -Destination "src\routes\gdpr.js"              -Force
    Copy-Item "$src\cron.js"          -Destination "src\routes\cron.js"              -Force
    Write-Host "OK: 13 backend files copied"

    # Add nodemailer dep
    $pkgPath = 'package.json'
    $pkg = Get-Content $pkgPath -Raw -Encoding UTF8
    if ($pkg -notmatch '"nodemailer"') {
        $pkg = $pkg -replace '(\"docxtemplater\":\s*\"[^\"]+\",)', "`$1`r`n    `"nodemailer`": `"^6.9.0`","
        Set-Content $pkgPath $pkg -NoNewline -Encoding UTF8
        Write-Host "OK: nodemailer added to package.json - run: npm install"
    }

    # Patch server.js
    $srvPath = 'src\server.js'
    $srv = Get-Content $srvPath -Raw -Encoding UTF8
    $mounts = @(
        @{ name='platform';      line="app.use('/api/platform',                require('./routes/platform'));" },
        @{ name='subscriptions'; line="app.use('/api',                         require('./routes/subscriptions'));" },
        @{ name='case-access';   line="app.use('/api/case-access',             require('./routes/case-access'));" },
        @{ name='users-admin';   line="app.use('/api/users-admin',             require('./routes/users-admin'));" },
        @{ name='courts-report'; line="app.use('/api/reports/courts-report',   require('./routes/courts-report'));" },
        @{ name='gdpr';          line="app.use('/api/gdpr',                    require('./routes/gdpr'));" },
        @{ name='cron';          line="app.use('/api/cron',                    require('./routes/cron'));" }
    )
    $anchor = "app.use('/api/mydata',            require('./routes/mydata'));"
    if ($srv.Contains($anchor)) {
        $inject = $anchor
        foreach ($m in $mounts) {
            if (-not $srv.Contains("require('./routes/$($m.name)')")) {
                $inject = "$inject`r`n$($m.line)"
            }
        }
        if ($inject -ne $anchor) {
            $srv = $srv.Replace($anchor, $inject)
            Set-Content $srvPath $srv -NoNewline -Encoding UTF8
            Write-Host "OK: server.js mounts added"
        } else {
            Write-Host "SKIP: server.js mounts present"
        }
    }

    Write-Host ""
    Write-Host "==================================================================="
    Write-Host "BACKEND DONE"
    Write-Host "==================================================================="
    Write-Host "1. npm install (για το nodemailer)"
    Write-Host "2. Railway env vars (Variables tab):"
    Write-Host "   Viva:  VIVA_ENV, VIVA_CLIENT_ID, VIVA_CLIENT_SECRET, VIVA_SOURCE_CODE,"
    Write-Host "          VIVA_MERCHANT_ID, VIVA_API_KEY, FRONTEND_URL"
    Write-Host "   SMTP:  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM"
    Write-Host "          (e.g. SendGrid, Gmail App Password, Postmark)"
    Write-Host "   Cron:  CRON_SECRET = <random 32-char string>"
    Write-Host "3. git add -A && git commit -m ""final v3"" && git push origin main"
    Write-Host "4. Setup daily cron στο Railway (Cron tab):"
    Write-Host "   POST /api/cron/trial-reminders      με X-CRON-KEY header"
    Write-Host "   POST /api/cron/expire-subscriptions με X-CRON-KEY header"
    Write-Host "   POST /api/cron/execute-deletions    με X-CRON-KEY header"
    exit 0
}

# =========== FRONTEND ===========
if ((Get-Location).Path -eq 'C:\thesis-frontend') {
    $src = "$env:USERPROFILE\Downloads\thesis-final-v3\frontend"
    if (-not (Test-Path $src)) { throw "Extract thesis-final-v3.zip first" }

    if (-not (Test-Path 'src\pages\Reports')) { New-Item -ItemType Directory -Path 'src\pages\Reports' -Force | Out-Null }

    Copy-Item "$src\pages\PlatformAdmin.jsx"        -Destination "src\pages\PlatformAdmin.jsx"           -Force
    Copy-Item "$src\pages\SubscriptionSettings.jsx" -Destination "src\pages\SubscriptionSettings.jsx"    -Force
    Copy-Item "$src\pages\SubscriptionReturn.jsx"   -Destination "src\pages\SubscriptionReturn.jsx"      -Force
    Copy-Item "$src\pages\CaseAccess.jsx"           -Destination "src\pages\CaseAccess.jsx"              -Force
    Copy-Item "$src\pages\Team.jsx"                 -Destination "src\pages\Team.jsx"                    -Force
    Copy-Item "$src\pages\Signup.jsx"               -Destination "src\pages\Signup.jsx"                  -Force
    Copy-Item "$src\pages\CourtsReport.jsx"         -Destination "src\pages\Reports\CourtsReport.jsx"    -Force
    Copy-Item "$src\pages\GdprSettings.jsx"         -Destination "src\pages\GdprSettings.jsx"            -Force
    Write-Host "OK: 8 frontend pages copied"

    # Patch api.js
    $apiPath = 'src\api.js'
    $api = Get-Content $apiPath -Raw -Encoding UTF8
    $modules = Get-Content "$src\patches\api-full-module.js" -Raw -Encoding UTF8

    foreach ($mod in @('platform','subscriptions','usersAdmin','caseAccess','courtsReport','gdpr')) {
        $api = [regex]::Replace($api, "(?ms)^export const ${mod}\s*=\s*\{.*?^\};\s*$", '')
    }
    $api = $api.TrimEnd() + "`r`n" + $modules.TrimEnd() + "`r`n"
    Set-Content $apiPath $api -NoNewline -Encoding UTF8
    Write-Host "OK: api.js modules replaced"

    # Patch App.jsx
    $appPath = 'src\App.jsx'
    $app = Get-Content $appPath -Raw -Encoding UTF8

    $imports = @(
        @{ name='PlatformAdmin';        line="import PlatformAdmin from './pages/PlatformAdmin';" },
        @{ name='SubscriptionSettings'; line="import SubscriptionSettings from './pages/SubscriptionSettings';" },
        @{ name='SubscriptionReturn';   line="import { SubscriptionSuccess, SubscriptionFailure } from './pages/SubscriptionReturn';" },
        @{ name='CaseAccess';           line="import CaseAccess from './pages/CaseAccess';" },
        @{ name='Signup';               line="import Signup from './pages/Signup';" },
        @{ name='CourtsReport';         line="import CourtsReport from './pages/Reports/CourtsReport';" },
        @{ name='GdprSettings';         line="import GdprSettings from './pages/GdprSettings';" }
    )
    $impAnchor = "import Templates from './pages/Templates';"
    if ($app.Contains($impAnchor)) {
        $newImports = $impAnchor
        foreach ($imp in $imports) {
            if (-not $app.Contains($imp.line)) {
                $newImports = "$newImports`r`n$($imp.line)"
            }
        }
        if ($newImports -ne $impAnchor) {
            $app = $app.Replace($impAnchor, $newImports)
            Write-Host "OK: App.jsx imports added"
        }
    }

    $routes = @(
        @{ path='/register';                el='<Signup />' },
        @{ path='/platform';                el='guard(PlatformAdmin)' },
        @{ path='/settings/subscription';   el='guard(SubscriptionSettings)' },
        @{ path='/subscription/success';    el='guard(SubscriptionSuccess)' },
        @{ path='/subscription/failure';    el='guard(SubscriptionFailure)' },
        @{ path='/cases/:id/access';        el='guard(CaseAccess)' },
        @{ path='/reports/courts';          el='guard(CourtsReport)' },
        @{ path='/settings/gdpr';           el='guard(GdprSettings)' }
    )
    $routeAnchor = '<Route path="/settings/templates" element={guard(Templates)} />'
    if ($app.Contains($routeAnchor)) {
        $newRoutes = $routeAnchor
        foreach ($rt in $routes) {
            if (-not $app.Contains("path=""$($rt.path)""")) {
                $elFmt = if ($rt.el -like '<*') { $rt.el } else { "{$($rt.el)}" }
                $newRoutes = "$newRoutes`r`n        <Route path=""$($rt.path)"" element=$elFmt />"
            }
        }
        if ($newRoutes -ne $routeAnchor) {
            $app = $app.Replace($routeAnchor, $newRoutes)
            Write-Host "OK: App.jsx routes added"
        }
    }
    Set-Content $appPath $app -NoNewline -Encoding UTF8

    # Patch Layout.jsx
    $layPath = 'src\components\Layout.jsx'
    $lay = Get-Content $layPath -Raw -Encoding UTF8

    # Subscription menu item (μια φορά)
    if ($lay -notmatch "path:\s*'/settings/subscription'") {
        $lay = $lay -replace "(\{ path: '/settings/templates', label: '[^']+', icon: '[^']+' \},?)",
                             "`$1`r`n      { path: '/settings/subscription', label: '$symdromee', icon: '\ud83d\udcb3' },`r`n      { path: '/settings/gdpr', label: '$gdprLabel', icon: '\ud83d\udee1\ufe0f' },"
        Write-Host "OK: Subscription + GDPR menu items added"
    }

    # Courts report μενού link
    if ($lay -notmatch "path:\s*'/reports/courts'") {
        $lay = $lay -replace "(\{ path: '/reports/calendar-tasks',[^}]+\},?)",
                             "`$1`r`n      { path: '/reports/courts', label: '$reportLabel', icon: '\u2696\ufe0f' },"
        Write-Host "OK: Courts report menu item added"
    }

    # Platform admin group
    if ($lay -notmatch "path:\s*'/platform'") {
        $needle1 = "  {`r`n    title: '$voitheia',"
        $needle2 = "  {`n    title: '$voitheia',"
        $needleFound = if ($lay.Contains($needle1)) { $needle1 } elseif ($lay.Contains($needle2)) { $needle2 } else { $null }
        if ($needleFound) {
            $platformGroup = @"
  {
    title: 'Platform (admin only)',
    items: [
      { path: '/platform', label: 'Platform Admin', icon: '\ud83d\udee1\ufe0f', platformOnly: true },
    ],
  },

"@
            $lay = $lay.Replace($needleFound, ($platformGroup + $needleFound))
            if ($lay -notmatch "!item\.platformOnly") {
                $lay = $lay.Replace(
                    "                {group.items.map(item => (",
                    "                {group.items.filter(item => !item.platformOnly || user.is_platform_admin).map(item => ("
                )
            }
            Write-Host "OK: Platform admin group added"
        }
    }
    Set-Content $layPath $lay -NoNewline -Encoding UTF8

    Write-Host ""
    Write-Host "==================================================================="
    Write-Host "FRONTEND DONE"
    Write-Host "==================================================================="
    Write-Host "  npm run build"
    Write-Host "  npx wrangler deploy"
    Write-Host "  git add -A && git commit -m ""final v3 UI"" && git push origin main"
    exit 0
}

throw "Run from C:\thesis-web-repo (backend) or C:\thesis-frontend (frontend)"
