#Requires -Version 5.1
<#
    line-first-response launcher.

    The UI lives here rather than in start.bat because cmd.exe cannot parse a
    batch file that contains multi-byte UTF-8 text: it seeks by byte offset
    while the code page says characters, so Thai labels desynchronise the
    parser and it starts executing fragments of lines. PowerShell reads UTF-8
    correctly, so start.bat is a pure-ASCII shim that calls this.

    Host and port come from start.local.ps1 (gitignored). The SSH password is
    never stored in a tracked file: set $env:LFR_SSH_PW, point LFR_SSH_KEY at a
    PuTTY key, or let this prompt for it.
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- config ---------------------------------------------------------
$cfg = @{
    Host        = ''
    User        = 'root'
    Port        = 8791
    Bot         = 'bot-1'
    HostKey     = ''
    SshKey      = ''
    # Public dashboard via nginx (deploy/nginx-dashboard.conf) -- optional.
    # Leave WebUser blank to hide the menu item if nginx isn't set up.
    WebUser     = ''
    WebPassword = ''
}
$localConfig = Join-Path $root 'start.local.ps1'
if (Test-Path $localConfig) { . $localConfig }

if (-not $cfg.Host) {
    Write-Host ''
    Write-Host '  [x] ยังไม่ได้ตั้งค่า server' -ForegroundColor Yellow
    Write-Host '      สร้างไฟล์ start.local.ps1 ข้าง ๆ ไฟล์นี้ แล้วใส่:'
    Write-Host ''
    Write-Host '          $cfg.Host    = "172.237.14.170"'
    Write-Host '          $cfg.HostKey = "SHA256:xxxxx"'
    Write-Host '          $cfg.SshKey  = "C:\path\to\key.ppk"   # หรือเว้นไว้แล้วใส่รหัสผ่านตอนถาม'
    Write-Host ''
    Write-Host '      ไฟล์นี้อยู่ใน .gitignore แล้ว จะไม่ถูก commit'
    Write-Host ''
    Read-Host 'กด Enter เพื่อปิด' | Out-Null
    exit 1
}

# --- ssh plumbing ---------------------------------------------------
$script:auth = $null

function Test-Tool([string]$name, [string]$hint) {
    if (Get-Command $name -ErrorAction SilentlyContinue) { return $true }
    Write-Host ''
    Write-Host "  [x] ไม่พบ $name ใน PATH" -ForegroundColor Red
    Write-Host "      $hint"
    return $false
}

function Initialize-Auth {
    if ($script:auth) { return $true }
    if (-not (Test-Tool 'plink' 'ติดตั้ง PuTTY หรือเพิ่ม "C:\Program Files\PuTTY" ลง PATH')) { return $false }

    $a = @()
    if ($cfg.HostKey) { $a += @('-hostkey', $cfg.HostKey) }

    if ($cfg.SshKey) {
        $a += @('-i', $cfg.SshKey)
    }
    else {
        $pw = $env:LFR_SSH_PW
        if (-not $pw) {
            # Read-Host -AsSecureString keeps it off the screen; it still ends
            # up on plink's command line, which is why a key is preferable.
            $secure = Read-Host 'รหัสผ่าน SSH' -AsSecureString
            $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            try { $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
            finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        }
        if (-not $pw) {
            Write-Host '  [x] ไม่มีรหัสผ่าน - ยกเลิก' -ForegroundColor Red
            return $false
        }
        $a += @('-pw', $pw)
    }
    $script:auth = $a
    return $true
}

function Invoke-Ssh([string]$command, [switch]$Interactive) {
    $args = @('-ssh', '-batch') + $script:auth + @("$($cfg.User)@$($cfg.Host)", $command)
    if ($Interactive) { & plink @args } else { & plink @args 2>&1 }
}

function Wait-Key { Write-Host ''; Read-Host 'กด Enter เพื่อกลับเมนู' | Out-Null }

# --- actions --------------------------------------------------------
function Open-PublicDashboard {
    $url = "http://$($cfg.Host)/"
    if ($cfg.WebUser) {
        Write-Host ''
        Write-Host "user: $($cfg.WebUser)"
        Write-Host "pass: $($cfg.WebPassword)"
        Write-Host '(เบราว์เซอร์จะถาม login แบบ popup)'
    }
    Write-Host ''
    Write-Host "เปิด $url"
    Start-Process $url
    Wait-Key
}

function Open-Dashboard {
    if (-not (Initialize-Auth)) { Wait-Key; return }
    Write-Host ''
    Write-Host 'ตรวจว่า worker รันอยู่ไหม...'
    $state = (Invoke-Ssh 'systemctl is-active lfr-worker' | Out-String).Trim()
    if ($state -eq 'active') {
        Write-Host 'worker รันอยู่แล้ว' -ForegroundColor Green
    }
    else {
        Write-Host "worker ไม่ได้รัน (=$state) กำลังสั่งเริ่ม..." -ForegroundColor Yellow
        Invoke-Ssh 'systemctl start lfr-worker; sleep 15; systemctl is-active lfr-worker'
    }

    Write-Host ''
    Write-Host "tunnel  localhost:$($cfg.Port)  ->  $($cfg.Host):$($cfg.Port)"
    Write-Host 'ปิดหน้าต่างนี้ (หรือ Ctrl+C) เมื่อเลิกใช้ - tunnel จะปิดตาม'
    Write-Host ''
    Start-Process "http://localhost:$($cfg.Port)/"
    $args = @('-ssh', '-N', '-batch') + $script:auth +
            @('-L', "$($cfg.Port):127.0.0.1:$($cfg.Port)", "$($cfg.User)@$($cfg.Host)")
    & plink @args
    Wait-Key
}

function Show-Logs {
    if (-not (Initialize-Auth)) { Wait-Key; return }
    Write-Host ''
    Write-Host 'log สดของ worker - Ctrl+C เพื่อออก'
    Write-Host ''
    Invoke-Ssh 'journalctl -u lfr-worker -f -n 40 -o cat' -Interactive
    Wait-Key
}

function Switch-Mode {
    if (-not (Initialize-Auth)) { Wait-Key; return }
    $path = "/opt/line-first-response/config/bots/$($cfg.Bot).json"
    Write-Host ''
    Write-Host 'โหมดตอนนี้: ' -NoNewline
    Write-Host ((Invoke-Ssh "grep -o '\`"dryRun\`"[^,]*' $path" | Out-String).Trim())
    Write-Host ''
    Write-Host '  [d] DRY RUN - รับและจับคู่กฎครบ แต่ไม่โพสต์จริง'
    Write-Host '  [l] LIVE    - บอทจะโพสต์ลงห้องจริง' -ForegroundColor Yellow
    Write-Host ''
    $pick = Read-Host 'เลือก (d/l)'
    $want = switch ($pick) { 'd' { 'true' } 'l' { 'false' } default { $null } }
    if (-not $want) { return }

    if ($want -eq 'false') {
        Write-Host ''
        Write-Host 'ยืนยัน: บอทจะโพสต์ข้อความลงห้องจริง' -ForegroundColor Yellow
        if ((Read-Host "พิมพ์ LIVE เพื่อยืนยัน") -cne 'LIVE') {
            Write-Host 'ยกเลิก'
            Wait-Key
            return
        }
    }

    $sed = "sed -i 's/\`"dryRun\`": *[a-z]*/\`"dryRun\`": $want/' $path"
    Invoke-Ssh "$sed && systemctl restart lfr-worker && sleep 15 && systemctl is-active lfr-worker && grep -o '\`"dryRun\`"[^,]*' $path"
    Wait-Key
}

function Show-Status {
    if (-not (Initialize-Auth)) { Wait-Key; return }
    Write-Host ''
    Invoke-Ssh 'echo "service: $(systemctl is-active lfr-worker)"; curl -s http://127.0.0.1:8791/api/health; echo; echo; curl -s http://127.0.0.1:8791/api/alerts'
    Wait-Key
}

function Invoke-Bench {
    if (-not (Initialize-Auth)) { Wait-Key; return }
    Write-Host ''
    Write-Host 'วัด send RTT บน server - ส่งหาตัวเอง 10 ครั้ง'
    Invoke-Ssh "cd /opt/line-first-response && PATH=`$HOME/.deno/bin:`$PATH deno task bench --bot-id $($cfg.Bot) --count 10 --interval-ms 1500 --warm-seconds 5 --lanes 2"
    Wait-Key
}

function Invoke-DenoTask([string]$task) {
    if (-not (Test-Tool 'deno' 'ติดตั้ง: irm https://deno.land/install.ps1 | iex')) { Wait-Key; return }
    Write-Host ''
    Push-Location $root
    try { & deno task $task } finally { Pop-Location }
    Wait-Key
}

function Set-Worker([string]$verb) {
    if (-not (Initialize-Auth)) { Wait-Key; return }
    Invoke-Ssh "systemctl $verb lfr-worker; sleep 5; systemctl is-active lfr-worker || echo inactive"
    Wait-Key
}

# --- menu -----------------------------------------------------------
while ($true) {
    # Clear-Host throws when there is no console handle (piped/redirected).
    try { Clear-Host } catch { Write-Host '' }
    Write-Host '=========================================================='
    Write-Host "  line-first-response      $($cfg.User)@$($cfg.Host)"
    Write-Host '=========================================================='
    Write-Host ''
    Write-Host '  [1]  เปิด dashboard แบบ public (nginx + password)' -ForegroundColor Cyan
    Write-Host "       เปิด http://$($cfg.Host)/ ตรง ๆ ไม่ต้องต่อ tunnel"
    Write-Host ''
    Write-Host '  [t]  เปิด dashboard ผ่าน SSH tunnel  (ไม่ต้องพึ่ง nginx)'
    Write-Host ''
    Write-Host '  [2]  ดู log สด ๆ ของ worker'
    Write-Host '  [3]  สลับโหมด  DRY RUN <-> LIVE'
    Write-Host '  [4]  สถานะ worker + alert'
    Write-Host ''
    Write-Host '  [5]  วัด send RTT (bench) บน server'
    Write-Host '  [6]  รัน gate บนเครื่องนี้'
    Write-Host '  [7]  รัน acceptance บนเครื่องนี้'
    Write-Host ''
    Write-Host '  [8]  เริ่ม worker          [9]  หยุด worker'
    Write-Host ''
    Write-Host '  [0]  ออก'
    Write-Host ''
    switch (Read-Host 'เลือก') {
        '1' { Open-PublicDashboard }
        't' { Open-Dashboard }
        '2' { Show-Logs }
        '3' { Switch-Mode }
        '4' { Show-Status }
        '5' { Invoke-Bench }
        '6' { Invoke-DenoTask 'gate' }
        '7' { Invoke-DenoTask 'acceptance' }
        '8' { Set-Worker 'start' }
        '9' { Set-Worker 'stop' }
        '0' { exit 0 }
    }
}
