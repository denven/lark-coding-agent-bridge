param(
    [Parameter(Mandatory = $true)]
    [string]$SessionId,

    [string]$CodexHome = "$HOME\.codex-cli-thirdparty",

    [int]$PollMilliseconds = 500,

    [int]$HistoryTail = 3000
)

$ErrorActionPreference = "Stop"


# ============================================================
# Paths
# ============================================================

$monitorHome = "$HOME\.codex-monitor"

New-Item `
    -Path $monitorHome `
    -ItemType Directory `
    -Force | Out-Null

$statusFile = Join-Path `
    $monitorHome `
    "status-$SessionId.json"


# ============================================================
# Find rollout file
# ============================================================

Write-Host ""
Write-Host "Searching rollout for session: $SessionId" `
    -ForegroundColor Cyan

$sessionRoot = Join-Path $CodexHome "sessions"

if (-not (Test-Path $sessionRoot)) {
    throw "Codex sessions directory does not exist: $sessionRoot"
}

$rollout = Get-ChildItem `
    $sessionRoot `
    -Recurse `
    -Filter "*$SessionId*.jsonl" `
    -File `
    -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $rollout) {
    throw @"
Cannot find rollout JSONL for session:

$SessionId

under:

$sessionRoot
"@
}

Write-Host "Rollout: $($rollout.FullName)" `
    -ForegroundColor DarkGray


# ============================================================
# Runtime state
# ============================================================

$state = [ordered]@{
    version             = 1

    sessionId           = $SessionId
    cwd                 = $null
    rolloutPath         = $rollout.FullName

    state               = "Unknown"
    lastActivity        = "Observer started"
    lastEventType       = $null
    lastEventTime       = $null

    observerPid         = $PID
    observerState       = "Running"
    observerUpdatedAt   = (Get-Date).ToString("o")
}


# ============================================================
# Helper: Write status JSON atomically
# ============================================================

function Write-MonitorStatus {
    param(
        [Parameter(Mandatory)]
        [System.Collections.IDictionary]$Data
    )

    $Data.observerUpdatedAt = (Get-Date).ToString("o")

    $tmpFile = "$statusFile.tmp"

    $json = $Data |
        ConvertTo-Json -Depth 20

    Set-Content `
        -Path $tmpFile `
        -Value $json `
        -Encoding UTF8

    Move-Item `
        -Path $tmpFile `
        -Destination $statusFile `
        -Force
}


# ============================================================
# Helper: Shorten long text
# ============================================================

function Shorten-Text {
    param(
        [object]$Text,

        [int]$Length = 180
    )

    if ($null -eq $Text) {
        return $null
    }

    $value = [string]$Text

    $value = $value `
        -replace "[`r`n`t]+", " "

    $value = $value.Trim()

    if ($value.Length -gt $Length) {
        return (
            $value.Substring(0, $Length) +
            "..."
        )
    }

    return $value
}


# ============================================================
# Helper: Console event output
# ============================================================

function Write-Activity {
    param(
        [string]$Category,

        [string]$Message,

        [ConsoleColor]$Color = "Gray"
    )

    $time = Get-Date -Format "HH:mm:ss"

    $categoryText = $Category.PadRight(10)

    Write-Host `
        "[$time] $categoryText $Message" `
        -ForegroundColor $Color
}


# ============================================================
# Helper: Extract useful tool name/details
# ============================================================

function Get-ToolDescription {
    param(
        [object]$Payload,

        [string]$FallbackType
    )

    $toolName = $null

    if ($Payload.name) {
        $toolName = [string]$Payload.name
    }
    elseif ($Payload.tool_name) {
        $toolName = [string]$Payload.tool_name
    }
    else {
        $toolName = $FallbackType
    }

    $details = $null

    if ($Payload.arguments) {
        $details = Shorten-Text `
            $Payload.arguments `
            120
    }
    elseif ($Payload.input) {
        $details = Shorten-Text `
            $Payload.input `
            120
    }

    if ($details) {
        return "$toolName -- $details"
    }

    return $toolName
}


# ============================================================
# Process one rollout JSONL event
#
# -Silent is used during initial history reconstruction.
# That prevents old events from flooding the terminal.
# ============================================================

function Process-RolloutEvent {
    param(
        [Parameter(Mandatory)]
        [string]$Line,

        [switch]$Silent
    )

    if ([string]::IsNullOrWhiteSpace($Line)) {
        return
    }

    try {
        $event = $Line |
            ConvertFrom-Json
    }
    catch {
        # Ignore partial or unknown JSON lines.
        return
    }


    # --------------------------------------------------------
    # Common metadata
    # --------------------------------------------------------

    if ($event.timestamp) {
        $state.lastEventTime =
            [string]$event.timestamp
    }

    if ($event.type) {
        $state.lastEventType =
            [string]$event.type
    }


    # --------------------------------------------------------
    # Session metadata
    # --------------------------------------------------------

    if ($event.type -eq "session_meta") {

        if ($event.payload.cwd) {
            $state.cwd =
                [string]$event.payload.cwd
        }

        return
    }


    # --------------------------------------------------------
    # High-level Codex events
    # --------------------------------------------------------

    if ($event.type -eq "event_msg") {

        $eventType =
            [string]$event.payload.type


        switch -Regex ($eventType) {


            # ------------------------------------------------
            # Task started
            # ------------------------------------------------

            "^task_started$" {

                $state.state =
                    "Running"

                $state.lastActivity =
                    "Task started"

                Write-MonitorStatus $state

                if (-not $Silent) {
                    Write-Activity `
                        "RUNNING" `
                        "Task started" `
                        Cyan
                }

                return
            }


            # ------------------------------------------------
            # Task completed / waiting for next prompt
            # ------------------------------------------------

            "^(task_complete|turn_complete|turn_completed)$" {

                $state.state =
                    "Waiting"

                $state.lastActivity =
                    "Task completed; waiting for input"

                Write-MonitorStatus $state

                if (-not $Silent) {
                    Write-Activity `
                        "WAITING" `
                        "Task completed; waiting for input" `
                        Green
                }

                return
            }


            # ------------------------------------------------
            # Error / abort / interrupt
            # ------------------------------------------------

            "abort|interrupt|cancel|error|fail" {

                $state.state =
                    "Interrupted"

                $state.lastActivity =
                    "Session event: $eventType"

                Write-MonitorStatus $state

                if (-not $Silent) {
                    Write-Activity `
                        "INTERRUPT" `
                        $eventType `
                        Red
                }

                return
            }


            # ------------------------------------------------
            # User prompt
            # ------------------------------------------------

            "^user_message$" {

                $state.state =
                    "Running"

                $message =
                    Shorten-Text `
                        $event.payload.message `
                        160

                if ($message) {
                    $state.lastActivity =
                        "User: $message"
                }
                else {
                    $state.lastActivity =
                        "User message"
                }

                Write-MonitorStatus $state

                if (-not $Silent) {
                    Write-Activity `
                        "PROMPT" `
                        $state.lastActivity `
                        White
                }

                return
            }


            # ------------------------------------------------
            # Item started
            # ------------------------------------------------

            "^item_started$" {

                $state.state =
                    "Running"

                $itemType = $null

                if ($event.payload.item.type) {
                    $itemType =
                        [string]$event.payload.item.type
                }

                if ($itemType) {
                    $state.lastActivity =
                        "Started: $itemType"
                }
                else {
                    $state.lastActivity =
                        "Codex item started"

                    $itemType =
                        "item"
                }

                Write-MonitorStatus $state

                if (-not $Silent) {
                    Write-Activity `
                        "START" `
                        $itemType `
                        DarkCyan
                }

                return
            }


            # ------------------------------------------------
            # Item completed
            # ------------------------------------------------

            "^item_completed$" {

                $state.state =
                    "Running"

                $itemType = $null

                if ($event.payload.item.type) {
                    $itemType =
                        [string]$event.payload.item.type
                }

                if ($itemType) {
                    $state.lastActivity =
                        "Completed: $itemType"
                }
                else {
                    $state.lastActivity =
                        "Codex item completed"

                    $itemType =
                        "item"
                }

                Write-MonitorStatus $state

                if (-not $Silent) {
                    Write-Activity `
                        "COMPLETE" `
                        $itemType `
                        DarkGreen
                }

                return
            }
        }
    }


    # --------------------------------------------------------
    # Model / reasoning / tool activity
    # --------------------------------------------------------

    if ($event.type -eq "response_item") {

        $responseType =
            [string]$event.payload.type


        switch -Regex ($responseType) {


            # ------------------------------------------------
            # Reasoning
            # ------------------------------------------------

            "^reasoning$" {

                $state.state =
                    "Running"

                $state.lastActivity =
                    "Reasoning"

                Write-MonitorStatus $state

                if (-not $Silent) {
                    Write-Activity `
                        "REASONING" `
                        "Model reasoning" `
                        DarkGray
                }

                return
            }


            # ------------------------------------------------
            # Tool call
            # ------------------------------------------------

            "function_call|custom_tool_call|tool_call" {

                $state.state =
                    "Running"

                $toolDescription =
                    Get-ToolDescription `
                        $event.payload `
                        $responseType

                $state.lastActivity =
                    "Tool: $toolDescription"

                Write-MonitorStatus $state

                if (-not $Silent) {
                    Write-Activity `
                        "TOOL" `
                        $toolDescription `
                        Yellow
                }

                return
            }


            # ------------------------------------------------
            # Tool output
            # ------------------------------------------------

            "function_call_output|tool_output|custom_tool_output" {

                $state.state =
                    "Running"

                $state.lastActivity =
                    "Tool completed"

                Write-MonitorStatus $state

                if (-not $Silent) {
                    Write-Activity `
                        "TOOL DONE" `
                        "Tool returned output" `
                        DarkYellow
                }

                return
            }


            # ------------------------------------------------
            # Assistant response
            # ------------------------------------------------

            "^message$" {

                if (
                    $event.payload.role -eq
                    "assistant"
                ) {

                    $state.lastActivity =
                        "Assistant response generated"

                    Write-MonitorStatus $state

                    if (-not $Silent) {
                        Write-Activity `
                            "ASSISTANT" `
                            "Response generated" `
                            Cyan
                    }
                }

                return
            }
        }
    }
}


# ============================================================
# Read session metadata from beginning of rollout
#
# session_meta normally appears near the beginning, so don't
# depend on it still being in the last N lines.
# ============================================================

Write-Host ""
Write-Host "Reading Session metadata..." `
    -ForegroundColor Cyan

$metadataLines = Get-Content `
    $rollout.FullName `
    -TotalCount 50

foreach ($line in $metadataLines) {

    try {
        $meta =
            $line |
            ConvertFrom-Json
    }
    catch {
        continue
    }

    if ($meta.type -eq "session_meta") {

        if ($meta.payload.cwd) {
            $state.cwd =
                [string]$meta.payload.cwd
        }

        break
    }
}


# ============================================================
# Reconstruct current state from recent history
#
# Silent mode means this updates state without printing old
# task/tool activity into the observer window.
# ============================================================

Write-Host "Reconstructing current Session state..." `
    -ForegroundColor Cyan

$history = Get-Content `
    $rollout.FullName `
    -Tail $HistoryTail

foreach ($line in $history) {
    Process-RolloutEvent `
        -Line $line `
        -Silent
}


Write-MonitorStatus $state


# ============================================================
# Show attached status
# ============================================================

Write-Host ""
Write-Host "Observer attached." `
    -ForegroundColor Green

Write-Host ""
Write-Host "Session  : $SessionId"

if ($state.cwd) {
    Write-Host "CWD      : $($state.cwd)"
}
else {
    Write-Host "CWD      : <unknown>" `
        -ForegroundColor Yellow
}

Write-Host "State    : $($state.state)"
Write-Host "Activity : $($state.lastActivity)"
Write-Host "Status   : $statusFile"

Write-Host ""
Write-Host `
    "Watching live Codex activity..." `
    -ForegroundColor Cyan

Write-Host `
    "Press Ctrl+C to stop ONLY the observer." `
    -ForegroundColor DarkGray

Write-Host ""


# ============================================================
# Open rollout file read-only
#
# FileShare.ReadWrite is critical:
# Codex keeps writing the rollout while we read it.
# ============================================================

$fileStream = $null
$reader     = $null

try {

    $fileStream =
        [System.IO.File]::Open(
            $rollout.FullName,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::ReadWrite
        )


    # Start at EOF.
    # Historical state was already reconstructed above.
    $fileStream.Seek(
        0,
        [System.IO.SeekOrigin]::End
    ) | Out-Null


    $reader =
        New-Object `
            System.IO.StreamReader(
                $fileStream
            )


    $lastHeartbeat =
        Get-Date


    # ========================================================
    # Live follow loop
    # ========================================================

    while ($true) {

        $line =
            $reader.ReadLine()


        if ($null -ne $line) {

            Process-RolloutEvent `
                -Line $line

            continue
        }


        Start-Sleep `
            -Milliseconds $PollMilliseconds


        # ----------------------------------------------------
        # Observer heartbeat every 5 seconds
        # ----------------------------------------------------

        $now = Get-Date

        if (
            ($now - $lastHeartbeat).
            TotalSeconds -ge 5
        ) {

            Write-MonitorStatus $state

            $lastHeartbeat =
                $now
        }
    }
}
finally {

    # --------------------------------------------------------
    # Mark observer itself stopped.
    #
    # This does NOT mean the Codex Session exited.
    # --------------------------------------------------------

    $state.observerState =
        "Stopped"

    try {
        Write-MonitorStatus $state
    }
    catch {
        # Ignore status-write failures during shutdown.
    }


    if ($reader) {
        $reader.Dispose()
    }


    if ($fileStream) {
        $fileStream.Dispose()
    }


    Write-Host ""
    Write-Host `
        "Observer stopped. Codex Session was NOT modified." `
        -ForegroundColor Yellow
}