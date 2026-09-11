$ErrorActionPreference = 'Stop'
$executable = Join-Path $PSScriptRoot 'CopyTrading.exe'
if (-not (Test-Path -LiteralPath $executable)) { $executable = Join-Path $PSScriptRoot 'dist/CopyTrading.exe' }
if (-not (Test-Path -LiteralPath $executable)) {
    throw 'CopyTrading.exe is missing. Run copy-trading/build.cmd first.'
}
$listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
if ($listeners | Where-Object { $_.Port -eq 8092 }) {
    Write-Host 'Port 8092 is already in use. Existing service was left running; check the web page for its status.'
    exit 0
}
$child = Start-Process -FilePath $executable -WorkingDirectory (Split-Path -Parent $executable) -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 600
if ($child.HasExited -and $child.ExitCode -ne 0) {
    throw 'Copy trading service stopped during startup. Check that the ASP.NET Core 10 runtime is installed.'
}
Write-Host 'Copy trading service started in the background at http://127.0.0.1:8092.'
Write-Host 'Open the web terminal to configure it. Closing the browser does not stop the service.'
