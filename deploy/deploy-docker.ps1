[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.:-]*$')]
    [Alias('Host')]
    [string]$VpsHost = '172.237.8.10',

    [ValidatePattern('^[A-Za-z_][A-Za-z0-9_-]*$')]
    [string]$User = 'root',

    [ValidateRange(1, 65535)]
    [int]$Port = 8793,

    [ValidateSet('Deploy', 'Status', 'Rollback', 'Tune', 'Logs')]
    [string]$Action = 'Deploy',

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$')]
    [string]$Ref = 'HEAD',

    [string]$IdentityFile,

    [switch]$AllowDirty
)

# Deploys one commit of this checkout to a VPS as a Docker container on
# host networking, serving the multi-user console on http://<host>:<port>/.
#
#   .\deploy\deploy-docker.ps1                    # HEAD -> 172.237.8.10:8793
#   .\deploy\deploy-docker.ps1 -Action Status
#   .\deploy\deploy-docker.ps1 -Action Logs
#   .\deploy\deploy-docker.ps1 -Action Rollback
#   .\deploy\deploy-docker.ps1 -Action Tune       # sysctl + fastest-IP timer on the host
#
# Only tracked files are shipped (git archive): sessions, accounts, real bot
# configs and keys never leave this machine. State lives on the server under
# /opt/lfr-<port>. The first deploy prints a generated admin password once.

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Error $Message
    exit 1
}

foreach ($tool in 'git', 'ssh', 'scp') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Fail "$tool was not found on PATH (install Git for Windows and the Windows OpenSSH Client)."
    }
}

$sshArgs = @()
if ($IdentityFile) {
    $IdentityFile = [Environment]::ExpandEnvironmentVariables($IdentityFile)
    if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
        Fail "SSH identity file was not found: $IdentityFile"
    }
    $sshArgs += @('-i', (Resolve-Path -LiteralPath $IdentityFile).Path)
}
$target = "$User@$VpsHost"
$root = "/opt/lfr-$Port"
$remoteEnv = "LFR_PORT=$Port LFR_ROOT=$root"

function Invoke-Remote([string]$Command) {
    & ssh @sshArgs -tt $target $Command
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

switch ($Action) {
    'Status' { Invoke-Remote "$remoteEnv bash $root/current/deploy/docker/release.sh --status"; exit 0 }
    'Rollback' { Invoke-Remote "$remoteEnv bash $root/current/deploy/docker/release.sh --rollback"; exit 0 }
    'Logs' { Invoke-Remote "docker logs --tail 200 -f lfr-$Port"; exit 0 }
    'Tune' {
        Invoke-Remote "APP_ROOT=$root SKIP_WORKER_UNIT=1 bash $root/current/deploy/enable-latency-tuning.sh"
        exit 0
    }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
    if (-not $AllowDirty) {
        & git diff --quiet
        $unstaged = $LASTEXITCODE -ne 0
        & git diff --cached --quiet
        $staged = $LASTEXITCODE -ne 0
        if ($unstaged -or $staged) {
            Fail 'Working tree has uncommitted changes; they would NOT be deployed. Commit first, or pass -AllowDirty to deploy the last commit anyway.'
        }
    }
    $commit = (& git rev-parse --verify "$Ref^{commit}").Trim()
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') {
        Fail "Cannot resolve '$Ref' to a commit."
    }

    $archive = Join-Path ([IO.Path]::GetTempPath()) "lfr-$commit.tar"
    & git archive --format=tar -o $archive $commit
    if ($LASTEXITCODE -ne 0) { Fail 'git archive failed.' }

    Write-Host "[Deploy] $commit -> $target (port $Port)" -ForegroundColor Cyan
    $remoteArchive = "/tmp/lfr-$commit.tar"
    & scp @sshArgs $archive "${target}:$remoteArchive"
    if ($LASTEXITCODE -ne 0) { Fail 'Upload failed.' }
    Remove-Item -LiteralPath $archive -Force

    # The release script travels inside the archive, so the server always runs
    # the version that matches the commit being deployed.
    Invoke-Remote "tar -xOf $remoteArchive deploy/docker/release.sh | $remoteEnv bash -s -- $remoteArchive $commit"
    Write-Host "Console: http://${VpsHost}:$Port/account/login" -ForegroundColor Green
} finally {
    Pop-Location
}
