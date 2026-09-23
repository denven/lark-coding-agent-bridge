param(
    [Parameter(Mandatory = $true)]
    [string]$SessionId,

    [string]$ClaudeHome =
        "$HOME\.claude",

    [int]$GraceSeconds = 10,

    # Run every validation but stop short of terminating.
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"


# ============================================================
# Request-ClaudeRelease.ps1
#
# Release the Windows writer of one Claude Code Session so a
# Lark scope can take it over.
#
# Claude Code needs no Observer: every live `claude` process
# records itself in
#
#   $ClaudeHome\sessions\<pid>.json
#
# with sessionId, status, entrypoint and procStart (the
# process creation time as a Windows FILETIME). That one file
# plays the role of Codex's status-*.json heartbeat AND its
# launches\*.json PID mapping, so validation and termination
# live in this single script.
#
# Output protocol (same shape as Request-CodexRelease.ps1):
#
#   OK|RELEASED|<SessionId>|<WriterPid>
#   ERROR|<CODE>|<SessionId>|...
#
# Termination is refused unless ALL of these hold:
#
#   - exactly one live registry entry claims the Session
#   - entrypoint is "cli"  (a terminal window, never an
#     SDK / `claude -p` run such as the Lark bridge's own)
#   - status is "idle"     (never interrupt a working turn)
#   - procStart matches the live process's creation time
#     (the PID has not been reused)
#   - the process image is claude.exe
#
# NOTE: $pid is PowerShell's automatic, read-only $PID.
# The writer's process id is therefore held in $writerPid.
# ============================================================


function Read-JsonFile {

    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    try {

        $utf8 =
            New-Object `
                System.Text.UTF8Encoding($false)

        $raw =
            [System.IO.File]::ReadAllText(
                $Path,
                $utf8
            ).TrimStart(
                [char]0xFEFF
            )

        if ([string]::IsNullOrWhiteSpace($raw)) {
            return $null
        }

        return (
            $raw |
            ConvertFrom-Json
        )
    }
    catch {

        return $null
    }
}


function Get-LiveProcess {

    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    return (
        Get-Process `
            -Id $ProcessId `
            -ErrorAction SilentlyContinue
    )
}


# ============================================================
# 1. Validate input
#
# The bridge always passes the exact full Session ID; a
# prefix or thread name here would be a caller bug.
# ============================================================

$SessionId =
    $SessionId.Trim()

if (
    $SessionId -notmatch
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
) {

    Write-Output (
        "ERROR|INVALID_SESSION_ID|" +
        $SessionId
    )

    exit 9
}


$registryDir =
    Join-Path `
        $ClaudeHome `
        "sessions"


# ============================================================
# 2. Find live registry entries for this Session
# ============================================================

$candidates =
    @()

if (Test-Path -LiteralPath $registryDir) {

    foreach (
        $file in Get-ChildItem `
            -LiteralPath $registryDir `
            -Filter "*.json" `
            -File
    ) {

        $entry =
            Read-JsonFile `
                -Path $file.FullName

        if (-not $entry) {
            continue
        }

        if ($entry.sessionId -ne $SessionId) {
            continue
        }

        # A hard-killed process leaves its file behind; only
        # entries whose PID is still running are writers.
        if (-not (Get-LiveProcess -ProcessId ([int]$entry.pid))) {
            continue
        }

        $candidates +=
            [pscustomobject]@{
                Path  = $file.FullName
                Entry = $entry
            }
    }
}


if ($candidates.Count -eq 0) {

    Write-Output (
        "ERROR|SESSION_NOT_ACTIVE|" +
        $SessionId
    )

    exit 12
}


if ($candidates.Count -gt 1) {

    $pids =
        (
            $candidates |
            ForEach-Object { $_.Entry.pid }
        ) -join ","

    Write-Output (
        "ERROR|AMBIGUOUS_WRITER|" +
        "$SessionId|" +
        $pids
    )

    exit 11
}


$registryPath =
    $candidates[0].Path

$entry =
    $candidates[0].Entry

$writerPid =
    [int]$entry.pid


# ============================================================
# 3. Only terminal sessions may be terminated
#
# `claude -p` (the Lark bridge's own runs) registers with
# entrypoint "sdk-cli". IDE integrations use other values.
# Neither is ours to kill.
# ============================================================

if ($entry.entrypoint -ne "cli") {

    Write-Output (
        "ERROR|UNSUPPORTED_ENTRYPOINT|" +
        "$SessionId|" +
        "$writerPid|" +
        $entry.entrypoint
    )

    exit 17
}


# ============================================================
# 4. Never interrupt a working turn
# ============================================================

if ($entry.status -ne "idle") {

    Write-Output (
        "ERROR|SESSION_NOT_IDLE|" +
        "$SessionId|" +
        "$writerPid|" +
        $entry.status
    )

    exit 13
}


# ============================================================
# 5. Verify process identity
# ============================================================

if ([string]::IsNullOrWhiteSpace([string]$entry.procStart)) {

    Write-Output (
        "ERROR|PROCESS_IDENTITY_UNAVAILABLE|" +
        "$SessionId|" +
        $writerPid
    )

    exit 18
}


$process =
    Get-LiveProcess `
        -ProcessId $writerPid

if (-not $process) {

    Write-Output (
        "ERROR|WRITER_NOT_RUNNING|" +
        "$SessionId|" +
        $writerPid
    )

    exit 12
}


try {

    $actualStart =
        [string]$process.StartTime.ToFileTimeUtc()
}
catch {

    Write-Output (
        "ERROR|ACCESS_DENIED|" +
        "$SessionId|" +
        "$writerPid|" +
        $_.Exception.Message
    )

    exit 21
}


if ($actualStart -ne [string]$entry.procStart) {

    Write-Output (
        "ERROR|PID_REUSED|" +
        "$SessionId|" +
        "$writerPid|" +
        "expected=$($entry.procStart)|" +
        "actual=$actualStart"
    )

    exit 19
}


if ($process.ProcessName -ne "claude") {

    Write-Output (
        "ERROR|NOT_CLAUDE_PROCESS|" +
        "$SessionId|" +
        "$writerPid|" +
        $process.ProcessName
    )

    exit 20
}


# ============================================================
# 6. Re-check status immediately before terminating
#
# Narrows the window in which the user starts a new turn in
# the Windows terminal between step 4 and termination.
# ============================================================

$latest =
    Read-JsonFile `
        -Path $registryPath

if (
    -not $latest -or
    $latest.sessionId -ne $SessionId -or
    $latest.status -ne "idle"
) {

    $latestStatus =
        if ($latest) { $latest.status } else { "missing" }

    Write-Output (
        "ERROR|SESSION_NOT_IDLE|" +
        "$SessionId|" +
        "$writerPid|" +
        $latestStatus
    )

    exit 13
}


if ($DryRun) {

    Write-Output (
        "OK|DRY_RUN|" +
        "$SessionId|" +
        $writerPid
    )

    exit 0
}


# ============================================================
# 7. Terminate
#
# taskkill /T also ends claude.exe's descendants (MCP
# servers, shells). The parent PowerShell terminal is NOT
# a descendant and stays open.
#
# The transcript is append-only and the Session is idle, so
# the conversation is intact; only an unsent draft in the
# terminal prompt is lost.
# ============================================================

$taskkillPath =
    Join-Path `
        $env:SystemRoot `
        "System32\taskkill.exe"

if (-not (Test-Path -LiteralPath $taskkillPath)) {

    Write-Output (
        "ERROR|TASKKILL_NOT_FOUND|" +
        $SessionId
    )

    exit 27
}


$taskkillOutput =
    & $taskkillPath `
        /PID $writerPid `
        /T `
        /F 2>&1

$taskkillExitCode =
    $LASTEXITCODE


# ============================================================
# 8. Verify the writer actually exited
# ============================================================

$deadline =
    (Get-Date).AddSeconds(
        $GraceSeconds
    )

while (
    (Get-Date) -lt $deadline -and
    (Get-LiveProcess -ProcessId $writerPid)
) {

    Start-Sleep `
        -Milliseconds 200
}


if (Get-LiveProcess -ProcessId $writerPid) {

    $taskkillText =
        (
            $taskkillOutput |
            Out-String
        ).Trim()

    Write-Output (
        "ERROR|TERMINATION_FAILED|" +
        "$SessionId|" +
        "$writerPid|" +
        "$taskkillExitCode|" +
        $taskkillText
    )

    exit 28
}


# ============================================================
# 9. Remove the registry files the killed process left
#
# A clean exit removes them; a forced one cannot. Leaving the
# file risks a later, unrelated process inheriting the PID
# and being mistaken for this Session's writer.
#
# Only files that still describe THIS process are removed.
# ============================================================

$stale =
    Read-JsonFile `
        -Path $registryPath

if (
    $stale -and
    $stale.sessionId -eq $SessionId -and
    [string]$stale.procStart -eq [string]$entry.procStart
) {

    Remove-Item `
        -LiteralPath $registryPath `
        -Force `
        -ErrorAction SilentlyContinue

    Get-ChildItem `
        -LiteralPath $registryDir `
        -Filter "$writerPid.*.key" `
        -File `
        -ErrorAction SilentlyContinue |
        Remove-Item `
            -Force `
            -ErrorAction SilentlyContinue
}


# ============================================================
# Success
# ============================================================

Write-Output (
    "OK|RELEASED|" +
    "$SessionId|" +
    $writerPid
)

exit 0
