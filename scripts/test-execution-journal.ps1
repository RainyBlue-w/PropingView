$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$source = [IO.File]::ReadAllText((Join-Path $workspace 'nt8-bridge/TvBridgeAddOn.cs'))
$archiveStart = $source.IndexOf('        // BEGIN EXECUTION_ARCHIVE')
$archiveEnd = $source.IndexOf('        // GET /api/brackets', $archiveStart)
$methods = $source.Substring($archiveStart, $archiveEnd - $archiveStart)
$template = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'test-execution-journal-template.cs'))
$testDir = Join-Path $workspace ('.tmp-webbridge/journal-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testDir) | Out-Null
$generated = Join-Path $testDir 'ExecutionJournalTests.cs'
[IO.File]::WriteAllText($generated, $template.Replace('/* PRODUCTION_ARCHIVE */', $methods))
$compiler = 'C:/Program Files (x86)/Microsoft Visual Studio/2019/BuildTools/MSBuild/Current/Bin/Roslyn/csc.exe'
$exe = Join-Path $testDir 'ExecutionJournalTests.exe'
& $compiler /nologo /target:exe "/out:$exe" $generated
if ($LASTEXITCODE -ne 0) { throw 'Execution journal test compilation failed' }
& $exe $testDir
if ($LASTEXITCODE -ne 0) { throw 'Execution journal tests failed' }
