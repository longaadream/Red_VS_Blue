# Unlock app.asar files before electron-builder
param(
    [string]$BuildDir = "dist"
)

$ErrorActionPreference = "SilentlyContinue"

function Unlock-File {
    param([string]$Path)
    if (Test-Path $Path) {
        Write-Host "Unlocking: $Path"
        $handle = Get-Process | Where-Object {
            $_.Modules | Where-Object { $_.FileName -eq $Path }
        }
        if ($handle) {
            $handle | Stop-Process -Force
            Write-Host "  Killed $($handle.Count) process(es)"
        }
        # Also try to delete with delay retry
        for ($i = 0; $i -lt 3; $i++) {
            try {
                Remove-Item -Path $Path -Force -Recurse -ErrorAction Stop
                Write-Host "  Deleted successfully"
                return
            } catch {
                Write-Host "  Retry $i+1..."
                Start-Sleep -Seconds 2
            }
        }
    }
}

# Find and unlock all app.asar files in build directory
Get-ChildItem -Path $BuildDir -Recurse -Filter "app.asar" | ForEach-Object {
    Unlock-File -Path $_.FullName
}

# Also kill any lingering electron processes
Get-Process | Where-Object { $_.Name -match "electron|RED" } | ForEach-Object {
    Write-Host "Killing process: $($_.Name) (PID: $($_.Id))"
    Stop-Process -Id $_.Id -Force
}

Write-Host "Unlock complete!"
