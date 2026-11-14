# One-step install for Windows 10/11 (PowerShell).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$py = $null
foreach ($c in @("py", "python")) {
    if (Get-Command $c -ErrorAction SilentlyContinue) {
        & $c -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" 2>$null
        if ($LASTEXITCODE -eq 0) { $py = $c; break }
    }
}
if (-not $py) {
    Write-Host "Python 3.9 or newer was not found."
    Write-Host "Install it with:  winget install Python.Python.3.12"
    Write-Host "Then open a new window and run install.bat again."
    exit 1
}

& $py -m venv .venv
if ($LASTEXITCODE -ne 0) { Write-Host "Could not create .venv"; exit 1 }
& .\.venv\Scripts\python.exe -m pip install --upgrade pip | Out-Null
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { Write-Host "pip install failed"; exit 1 }
Write-Host ""
Write-Host "Install complete. Double-click run.bat to start the dashboard."
