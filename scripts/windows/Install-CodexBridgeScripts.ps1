param(
    [string]$Destination =
        "$HOME\Scripts"
)

$ErrorActionPreference = "Stop"

$sourceDir =
    $PSScriptRoot

$files = @(
    "Attach-CodexObserver.ps1",
    "Watch-CodexSession.ps1",
    "Watch-CodexRelease.ps1",
    "Request-CodexRelease.ps1",
    "Release-CodexSession.ps1",
    "Stop-CodexObserver.ps1"
)

New-Item `
    -ItemType Directory `
    -Path $Destination `
    -Force |
    Out-Null

foreach ($file in $files) {

    $source =
        Join-Path `
            $sourceDir `
            $file

    $target =
        Join-Path `
            $Destination `
            $file

    if (-not (Test-Path $source)) {

        throw (
            "Source script not found: " +
            $source
        )
    }

    Copy-Item `
        -Path $source `
        -Destination $target `
        -Force

    Write-Host (
        "Installed: " +
        $file
    ) -ForegroundColor Green
}

Write-Host ""
Write-Host (
    "Codex bridge scripts installed to: " +
    $Destination
) -ForegroundColor Cyan