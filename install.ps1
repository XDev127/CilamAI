param (
    [string]$Version = "latest"
)

Write-Host "[*] Starting CilamAI Desktop Installation..." -ForegroundColor Cyan

if ($Version -eq "latest") {
    Write-Host "[*] Checking for the latest version..."
    $releasesUrl = "https://api.github.com/repos/XDev127/CilamAI/releases/latest"
    try {
        $release = Invoke-RestMethod -Uri $releasesUrl -Method Get -Headers @{ "User-Agent" = "CilamAI" } -ErrorAction Stop
        $asset = $release.assets | Where-Object { $_.name -match "Setup\.exe$" } | Select-Object -First 1
        if ($asset) {
            $downloadUrl = $asset.browser_download_url
            Write-Host "[+] Found version: $($release.tag_name)" -ForegroundColor Green
        }
        else {
            throw "No Setup.exe asset found in the latest release."
        }
    }
    catch {
        Write-Host "[!] Could not resolve the latest release download URL: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}
else {
    Write-Host "[*] Using specified version: $Version"
    $downloadUrl = "https://github.com/XDev127/CilamAI/releases/download/$Version/CilamAI-Setup.exe"
}

$randomStr = -join ((48..57) + (97..122) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$installerPath = Join-Path -Path $env:TEMP -ChildPath "CilamAI-Setup-$randomStr.exe"

Write-Host "[*] Downloading installer from GitHub..."

Try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $request = [System.Net.WebRequest]::Create($downloadUrl)
    $request.UserAgent = "CilamAI"
    $response = $request.GetResponse()
    $totalSize = $response.ContentLength

    $stream = $response.GetResponseStream()
    $buffer = New-Object byte[] 8192
    $fileStream = [System.IO.File]::Create($installerPath)

    $downloaded = 0
    $lastDraw = 0

    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $fileStream.Write($buffer, 0, $read)
        $downloaded += $read

        if ($totalSize -gt 0) {
            $percent = [math]::Round(($downloaded / $totalSize) * 100)

            if ($percent -ne $lastDraw) {
                $hashes = "#" * [math]::Floor($percent / 5)
                $spaces = " " * (20 - [math]::Floor($percent / 5))

                Write-Host -NoNewline "`r[*] Download: [$hashes$spaces] $percent%"
                $lastDraw = $percent
            }
        }
    }

    $fileStream.Close()
    $stream.Close()
    $response.Close()

    Write-Host "`n[+] Download successful! Saved to $installerPath" -ForegroundColor Green

    Write-Host -NoNewline "[*] Launching the installer silently... " -ForegroundColor Cyan
    $proc = Start-Process -FilePath $installerPath `
        -ArgumentList "/SP- /SILENT /NORESTART /SUPPRESSMSGBOXES" `
        -PassThru -NoNewWindow

    $spinner = @('-', '\', '|', '/')
    $counter = 0
    while (-not $proc.HasExited) {
        Write-Host -NoNewline "`b$($spinner[$counter % 4])"
        $counter++
        Start-Sleep -Milliseconds 100
    }
    Write-Host "`b[+] Done!" -ForegroundColor Green
    Write-Host "[*] Installer exit code: $($proc.ExitCode)" -ForegroundColor Green

    Write-Host "[+] Installation process complete." -ForegroundColor Green
}
Catch {
    if ($null -ne $fileStream) { $fileStream.Close() }
    if ($null -ne $stream) { $stream.Close() }
    if ($null -ne $response) { $response.Close() }

    Write-Host "`n[!] An error occurred during the download or installation process." -ForegroundColor Red
    Write-Host "    $($_.Exception.Message)" -ForegroundColor Red
}
