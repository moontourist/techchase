param([int]$Seconds = 15, [int]$Rounds = 2,
      [Parameter(Mandatory = $true)][string]$Iso)

$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root '.venv\Scripts\python.exe'
$gcu = Join-Path $root 'tools\gcu.py'
$dolphinDir = Join-Path $env:APPDATA 'Slippi Launcher\netplay'
$dolphin = Join-Path $dolphinDir 'Slippi Dolphin.exe'

function Wait-Pad {
    for ($i = 0; $i -lt 15; $i++) {
        & $py $gcu info *> $null
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Seconds 1
    }
    throw 'controller config interface did not come back'
}

for ($r = 0; $r -lt $Rounds; $r++) {
    foreach ($state in 'off', 'on') {
        Wait-Pad
        & $py $gcu latch $state | Out-Null
        & $py $gcu stats -r | Out-Null
        $p = Start-Process -FilePath $dolphin -WorkingDirectory $dolphinDir -ArgumentList @('-e', "`"$Iso`"") -PassThru
        Start-Sleep -Seconds $Seconds
        $null = $p.CloseMainWindow()
        if (-not $p.WaitForExit(10000)) { Stop-Process -Id $p.Id }
        Start-Sleep -Seconds 1
        Wait-Pad
        $label = if ($state -eq 'on') { 'late-latch' } else { 'stock timing' }
        Write-Output "--- $label ---"
        & $py $gcu stats
        $n = (& $py $gcu stats | Select-String 'reports').ToString()
        if ($n -match '\((\d+) reports') { Write-Output ("polls/s while Dolphin ran: ~{0:N0}" -f ([int]$Matches[1] / $Seconds)) }
    }
}
& $py $gcu latch on | Out-Null
