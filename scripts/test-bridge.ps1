$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$source = [IO.File]::ReadAllText((Join-Path $workspace 'nt8-bridge/TvBridgeAddOn.cs'))
$start = $source.IndexOf('        private void RegisterBracketOnFill(')
$end = $source.IndexOf('        // POST {account, orderId}', $start)
$methods = $source.Substring($start, $end - $start)
$template = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'test-bridge-template.cs'))
$generated = Join-Path $workspace '.tmp-webbridge/BridgeTests.cs'
[IO.File]::WriteAllText($generated, $template.Replace('/* PRODUCTION_METHODS */', $methods))
$compiler = 'C:/Program Files (x86)/Microsoft Visual Studio/2019/BuildTools/MSBuild/Current/Bin/Roslyn/csc.exe'
$exe = Join-Path $workspace '.tmp-webbridge/BridgeTests.exe'
& $compiler /nologo /target:exe "/out:$exe" $generated
if ($LASTEXITCODE -ne 0) { throw 'Bridge test compilation failed' }
& $exe
if ($LASTEXITCODE -ne 0) { throw 'Bridge tests failed' }
