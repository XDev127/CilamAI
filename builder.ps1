#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet("dev:nsis", "dist:nsis", "dist:portable", "dist:dir", "dist", "build")]
    [string]$Target = "dev:nsis"
)

$ErrorActionPreference = "Stop"

$root    = $PSScriptRoot
$logsDir = Join-Path $root "logs"
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir | Out-Null
}

$stamp   = Get-Date -Format "yyyyMMdd-HHmmss"
$logFile = Join-Path $logsDir "builder-$stamp-$Target.log"

function Write-Log([string]$Message, [string]$Color = "Gray") {
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss.fff"), $Message
    Write-Host $line -ForegroundColor $Color
    Add-Content -Path $logFile -Value $line
}

Push-Location $root
try {
    $pkgPath = Join-Path $root "package.json"
    $scripts = (Get-Content $pkgPath -Raw | ConvertFrom-Json).scripts.PSObject.Properties.Name
    if ($scripts -notcontains $Target) {
        Write-Log ("[!] Unknown npm script '{0}'. Available: {1}" -f $Target, ($scripts -join ", ")) "Red"
        exit 1
    }

    Write-Log "[*] Starting Building..." "Cyan"
    Write-Log ("[i] Command: npm run {0}" -f $Target)
    Start-Sleep -Seconds 3
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        npm run $Target 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message }
            else { "$_" }
        } | Tee-Object -FilePath $logFile -Append

        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prevEap
    }
    $sw.Stop()
    $duration = $sw.Elapsed.TotalSeconds

    Write-Log "------------------------------------------------------------"
    Write-Log ("[i] Duration : {0:N1}s" -f $duration)
    Write-Log ("[i] Exit code: {0}" -f $exitCode)
    Write-Log ("[i] Finished : {0}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"))
    Write-Log "------------------------------------------------------------"

    if ($exitCode -eq 0) {
        Write-Log "[+] Build succeeded. Log: $logFile" "Green"
    }
    else {
        Write-Log ("[!] ERROR: Build failed (exit {0}). Full log: {1}" -f $exitCode, $logFile) "Red"
    }
    exit $exitCode
}
catch {
    $msg = "[{0}] [!] ERROR: {1}" -f (Get-Date -Format "HH:mm:ss.fff"), $_.Exception.Message
    Write-Host $msg -ForegroundColor Red
    try {
        Add-Content -Path $logFile -Value $msg
    } catch { }
    exit 1
}
finally {
    Pop-Location
}
