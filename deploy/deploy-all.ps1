[CmdletBinding()]
param(
    [string]$Remote = 'vps',

    [Alias('Host')]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.:-]*$')]
    [string]$VpsHost = '172.237.2.229',

    [ValidatePattern('^[A-Za-z_][A-Za-z0-9_-]*$')]
    [string]$User = 'root',

    [string]$IdentityFile,

    [switch]$EnableMultiUser
)

# One-click release of the entire current project state.
#
# It builds a temporary Git snapshot using a private index, then publishes and
# deploys that snapshot. Main, the visible staging area, and the working tree
# stay unchanged. Ignored files (credentials, node_modules, coverage, etc.)
# remain excluded by .gitignore.
#
# First-time setup:
#   git remote add vps ssh://root@172.237.2.229/opt/line-first-response/hub.git
#
# Use:
#   .\deploy\deploy-all.ps1
#   .\deploy\deploy-all.ps1 -EnableMultiUser

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Error $Message
    exit 1
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail 'Git was not found on PATH.'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git'))) {
    Fail 'This script must be inside a Git checkout.'
}

Push-Location $repoRoot
try {
    & git remote get-url $Remote *> $null
    if ($LASTEXITCODE -ne 0) {
        Fail "Git remote '$Remote' is not configured. Run: git remote add $Remote ssh://root@172.237.2.229/opt/line-first-response/hub.git"
    }

    $baseCommit = (& git rev-parse --verify 'HEAD^{commit}').Trim()
    if ($LASTEXITCODE -ne 0 -or $baseCommit -notmatch '^[0-9a-f]{40}$') {
        Fail 'HEAD is not a valid commit.'
    }

    $privateIndex = Join-Path ([IO.Path]::GetTempPath()) "lfr-deploy-index-$([guid]::NewGuid().ToString('N'))"
    $oldIndex = $env:GIT_INDEX_FILE
    try {
        $env:GIT_INDEX_FILE = $privateIndex
        & git read-tree $baseCommit
        if ($LASTEXITCODE -ne 0) { Fail 'Could not prepare the deployment snapshot.' }

        # -A includes added, changed, renamed and deleted project files while
        # respecting .gitignore. It writes only the temporary index above.
        & git add -A
        if ($LASTEXITCODE -ne 0) { Fail 'Could not add project files to the deployment snapshot.' }

        $tree = (& git write-tree).Trim()
        if ($LASTEXITCODE -ne 0 -or $tree -notmatch '^[0-9a-f]{40}$') {
            Fail 'Could not build the deployment tree.'
        }

        $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        $snapshot = (& git commit-tree $tree -p $baseCommit -m "deploy snapshot $stamp").Trim()
        if ($LASTEXITCODE -ne 0 -or $snapshot -notmatch '^[0-9a-f]{40}$') {
            Fail 'Could not create the deployment snapshot. Configure Git user.name and user.email first.'
        }
    } finally {
        if ($null -eq $oldIndex) {
            Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue
        } else {
            $env:GIT_INDEX_FILE = $oldIndex
        }
        Remove-Item -LiteralPath $privateIndex -Force -ErrorAction SilentlyContinue
    }

    Write-Host "Deploying snapshot $snapshot (base $baseCommit)" -ForegroundColor Cyan
    $publish = Join-Path $PSScriptRoot 'publish-and-deploy.ps1'
    if ($IdentityFile -and $EnableMultiUser) {
        & $publish -Ref $snapshot -Remote $Remote -VpsHost $VpsHost -User $User -IdentityFile $IdentityFile -AllowDirty -EnableMultiUser
    } elseif ($IdentityFile) {
        & $publish -Ref $snapshot -Remote $Remote -VpsHost $VpsHost -User $User -IdentityFile $IdentityFile -AllowDirty
    } elseif ($EnableMultiUser) {
        & $publish -Ref $snapshot -Remote $Remote -VpsHost $VpsHost -User $User -AllowDirty -EnableMultiUser
    } else {
        & $publish -Ref $snapshot -Remote $Remote -VpsHost $VpsHost -User $User -AllowDirty
    }
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
