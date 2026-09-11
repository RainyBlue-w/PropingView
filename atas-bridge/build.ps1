param(
    [string]$AtasPath = 'D:\Program Files\ATAS X',
    [switch]$Test
)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$sdk = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $sdk) { throw '.NET 10 SDK is required. Install the SDK, then reopen PowerShell.' }
if (-not (Test-Path -LiteralPath (Join-Path $AtasPath 'ATAS.Indicators.dll'))) {
    throw "ATAS X SDK assemblies not found at $AtasPath. Pass -AtasPath with the installation directory."
}
$runtimePath = Join-Path $AtasPath 'OFT.PlatformX.runtimeconfig.json'
if (Test-Path -LiteralPath $runtimePath) {
    $runtime = Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($runtime.runtimeOptions.tfm -ne 'net10.0') {
        throw "This bridge targets .NET 10; installed ATAS targets $($runtime.runtimeOptions.tfm)."
    }
}
$env:DOTNET_CLI_HOME = Join-Path $workspace '.build-check/dotnet-home'
$config = Join-Path $PSScriptRoot 'NuGet.Config'
& $sdk.Source build (Join-Path $PSScriptRoot 'TvAtasBridge.csproj') -c Release --configfile $config "-p:AtasPath=$AtasPath" -p:NuGetAudit=false --nologo
if ($LASTEXITCODE -ne 0) { throw 'ATAS bridge build failed.' }
if ($Test) {
    $testProjects = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'tests') -Recurse -Filter '*.csproj'
    foreach ($testProject in $testProjects) {
        & $sdk.Source build $testProject.FullName -c Release --configfile $config "-p:AtasPath=$AtasPath" -p:NuGetAudit=false --nologo
        if ($LASTEXITCODE -ne 0) { throw "Test build failed: $($testProject.Name)" }
        & $sdk.Source run --no-build --no-restore --project $testProject.FullName -c Release -- $AtasPath
        if ($LASTEXITCODE -ne 0) { throw "Test failed: $($testProject.Name)" }
    }
}
$dll = Join-Path $workspace '.build-check/atas-bridge/bin/Release/net10.0-windows/TvAtasBridge.dll'
if (-not (Test-Path -LiteralPath $dll)) { throw 'Build completed without the expected bridge DLL.' }
$package = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Path $package -Force | Out-Null
$loadableDll = Join-Path $package 'TvAtasBridge.dll'
Copy-Item -LiteralPath $dll -Destination $loadableDll -Force
Write-Host "Bridge ready: $loadableDll"
Write-Host 'Load this DLL using Add custom indicator in ATAS X, then attach TradingView Terminal Bridge to one chart.'
