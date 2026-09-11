param([switch]$Test)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$sdk = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $sdk) { throw '.NET 10 SDK is required. Install the SDK, then reopen PowerShell.' }
$env:DOTNET_CLI_HOME = Join-Path $workspace '.build-check/dotnet-home'
$config = Join-Path $PSScriptRoot 'NuGet.Config'
$project = Join-Path $PSScriptRoot 'CopyTrading.csproj'
$package = Join-Path $PSScriptRoot 'dist'
& $sdk.Source publish $project -c Release --no-self-contained --configfile $config -p:NuGetAudit=false --nologo --output $package
if ($LASTEXITCODE -ne 0) { throw 'Copy trading service build failed.' }
if (-not (Test-Path -LiteralPath (Join-Path $package 'CopyTrading.exe'))) {
    throw 'Build completed without the expected CopyTrading.exe.'
}
if ($Test -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'tests'))) {
    foreach ($testProject in (Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'tests') -Recurse -Filter '*.csproj')) {
        & $sdk.Source build $testProject.FullName -c Release --configfile $config -p:NuGetAudit=false --nologo
        if ($LASTEXITCODE -ne 0) { throw "Test build failed: $($testProject.Name)" }
        & $sdk.Source run --no-build --no-restore --project $testProject.FullName -c Release
        if ($LASTEXITCODE -ne 0) { throw "Test failed: $($testProject.Name)" }
    }
}
foreach ($name in @('start.cmd', 'start.ps1', 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $package $name) -Force
}
Write-Host "Service ready: $(Join-Path $package 'CopyTrading.exe')"
Write-Host 'Run copy-trading/start.cmd to start it in the background. New configurations are disabled by default.'
