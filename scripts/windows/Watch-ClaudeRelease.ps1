param(
    [string]$MonitorHome =
        "$HOME\.claude-monitor",

    [string]$ReleaseScript =
        "$HOME\Scripts\Request-ClaudeRelease.ps1",

    [int]$PollMilliseconds = 300,

    [int]$HeartbeatSeconds = 2
)

$ErrorActionPreference = "Stop"


# ============================================================
# Watch-ClaudeRelease.ps1 — Claude Release Agent
#
# Why this exists
#
#   The Lark bridge runs as a LIMITED scheduled task, so it
#   cannot inspect or terminate a claude.exe started from an
#   elevated ("Run as administrator") terminal. Windows allows
#   that only from an elevated process.
#
#   Codex gets such a process for free: codex3 starts its
#   Release Agent from the elevated terminal it runs in.
#   Claude is launched directly, so this agent is started
#   separately, elevated, and serves every Claude window.
#
# Protocol (files only — no process access across privilege)
#
#   bridge  → requests\release-<id>.json   { requestId, sessionId, expiresAt }
#   agent   → results\release-<id>.json    { requestId, sessionId, exitCode, output }
#   agent   → agent.json                   heartbeat { pid, elevated, updatedAt }
#
# Scope of what a request can do
#
#   A request carries only a Session ID, validated as a UUID
#   and passed as a parameter (never interpolated into a
#   command). The agent runs Request-ClaudeRelease.ps1, which
#   terminates nothing unless the Session's writer is an idle
#   claude.exe terminal window whose process identity matches.
# ============================================================


$uuidPattern =
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

$requestDir =
    Join-Path $MonitorHome "requests"

$resultDir =
    Join-Path $MonitorHome "results"

$heartbeatPath =
    Join-Path $MonitorHome "agent.json"

$logPath =
    Join-Path $MonitorHome "agent.log"


function Write-Log {

    param([string]$Message)

    try {
        Add-Content `
            -LiteralPath $logPath `
            -Value ("{0}  {1}" -f (Get-Date).ToString("o"), $Message) `
            -Encoding UTF8
    }
    catch {
    }
}


function Write-JsonAtomic {

    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [object]$Value
    )

    # Write to a temp file and move it into place, so readers
    # never see a half-written JSON document.
    $temp =
        "$Path.$PID.tmp"

    $utf8 =
        New-Object System.Text.UTF8Encoding($false)

    [System.IO.File]::WriteAllText(
        $temp,
        ($Value | ConvertTo-Json -Depth 5),
        $utf8
    )

    Move-Item `
        -LiteralPath $temp `
        -Destination $Path `
        -Force
}


function Read-JsonFile {

    param([string]$Path)

    try {

        $utf8 =
            New-Object System.Text.UTF8Encoding($false)

        $raw =
            [System.IO.File]::ReadAllText($Path, $utf8).TrimStart([char]0xFEFF)

        if ([string]::IsNullOrWhiteSpace($raw)) {
            return $null
        }

        return ($raw | ConvertFrom-Json)
    }
    catch {

        return $null
    }
}


function Test-Elevated {

    $principal =
        New-Object Security.Principal.WindowsPrincipal(
            [Security.Principal.WindowsIdentity]::GetCurrent()
        )

    return $principal.IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator
    )
}


function Write-Heartbeat {

    Write-JsonAtomic `
        -Path $heartbeatPath `
        -Value ([ordered]@{
            version   = 1
            pid       = $PID
            elevated  = $script:elevated
            startedAt = $script:startedAt
            updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        })
}


function Complete-Request {

    param(
        [string]$RequestId,
        [string]$SessionId,
        [int]$ExitCode,
        [string]$Output
    )

    Write-JsonAtomic `
        -Path (Join-Path $resultDir "release-$RequestId.json") `
        -Value ([ordered]@{
            version     = 1
            requestId   = $RequestId
            sessionId   = $SessionId
            exitCode    = $ExitCode
            output      = $Output
            completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        })
}


function Invoke-Request {

    param([System.IO.FileInfo]$File)

    $request =
        Read-JsonFile -Path $File.FullName

    # Claim the request first so a crash mid-release can never
    # make the agent act on it twice.
    Remove-Item `
        -LiteralPath $File.FullName `
        -Force `
        -ErrorAction SilentlyContinue

    $requestId =
        [string]$request.requestId

    $sessionId =
        [string]$request.sessionId

    # requestId names the result file, so it must be safe too.
    if (
        -not $request -or
        $requestId -notmatch '^[A-Za-z0-9-]{8,64}$'
    ) {
        Write-Log "Dropped malformed request $($File.Name)"
        return
    }

    if ($sessionId -notmatch $uuidPattern) {

        Complete-Request `
            -RequestId $requestId `
            -SessionId $sessionId `
            -ExitCode 9 `
            -Output "ERROR|INVALID_SESSION_ID|$sessionId"

        return
    }

    $nowMs =
        [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    if ($request.expiresAt -and [int64]$request.expiresAt -lt $nowMs) {

        # The bridge has stopped waiting; releasing now would
        # close a window nobody is going to take over.
        Complete-Request `
            -RequestId $requestId `
            -SessionId $sessionId `
            -ExitCode 30 `
            -Output "ERROR|REQUEST_EXPIRED|$sessionId"

        Write-Log "Expired request $requestId for $sessionId"
        return
    }

    Write-Log "Releasing $sessionId (request $requestId)"

    # A separate process: the release script ends with `exit`,
    # which would otherwise terminate this agent.
    $output =
        & powershell.exe `
            -NoProfile `
            -ExecutionPolicy Bypass `
            -File $ReleaseScript `
            -SessionId $sessionId 2>&1 |
        Out-String

    $exitCode =
        $LASTEXITCODE

    Complete-Request `
        -RequestId $requestId `
        -SessionId $sessionId `
        -ExitCode $exitCode `
        -Output $output.Trim()

    Write-Log "Result for ${sessionId}: exit=$exitCode $($output.Trim())"
}


# ============================================================
# Start-up
# ============================================================

New-Item -ItemType Directory -Force -Path $requestDir, $resultDir | Out-Null

$script:elevated =
    Test-Elevated

$script:startedAt =
    [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

# One agent per machine. Launchers (profile hook, scheduled
# task) may fire repeatedly; later instances exit at once.
$mutex =
    New-Object System.Threading.Mutex($false, "Global\LarkClaudeReleaseAgent")

if (-not $mutex.WaitOne(0)) {
    exit 0
}

if (-not $script:elevated) {
    # Still useful for non-elevated Claude windows, but say so:
    # elevated ones will be refused with ACCESS_DENIED.
    Write-Log "WARNING: agent is not elevated; it cannot release elevated Claude windows."
}

if (-not (Test-Path -LiteralPath $ReleaseScript)) {
    Write-Log "FATAL: release script not found: $ReleaseScript"
    exit 1
}

Write-Log "Agent started (pid $PID, elevated=$($script:elevated))"

$lastHeartbeat =
    [DateTime]::MinValue

try {

    while ($true) {

        if (((Get-Date) - $lastHeartbeat).TotalSeconds -ge $HeartbeatSeconds) {
            Write-Heartbeat
            $lastHeartbeat = Get-Date
        }

        foreach (
            $file in Get-ChildItem `
                -LiteralPath $requestDir `
                -Filter "release-*.json" `
                -File `
                -ErrorAction SilentlyContinue
        ) {
            try {
                Invoke-Request -File $file
            }
            catch {
                Write-Log "Request $($file.Name) failed: $($_.Exception.Message)"
            }
        }

        Start-Sleep -Milliseconds $PollMilliseconds
    }
}
finally {

    Remove-Item -LiteralPath $heartbeatPath -Force -ErrorAction SilentlyContinue
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
