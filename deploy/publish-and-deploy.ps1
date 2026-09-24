[CmdletBinding()]
param(
    [string]$Ref = 'HEAD',

    [string]$Remote = 'vps',

    [Alias('Host')]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.:-]*$')]
    [string]$VpsHost = '172.237.2.229',

    [ValidatePattern('^[A-Za-z_][A-Za-z0-9_-]*$')]
    [string]$User = 'root',

    [string]$IdentityFile,

    [switch]$EnableMultiUser,

    [switch]$AllowDirty
)

# Publishes one immutable commit to the VPS bare repository, then asks the
# transactional release script to deploy that exact SHA.  It never overwrites
# main, so a failed release or unfinished work cannot move the production ref.
#
# First-time setup:
#   git remote add vps ssh://root@172.237.2.229/opt/line-first-response/hub.git
#
# Use:
#   .\deploy\publish-and-deploy.ps1
#   .\deploy\publish-and-deploy.ps1 -Ref HEAD

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Error $Message
    exit 1
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail 'Git was not found on PATH.'
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot '..\.git'))) {
    Fail 'Run this script from a checkout of line-first-response.'
}

if (-not $AllowDirty) {
    & git diff --quiet
    $unstaged = $LASTEXITCODE -ne 0
    & git diff --cached --quiet
    $staged = $LASTEXITCODE -ne 0
    if ($unstaged -or $staged) {
        Fail 'Working tree has uncommitted changes. Commit or stash them first; use -AllowDirty only when intentionally deploying an older commit.'
    }
}

$commit = (& git rev-parse --verify "$Ref^{commit}").Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') {
    Fail "Cannot resolve '$Ref' to a commit."
}

& git remote get-url $Remote *> $null
if ($LASTEXITCODE -ne 0) {
    Fail "Git remote '$Remote' is not configured. Run: git remote add $Remote ssh://root@172.237.2.229/opt/line-first-response/hub.git"
}

$releaseBranch = "codex/releases/$commit"
Write-Host "Publishing $commit to $Remote/$releaseBranch" -ForegroundColor Cyan
& git push $Remote "${commit}:refs/heads/$releaseBranch"
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

if ($IdentityFile) {
    & (Join-Path $PSScriptRoot 'deploy.ps1') -Ref $commit -VpsHost $VpsHost -User $User -IdentityFile $IdentityFile
} else {
    & (Join-Path $PSScriptRoot 'deploy.ps1') -Ref $commit -VpsHost $VpsHost -User $User
}
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

if ($EnableMultiUser) {
    if ($IdentityFile) {
        & (Join-Path $PSScriptRoot 'deploy.ps1') -Action EnableMulti -VpsHost $VpsHost -User $User -IdentityFile $IdentityFile
    } else {
        & (Join-Path $PSScriptRoot 'deploy.ps1') -Action EnableMulti -VpsHost $VpsHost -User $User
    }
}

exit $LASTEXITCODE
