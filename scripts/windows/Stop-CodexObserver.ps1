param(
    [Parameter(Mandatory = $true)]
    [string]$LaunchId
)

$ErrorActionPreference = "SilentlyContinue"

$monitorHome =
    "$HOME\.codex-monitor"

$launchFile =
    Join-Path `
        "$monitorHome\launches" `
        "$LaunchId.json"

if (-not (Test-Path $launchFile)) {
    exit 0
}

try {
    $raw =
        [System.IO.File]::ReadAllText(
            $launchFile
        )

    $raw =
        $raw.TrimStart(
            [char]0xFEFF
        )

    $launch =
        $raw |
        ConvertFrom-Json
}
catch {
    exit 0
}

$sessionId =
    [string]$launch.sessionId

$observerPid =
    [int]$launch.observerPid


# ============================================================
# Stop observer process
# ============================================================

if ($observerPid) {

    $process =
        Get-Process `
            -Id $observerPid `
            -ErrorAction SilentlyContinue

    if ($process) {
        Stop-Process `
            -Id $observerPid `
            -Force `
            -ErrorAction SilentlyContinue
    }
}


# ============================================================
# Mark local Session exited
# ============================================================

$statusFile =
    Join-Path `
        $monitorHome `
        "status-$sessionId.json"

if (Test-Path $statusFile) {

    try {
        $statusRaw =
            [System.IO.File]::ReadAllText(
                $statusFile
            )

        $statusRaw =
            $statusRaw.TrimStart(
                [char]0xFEFF
            )

        $status =
            $statusRaw |
            ConvertFrom-Json

        $status.state =
            "Exited"

        $status.lastActivity =
            "Local Codex terminal exited"

        $status.observerState =
            "Stopped"

        $status.observerUpdatedAt =
            (Get-Date).ToString("o")

        $json =
            $status |
            ConvertTo-Json -Depth 20

        $utf8 =
            New-Object System.Text.UTF8Encoding($false)

        [System.IO.File]::WriteAllText(
            $statusFile,
            $json,
            $utf8
        )
    }
    catch {
    }
}


# ============================================================
# Remove claim
# ============================================================

$claimFile =
    Join-Path `
        "$monitorHome\claims" `
        "$sessionId.claim"

Remove-Item `
    $claimFile `
    -Force `
    -ErrorAction SilentlyContinue

Remove-Item `
    $launchFile `
    -Force `
    -ErrorAction SilentlyContinue