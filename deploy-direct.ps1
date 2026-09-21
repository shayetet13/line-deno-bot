[CmdletBinding()]
param(
  [string]$ServerHost = '172.237.2.229',
  [string]$RemoteUser = 'root',
  [string]$RemoteRoot = '/opt/line-first-response/current',
  [string]$ServiceName = 'lfr-worker',
  [int]$HealthPort = 8791
)

$ErrorActionPreference = 'Stop'

$pscp = 'C:\Program Files\PuTTY\pscp.exe'
$plink = 'C:\Program Files\PuTTY\plink.exe'
$hostKey = 'SHA256:yUykqeSA2tdcoPfUMD60GmzhpjSArqLXoZuhCfDBSkw'
$files = @(
  'apps\worker\src\observability\dashboard.ts',
  'apps\worker\src\monitoring\alerts.ts'
)

foreach ($tool in @($pscp, $plink)) {
  if (-not (Test-Path -LiteralPath $tool)) {
    throw "PuTTY executable not found: $tool"
  }
}

foreach ($file in $files) {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $file))) {
    throw "Source file not found: $file"
  }
}

$securePassword = Read-Host 'SSH password' -AsSecureString
$passwordPointer = [IntPtr]::Zero
$plainPassword = $null

try {
  $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)

  foreach ($file in $files) {
    $source = Join-Path $PSScriptRoot $file
    $remote = "$RemoteUser@$ServerHost`:$RemoteRoot/$($file.Replace('\', '/'))"
    Write-Host "Uploading $file"
    & $pscp -batch -pw $plainPassword -hostkey $hostKey $source $remote
    if ($LASTEXITCODE -ne 0) { throw "Upload failed: $file" }
  }

  $healthUrl = "http://127.0.0.1:$HealthPort/api/health"
  $remoteCommand = "set -Eeuo pipefail; systemctl restart $ServiceName; for i in `$(seq 1 30); do if curl -fsS --max-time 5 $healthUrl; then exit 0; fi; sleep 2; done; systemctl status $ServiceName --no-pager --lines=30 >&2; exit 1"
  Write-Host "Restarting $ServiceName and waiting for readiness"
  & $plink -ssh -batch -hostkey $hostKey -pw $plainPassword "$RemoteUser@$ServerHost" $remoteCommand
  if ($LASTEXITCODE -ne 0) { throw "Deployment failed health check for $ServiceName" }

  Write-Host 'Deployment complete.'
}
finally {
  if ($passwordPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  }
  $plainPassword = $null
}
