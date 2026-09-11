$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$buildRoot = Join-Path $workspace '.build-check'
$staging = Join-Path $buildRoot ('package-' + [Guid]::NewGuid().ToString('N'))
$resolved = [IO.Path]::GetFullPath($staging)
$allowed = [IO.Path]::GetFullPath($buildRoot).TrimEnd('\') + '\'
if (-not $resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Package staging path must stay inside .build-check.' }
New-Item -ItemType Directory -Path $resolved -Force | Out-Null
try {
    foreach ($name in @('NT8Terminal.exe', 'README.txt')) {
        Copy-Item -LiteralPath (Join-Path $workspace $name) -Destination $resolved
    }
    Copy-Item -LiteralPath (Join-Path $workspace 'nt8-bridge/TvBridgeAddOn.cs') -Destination $resolved
    Copy-Item -LiteralPath (Join-Path $workspace 'app/dist') -Destination (Join-Path $resolved 'dist') -Recurse
    Copy-Item -LiteralPath (Join-Path $workspace 'copy-trading/dist') -Destination (Join-Path $resolved 'copy-trading') -Recurse
    Compress-Archive -Path (Join-Path $resolved '*') -DestinationPath (Join-Path $workspace 'NT8Terminal-package.zip') -Force -CompressionLevel Optimal
} finally {
    if ([IO.Path]::GetFullPath($resolved).StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
