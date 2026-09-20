param(
    [Parameter(Mandatory = $true)]
    [string]$SessionPrefix,

    [string]$MonitorHome =
        "$HOME\.codex-monitor",

    [int]$MaxHeartbeatAgeSeconds = 20,

    [int]$GraceSeconds = 5
)

$ErrorActionPreference = "Stop"


# ============================================================
# Helpers
# ============================================================

function Read-JsonFile {

    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $raw =
        [System.IO.File]::ReadAllText(
            $Path
        )

    $raw =
        $raw.TrimStart(
            [char]0xFEFF
        )

    return (
        $raw |
        ConvertFrom-Json
    )
}


function Get-ProcessCim {

    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    return (
        Get-CimInstance `
            Win32_Process `
            -Filter "ProcessId=$ProcessId" `
            -ErrorAction SilentlyContinue
    )
}


function Get-ProcessCreationUtc {

    param(
        [Parameter(Mandatory = $true)]
        [object]$Process
    )

    if (-not $Process) {
        return $null
    }

    $value =
        $Process.CreationDate

    try {

        if ($value -is [datetime]) {

            return (
                ([datetime]$value).
                ToUniversalTime()
            )
        }

        return (
            [Management.ManagementDateTimeConverter]::
            ToDateTime(
                [string]$value
            ).
            ToUniversalTime()
        )
    }
    catch {

        return $null
    }
}


# ============================================================
# 1. Locate monitor status by Session prefix
# ============================================================

$statusFiles =
    Get-ChildItem `
        $MonitorHome `
        -Filter "status-*.json" `
        -File `
        -ErrorAction SilentlyContinue


$matches =
    @(
        $statusFiles |
        Where-Object {

            $sessionPart =
                $_.BaseName.Substring(7)

            $sessionPart.StartsWith(
                $SessionPrefix,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        }
    )


if ($matches.Count -eq 0) {

    Write-Output (
        "ERROR|SESSION_NOT_FOUND|" +
        $SessionPrefix
    )

    exit 10
}


if ($matches.Count -gt 1) {

    Write-Output (
        "ERROR|AMBIGUOUS_SESSION|" +
        $SessionPrefix
    )

    exit 11
}


$statusFile =
    $matches[0]


try {

    $status =
        Read-JsonFile `
            -Path $statusFile.FullName

}
catch {

    Write-Output (
        "ERROR|STATUS_READ_FAILED|" +
        $SessionPrefix
    )

    exit 12
}


$sessionId =
    [string]$status.sessionId


# ============================================================
# 2. Safety: only Waiting Sessions can be released
# ============================================================

if ($status.state -ne "Waiting") {

    Write-Output (
        "ERROR|SESSION_NOT_WAITING|" +
        "$sessionId|" +
        "$($status.state)"
    )

    exit 13
}


# ============================================================
# 3. Safety: Observer must still be healthy
# ============================================================

if (
    $status.observerState -ne
    "Running"
) {

    Write-Output (
        "ERROR|OBSERVER_NOT_RUNNING|" +
        $sessionId
    )

    exit 14
}


if (-not $status.observerUpdatedAt) {

    Write-Output (
        "ERROR|INVALID_HEARTBEAT|" +
        $sessionId
    )

    exit 15
}


try {

    $heartbeat =
        [datetimeoffset]::Parse(
            [string]$status.observerUpdatedAt
        )

}
catch {

    Write-Output (
        "ERROR|INVALID_HEARTBEAT|" +
        $sessionId
    )

    exit 15
}


$heartbeatAge =
    (
        [datetimeoffset]::Now -
        $heartbeat
    ).TotalSeconds


if (
    $heartbeatAge -gt
    $MaxHeartbeatAgeSeconds
) {

    Write-Output (
        "ERROR|STALE_OBSERVER|" +
        "$sessionId|" +
        [math]::Round(
            $heartbeatAge,
            1
        )
    )

    exit 16
}


# ============================================================
# 4. Find launch mapping for exact Session ID
# ============================================================

$launchDir =
    Join-Path `
        $MonitorHome `
        "launches"


$launchFiles =
    Get-ChildItem `
        $launchDir `
        -Filter "*.json" `
        -File `
        -ErrorAction SilentlyContinue


$launchMatches =
    @()


foreach ($file in $launchFiles) {

    try {

        $candidate =
            Read-JsonFile `
                -Path $file.FullName

        if (
            [string]$candidate.sessionId -eq
            $sessionId
        ) {

            $launchMatches +=
                [pscustomobject]@{

                    File =
                        $file

                    Launch =
                        $candidate
                }
        }

    }
    catch {
        # Ignore invalid historical launch records.
    }
}


if ($launchMatches.Count -eq 0) {

    Write-Output (
        "ERROR|LAUNCH_MAPPING_NOT_FOUND|" +
        $sessionId
    )

    exit 17
}


# If historical duplicates exist, use the newest mapping.
$launchEntry =
    $launchMatches |
    Sort-Object {
        $_.File.LastWriteTimeUtc
    } -Descending |
    Select-Object -First 1


$launch =
    $launchEntry.Launch


$ownerPowerShellPid =
    [int]$launch.ownerPowerShellPid

$codexRootPid =
    [int]$launch.codexRootPid


# ============================================================
# 5. Basic PID sanity checks
# ============================================================

if (
    $ownerPowerShellPid -le 0 -or
    $codexRootPid -le 0
) {

    Write-Output (
        "ERROR|INVALID_PID_MAPPING|" +
        "$sessionId"
    )

    exit 18
}


# Never allow the release target to be the PowerShell owner.
if (
    $ownerPowerShellPid -eq
    $codexRootPid
) {

    Write-Output (
        "ERROR|UNSAFE_PID_MAPPING|" +
        "$sessionId"
    )

    exit 19
}


# ============================================================
# 6. Validate owner PowerShell
# ============================================================

$ownerProcess =
    Get-ProcessCim `
        -ProcessId $ownerPowerShellPid


if (-not $ownerProcess) {

    Write-Output (
        "ERROR|OWNER_POWERSHELL_NOT_RUNNING|" +
        "$sessionId|" +
        "$ownerPowerShellPid"
    )

    exit 20
}


if (
    [string]$ownerProcess.Name -notmatch
    "(?i)^(powershell|pwsh)\.exe$"
) {

    Write-Output (
        "ERROR|OWNER_PID_MISMATCH|" +
        "$sessionId|" +
        "$ownerPowerShellPid|" +
        "$($ownerProcess.Name)"
    )

    exit 21
}


# ============================================================
# 7. Validate Codex root process
# ============================================================

$rootProcess =
    Get-ProcessCim `
        -ProcessId $codexRootPid


if (-not $rootProcess) {

    Write-Output (
        "ERROR|CODEX_ROOT_NOT_RUNNING|" +
        "$sessionId|" +
        "$codexRootPid"
    )

    exit 22
}


# Root must still belong to the PowerShell that launched codex3.
if (
    [int]$rootProcess.ParentProcessId -ne
    $ownerPowerShellPid
) {

    Write-Output (
        "ERROR|CODEX_PARENT_MISMATCH|" +
        "$sessionId|" +
        "$codexRootPid|" +
        "$($rootProcess.ParentProcessId)"
    )

    exit 23
}


# ============================================================
# 8. Validate that target still looks like the original Codex
#
# Expected Windows structure:
#
# powershell.exe
#   └─ node.exe        <- codexRootPid
#       └─ codex.exe
# ============================================================

$currentName =
    [string]$rootProcess.Name

$currentCommandLine =
    [string]$rootProcess.CommandLine

$recordedName =
    [string]$launch.codexRootName

$recordedCommandLine =
    [string]$launch.codexRootCommandLine


$nameIsExpected =
    $currentName -match
    "(?i)^(node|codex)\.exe$"


$nameMatchesLaunch =
    (
        [string]::IsNullOrWhiteSpace(
            $recordedName
        )
    ) -or (
        $currentName -eq
        $recordedName
    )


$currentLooksLikeCodex =
    $currentCommandLine -match
    '(?i)(@openai[\\/]+codex|codex\.js|codex\.exe)'


$recordedLooksLikeCodex =
    $recordedCommandLine -match
    '(?i)(@openai[\\/]+codex|codex\.js|codex\.exe)'


if (
    -not $nameIsExpected -or
    -not $nameMatchesLaunch -or
    (
        -not $currentLooksLikeCodex -and
        -not $recordedLooksLikeCodex
    )
) {

    Write-Output (
        "ERROR|NOT_CODEX_PROCESS|" +
        "$sessionId|" +
        "$codexRootPid|" +
        "$currentName"
    )

    exit 24
}


# ============================================================
# 9. Protect against Windows PID reuse
#
# Compare process creation time with launch mapping.
# ============================================================

if ($launch.codexRootCreatedAt) {

    try {

        $expectedCreated =
            [datetimeoffset]::Parse(
                [string]$launch.codexRootCreatedAt
            ).
            UtcDateTime


        $actualCreated =
            Get-ProcessCreationUtc `
                -Process $rootProcess


        if (-not $actualCreated) {

            Write-Output (
                "ERROR|CREATION_TIME_VALIDATION_FAILED|" +
                $sessionId
            )

            exit 25
        }


        $difference =
            [math]::Abs(
                (
                    $actualCreated -
                    $expectedCreated
                ).TotalSeconds
            )


        if ($difference -gt 2) {

            Write-Output (
                "ERROR|CODEX_PID_REUSED|" +
                "$sessionId|" +
                "$codexRootPid"
            )

            exit 26
        }

    }
    catch {

        Write-Output (
            "ERROR|CREATION_TIME_VALIDATION_FAILED|" +
            $sessionId
        )

        exit 25
    }
}


# ============================================================
# 10. Release the validated Codex process tree
#
# IMPORTANT:
#
# Target:
#   codexRootPid = node.exe
#
# taskkill /T terminates its descendants too:
#
# node.exe
#   └─ codex.exe
#
# ownerPowerShellPid is NEVER passed to taskkill.
# ============================================================

$taskkillPath =
    Join-Path `
        $env:SystemRoot `
        "System32\taskkill.exe"


if (-not (Test-Path $taskkillPath)) {

    Write-Output (
        "ERROR|TASKKILL_NOT_FOUND|" +
        $sessionId
    )

    exit 27
}


$taskkillOutput =
    & $taskkillPath `
        /PID $codexRootPid `
        /T `
        /F 2>&1


$taskkillExitCode =
    $LASTEXITCODE


# ============================================================
# 11. Verify Codex root actually terminated
# ============================================================

$deadline =
    (Get-Date).AddSeconds(
        $GraceSeconds
    )


while ((Get-Date) -lt $deadline) {

    $rootStillAlive =
        Get-Process `
            -Id $codexRootPid `
            -ErrorAction SilentlyContinue


    if (-not $rootStillAlive) {
        break
    }


    Start-Sleep `
        -Milliseconds 200
}


$rootStillAlive =
    Get-Process `
        -Id $codexRootPid `
        -ErrorAction SilentlyContinue


if ($rootStillAlive) {

    $taskkillText =
        (
            $taskkillOutput |
            Out-String
        ).Trim()


    Write-Output (
        "ERROR|CODEX_TERMINATION_FAILED|" +
        "$sessionId|" +
        "$codexRootPid|" +
        "$taskkillExitCode|" +
        "$taskkillText"
    )

    exit 28
}


# ============================================================
# 12. Allow codex3 finally block to run
#
# & codex @args returns after node.exe/codex.exe terminate.
#
# codex3 finally then:
#
# - stops this Session's Observer
# - marks status Exited / Stopped
# - restores environment
#
# PowerShell Terminal remains alive.
# ============================================================

Start-Sleep `
    -Milliseconds 800


# ============================================================
# Success
# ============================================================

Write-Output (
    "OK|RELEASED|" +
    "$sessionId|" +
    "$codexRootPid|" +
    "$ownerPowerShellPid"
)

exit 0