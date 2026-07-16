# run-platform.ps1
# Platform admin batch deploy. Pure ASCII.
# Auto-detects backend vs frontend by current directory.
#
# Prerequisites:
#   Expand-Archive -Path "$env:USERPROFILE\Downloads\thesis-platform.zip" -DestinationPath "$env:USERPROFILE\Downloads\" -Force

$ErrorActionPreference = 'Stop'

function U([string]$b) { [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b)) }
$voitheia = U 'zpLOv86uzrjOtc65zrE='

# =========== BACKEND ===========
if ((Get-Location).Path -eq 'C:\thesis-web-repo') {
    $src = "$env:USERPROFILE\Downloads\thesis-platform\backend"
    if (-not (Test-Path $src)) { throw "Extract thesis-platform.zip first" }

    Copy-Item "$src\platform.js" -Destination "src\routes\platform.js" -Force
    Write-Host "OK: platform.js copied"

    $srvPath = 'src\server.js'
    $srv     = Get-Content $srvPath -Raw -Encoding UTF8

    if ($srv -match "require\('./routes/platform'\)") {
        Write-Host "SKIP: /api/platform already mounted"
    } else {
        $needle = "app.use('/api/mydata',            require('./routes/mydata'));"
        $inject = "$needle`r`napp.use('/api/platform',          require('./routes/platform'));"
        if ($srv.Contains($needle)) {
            $srv = $srv.Replace($needle, $inject)
            Set-Content $srvPath $srv -NoNewline -Encoding UTF8
            Write-Host "OK: /api/platform mounted"
        } else {
            Write-Warning "server.js mount not found - add manually"
        }
    }

    Write-Host ""
    Write-Host "=== Backend done ==="
    Write-Host "1. Commit + push:"
    Write-Host "   git add -A"
    Write-Host "   git commit -m ""platform admin panel"""
    Write-Host "   git push origin main"
    Write-Host ""
    Write-Host "2. After Railway redeploy, make yourself platform admin."
    Write-Host "   Go to Railway PostgreSQL Data tab, run:"
    Write-Host "     UPDATE users SET is_platform_admin = TRUE WHERE email = 'admin@test.com';"
    Write-Host "   (Replace with your actual email)"
    exit 0
}

# =========== FRONTEND ===========
if ((Get-Location).Path -eq 'C:\thesis-frontend') {
    $src = "$env:USERPROFILE\Downloads\thesis-platform\frontend"
    if (-not (Test-Path $src)) { throw "Extract thesis-platform.zip first" }

    Copy-Item "$src\PlatformAdmin.jsx" -Destination "src\pages\PlatformAdmin.jsx" -Force
    Write-Host "OK: PlatformAdmin.jsx copied"

    # Patch api.js
    $apiPath = 'src\api.js'
    $api     = Get-Content $apiPath -Raw -Encoding UTF8
    $platformBlock = Get-Content "$src\api-platform-module.js" -Raw -Encoding UTF8

    if ($api -match "export const platform\s*=") {
        Write-Host "SKIP: api.js platform module already"
    } else {
        $api = $api.TrimEnd() + "`r`n" + $platformBlock.TrimEnd() + "`r`n"
        Set-Content $apiPath $api -NoNewline -Encoding UTF8
        Write-Host "OK: api.js patched"
    }

    # Patch App.jsx
    $appPath = 'src\App.jsx'
    $app     = Get-Content $appPath -Raw -Encoding UTF8

    $impNeedle = "import Templates from './pages/Templates';"
    $impNew    = "$impNeedle`r`nimport PlatformAdmin from './pages/PlatformAdmin';"
    if ($app.Contains("import PlatformAdmin")) {
        Write-Host "SKIP: PlatformAdmin import already"
    } elseif ($app.Contains($impNeedle)) {
        $app = $app.Replace($impNeedle, $impNew)
        Write-Host "OK: PlatformAdmin import added"
    }

    $routeNeedle = '<Route path="/settings/templates" element={guard(Templates)} />'
    $routeNew    = "$routeNeedle`r`n        <Route path=""/platform""            element={guard(PlatformAdmin)} />"
    if ($app.Contains('path="/platform"')) {
        Write-Host "SKIP: /platform route already"
    } elseif ($app.Contains($routeNeedle)) {
        $app = $app.Replace($routeNeedle, $routeNew)
        Write-Host "OK: /platform route added"
    }

    Set-Content $appPath $app -NoNewline -Encoding UTF8

    # Patch Layout.jsx: add platform menu group + filter platformOnly items
    $layPath = 'src\components\Layout.jsx'
    $lay     = Get-Content $layPath -Raw -Encoding UTF8

    if ($lay.Contains("path: '/platform'")) {
        Write-Host "SKIP: platform menu already"
    } else {
        # Try CRLF first, then LF
        $needle1 = "  {`r`n    title: '$voitheia',"
        $needle2 = "  {`n    title: '$voitheia',"

        $needleFound = $null
        if ($lay.Contains($needle1)) { $needleFound = $needle1 }
        elseif ($lay.Contains($needle2)) { $needleFound = $needle2 }

        if ($needleFound) {
            $inject = @"
  {
    title: 'Platform (admin only)',
    items: [
      { path: '/platform', label: 'Platform Admin', icon: '\ud83d\udee1\ufe0f', platformOnly: true },
    ],
  },

"@ + $needleFound

            $lay = $lay.Replace($needleFound, $inject)

            # Filter platformOnly items in rendering
            $filterOld = "                {group.items.map(item => ("
            $filterNew = "                {group.items.filter(item => !item.platformOnly || user.is_platform_admin).map(item => ("
            if (-not $lay.Contains("!item.platformOnly")) {
                $lay = $lay.Replace($filterOld, $filterNew)
            }
            Set-Content $layPath $lay -NoNewline -Encoding UTF8
            Write-Host "OK: platform menu added"
        } else {
            Write-Warning "Layout.jsx menu needle not found - add manually"
        }
    }

    Write-Host ""
    Write-Host "=== Frontend done ==="
    Write-Host "  npm run build"
    Write-Host "  npx wrangler deploy"
    Write-Host "  git add -A && git commit -m ""platform admin UI"" && git push origin main"
    exit 0
}

throw "Run from C:\thesis-web-repo (backend) or C:\thesis-frontend (frontend)"
