[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.:-]*$')]
    [Alias('Host')]
    [string]$VpsHost = '172.237.2.229',

    [ValidatePattern('^[A-Za-z_][A-Za-z0-9_-]*$')]
    [string]$User = 'root',

    [ValidateSet('Deploy', 'Status', 'Rollback', 'Info', 'AuthCheck', 'EnableMulti')]
    [string]$Action = 'Deploy',

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._/@-]*$')]
    [string]$Ref = 'main',

    [ValidatePattern('^/[A-Za-z0-9._/-]+$')]
    [string]$AppRoot = '/opt/line-first-response',

    [string]$IdentityFile
)

# Runs the transactional Linux release script from a Windows workstation.
# Examples:
#   .\deploy\deploy.ps1
#   .\deploy\deploy.ps1 -Host bot.example.com -Ref v1.2.0
#   .\deploy\deploy.ps1 -Host bot.example.com -Action Status
#   .\deploy\deploy.ps1 -Host bot.example.com -Action Rollback -IdentityFile "$HOME\.ssh\line-bot"
#   .\deploy\deploy.ps1 -Action Info
#   .\deploy\deploy.ps1 -Action AuthCheck
#   .\deploy\deploy.ps1 -Action EnableMulti

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Error $Message
    exit 1
}

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Fail 'OpenSSH client (ssh.exe) was not found. Install the Windows OpenSSH Client feature first.'
}

if ($IdentityFile) {
    $IdentityFile = [Environment]::ExpandEnvironmentVariables($IdentityFile)
    if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
        Fail "SSH identity file was not found: $IdentityFile"
    }
    $IdentityFile = (Resolve-Path -LiteralPath $IdentityFile).Path
}

$releaseScript = "$AppRoot/current/deploy/release.sh"
$remoteCommand = if ($Action -eq 'Info') {
    # Read-only troubleshooting data: identifies the repository and refs that
    # the release host can actually resolve before attempting a deployment.
    "git -C $AppRoot/repo remote -v; git -C $AppRoot/repo status --short --branch; git -C $AppRoot/repo log -1 --oneline"
} elseif ($Action -eq 'AuthCheck') {
    # GET /app with no Cookie. A correctly installed account gate redirects
    # this request to /account/login; a 200 means the active worker is stale
    # or its handler is not using the gate.
    "SYSTEMD_PAGER=cat systemctl --no-pager show lfr-worker.service -p ExecStart --value; curl -sS -D - -o /dev/null http://127.0.0.1:8791/app"
} elseif ($Action -eq 'EnableMulti') {
    "APP_ROOT=$AppRoot bash $AppRoot/current/deploy/enable-multi-user.sh"
} else {
    $releaseArgument = switch ($Action) {
        'Status' { '--status' }
        'Rollback' { '--rollback' }
        default { $Ref }
    }
    # Every variable interpolated into the remote command has a restrictive
    # ValidatePattern above, so it cannot alter the shell command on the server.
    "APP_ROOT=$AppRoot bash $releaseScript $releaseArgument"
}
$sshArguments = @('-tt')
if ($IdentityFile) {
    $sshArguments += @('-i', $IdentityFile)
}
$sshArguments += "$User@$VpsHost", $remoteCommand

Write-Host "[$Action] $User@$VpsHost" -ForegroundColor Cyan
if ($Action -eq 'Deploy') {
    Write-Host "Ref: $Ref" -ForegroundColor Cyan
}

& ssh @sshArguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
