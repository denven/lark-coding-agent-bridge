param(
    [Parameter(Mandatory = $true)]
    [string]$SessionId,

    [string]$CodexHome =
        "$HOME\.codex-cli-thirdparty",

    [string]$MonitorHome =
        "$HOME\.codex-monitor",

    [int]$HeartbeatSeconds = 5
)

$ErrorActionPreference = "Stop"


# ============================================================
# Paths
# ============================================================

$sessionRoot =
    Join-Path $CodexHome "sessions"

$sessionIndexPath =
    Join-Path $CodexHome "session_index.jsonl"

$logDir =
    Join-Path $MonitorHome "logs"

$statusPath =
    Join-Path `
        $MonitorHome `
        "status-$SessionId.json"

$logPath =
    Join-Path `
        $logDir `
        "observer-$SessionId.log"


New-Item `
    -ItemType Directory `
    -Path $MonitorHome `
    -Force |
    Out-Null

New-Item `
    -ItemType Directory `
    -Path $logDir `
    -Force |
    Out-Null


# ============================================================
# Helpers
# ============================================================

function Write-Log {

    param(
        [string]$Message
    )

    try {

        Add-Content `
            -Path $logPath `
            -Value (
                "$(Get-Date -Format o) $Message"
            ) `
            -Encoding UTF8

    }
    catch {
        # Logging must never stop the observer.
    }
}


function Write-JsonAtomic {

    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [object]$Value
    )

    $json =
        $Value |
        ConvertTo-Json -Depth 30

    $utf8 =
        New-Object `
            System.Text.UTF8Encoding($false)

    $tempPath =
        "$Path.$PID.tmp"

    [System.IO.File]::WriteAllText(
        $tempPath,
        $json,
        $utf8
    )

    try {

        if (Test-Path $Path) {

            [System.IO.File]::Replace(
                $tempPath,
                $Path,
                $null
            )

        }
        else {

            [System.IO.File]::Move(
                $tempPath,
                $Path
            )
        }

    }
    catch {

        Move-Item `
            -Path $tempPath `
            -Destination $Path `
            -Force
    }
}


function Get-PropertyValue {

    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }

    $property =
        $Object.PSObject.Properties[$Name]

    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}


function Get-FirstNumber {

    param(
        [object[]]$Values
    )

    foreach ($value in $Values) {

        if ($null -eq $value) {
            continue
        }

        try {
            return [long]$value
        }
        catch {
        }
    }

    return $null
}


function Get-ProjectName {

    param(
        [string]$Path
    )

    if (
        [string]::IsNullOrWhiteSpace(
            $Path
        )
    ) {
        return $null
    }

    try {

        return (
            Split-Path `
                $Path.TrimEnd(
                    "\", "/"
                ) `
                -Leaf
        )

    }
    catch {

        return $null
    }
}


function Convert-PermissionProfile {

    param(
        [object]$PermissionProfile
    )

    if ($null -eq $PermissionProfile) {
        return $null
    }

    $type =
        [string](
            Get-PropertyValue `
                -Object $PermissionProfile `
                -Name "type"
        )

    if (
        [string]::IsNullOrWhiteSpace(
            $type
        )
    ) {
        return $null
    }

    switch (
        $type.ToLowerInvariant()
    ) {

        "disabled" {
            return "Full Access"
        }

        "read_only" {
            return "Read Only"
        }

        "workspace_write" {
            return "Workspace Write"
        }

        default {
            return $type
        }
    }
}


# ============================================================
# Rollout discovery
# ============================================================

function Find-RolloutPath {

    param(
        [string]$Id
    )

    $deadline =
        (Get-Date).AddSeconds(30)

    while ((Get-Date) -lt $deadline) {

        $match =
            Get-ChildItem `
                $sessionRoot `
                -Recurse `
                -File `
                -Filter "rollout-*$Id*.jsonl" `
                -ErrorAction SilentlyContinue |
            Sort-Object `
                LastWriteTimeUtc `
                -Descending |
            Select-Object -First 1

        if ($match) {
            return $match.FullName
        }

        Start-Sleep `
            -Milliseconds 300
    }

    return $null
}


# ============================================================
# Thread name
#
# session_index.jsonl is append-only:
#
# {
#   "id": "...",
#   "thread_name": "...",
#   "updated_at": "..."
# }
#
# One Session may appear multiple times after renaming.
# Always choose the newest updated_at.
# ============================================================

function Get-LatestThreadInfo {

    if (-not (Test-Path $sessionIndexPath)) {
        return $null
    }

    $stream = $null
    $reader = $null

    try {

        $stream =
            [System.IO.File]::Open(
                $sessionIndexPath,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::ReadWrite
            )

        $reader =
            New-Object `
                System.IO.StreamReader(
                    $stream,
                    [System.Text.Encoding]::UTF8,
                    $true
                )

        $bestRecord =
            $null

        $bestTime =
            [datetimeoffset]::MinValue

        $lineNumber =
            0

        $bestLineNumber =
            -1

        while (
            $null -ne (
                $line =
                    $reader.ReadLine()
            )
        ) {

            $lineNumber++

            if (
                [string]::IsNullOrWhiteSpace(
                    $line
                )
            ) {
                continue
            }

            try {

                $record =
                    $line |
                    ConvertFrom-Json

            }
            catch {
                continue
            }

            if (
                [string]$record.id -ne
                $SessionId
            ) {
                continue
            }

            $updated =
                [datetimeoffset]::MinValue

            try {

                $updated =
                    [datetimeoffset]::Parse(
                        [string]$record.updated_at
                    )

            }
            catch {
            }

            if (
                $updated -gt $bestTime -or
                (
                    $updated -eq $bestTime -and
                    $lineNumber -gt $bestLineNumber
                )
            ) {

                $bestRecord =
                    $record

                $bestTime =
                    $updated

                $bestLineNumber =
                    $lineNumber
            }
        }

        if (-not $bestRecord) {
            return $null
        }

        return (
            [pscustomobject]@{

                ThreadName =
                    [string]$bestRecord.thread_name

                UpdatedAt =
                    if (
                        $bestTime -ne
                        [datetimeoffset]::MinValue
                    ) {
                        $bestTime.ToString("o")
                    }
                    else {
                        $null
                    }
            }
        )

    }
    catch {

        Write-Log (
            "Unable to read session_index.jsonl: " +
            $_.Exception.Message
        )

        return $null

    }
    finally {

        if ($reader) {
            $reader.Dispose()
        }

        if ($stream) {
            $stream.Dispose()
        }
    }
}


# ============================================================
# Token usage helpers
# ============================================================

function Get-UsageSnapshot {

    param(
        [object]$Object
    )

    if ($null -eq $Object) {
        return $null
    }

    $total =
        Get-FirstNumber @(
            (
                Get-PropertyValue `
                    $Object `
                    "total_tokens"
            ),
            (
                Get-PropertyValue `
                    $Object `
                    "total"
            )
        )

    $input =
        Get-FirstNumber @(
            (
                Get-PropertyValue `
                    $Object `
                    "input_tokens"
            ),
            (
                Get-PropertyValue `
                    $Object `
                    "input"
            )
        )

    $cachedInput =
        Get-FirstNumber @(
            (
                Get-PropertyValue `
                    $Object `
                    "cached_input_tokens"
            ),
            (
                Get-PropertyValue `
                    $Object `
                    "cached_input"
            )
        )

    $output =
        Get-FirstNumber @(
            (
                Get-PropertyValue `
                    $Object `
                    "output_tokens"
            ),
            (
                Get-PropertyValue `
                    $Object `
                    "output"
            )
        )

    $reasoningOutput =
        Get-FirstNumber @(
            (
                Get-PropertyValue `
                    $Object `
                    "reasoning_output_tokens"
            ),
            (
                Get-PropertyValue `
                    $Object `
                    "reasoning_tokens"
            )
        )

    if (
        $null -eq $total -and
        $null -eq $input -and
        $null -eq $cachedInput -and
        $null -eq $output -and
        $null -eq $reasoningOutput
    ) {
        return $null
    }

    return (
        [pscustomobject]@{

            total =
                $total

            input =
                $input

            cachedInput =
                $cachedInput

            output =
                $output

            reasoningOutput =
                $reasoningOutput
        }
    )
}


function Apply-UsageSnapshot {

    param(
        [object]$Snapshot,
        [object]$Status
    )

    if ($null -eq $Snapshot) {
        return
    }

    foreach (
        $name in @(
            "total",
            "input",
            "cachedInput",
            "output",
            "reasoningOutput"
        )
    ) {

        $value =
            Get-PropertyValue `
                -Object $Snapshot `
                -Name $name

        if ($null -ne $value) {

            $Status["tokenUsage"][$name] =
                [long]$value
        }
    }
}


function Update-ContextWindow {

    param(
        [object]$Status,
        [object]$Total,
        [object]$Used
    )

    if ($null -ne $Total) {

        try {

            $totalValue =
                [long]$Total

            if ($totalValue -gt 0) {

                $Status["contextWindow"]["total"] =
                    $totalValue
            }

        }
        catch {
        }
    }


    if ($null -ne $Used) {

        try {

            $usedValue =
                [long]$Used

            $knownTotal =
                $Status["contextWindow"]["total"]

            if (
                $usedValue -ge 0 -and
                (
                    $null -eq $knownTotal -or
                    $usedValue -le [long]$knownTotal
                )
            ) {

                $Status["contextWindow"]["used"] =
                    $usedValue
            }

        }
        catch {
        }
    }


    $finalTotal =
        $Status["contextWindow"]["total"]

    $finalUsed =
        $Status["contextWindow"]["used"]


    if (
        $null -ne $finalTotal -and
        $null -ne $finalUsed -and
        [long]$finalTotal -gt 0 -and
        [long]$finalUsed -le [long]$finalTotal
    ) {

        $left =
            100.0 *
            (
                [long]$finalTotal -
                [long]$finalUsed
            ) /
            [long]$finalTotal

        $Status["contextWindow"]["percentLeft"] =
            [int][math]::Round(
                $left
            )
    }
}


function Apply-TokenUsageRecord {

    param(
        [object]$Payload,
        [object]$Status
    )

    if ($null -eq $Payload) {
        return
    }


    # --------------------------------------------------------
    # Lifetime / thread cumulative token usage
    # --------------------------------------------------------

    $threadUsageObject =
        Get-PropertyValue `
            -Object $Payload `
            -Name "thread_token_usage"


    if ($null -eq $threadUsageObject) {

        $usage =
            Get-PropertyValue `
                -Object $Payload `
                -Name "usage"

        if ($usage) {

            $threadUsageObject =
                Get-PropertyValue `
                    -Object $usage `
                    -Name "total_token_usage"
        }
    }


    if ($null -eq $threadUsageObject) {

        $threadUsageObject =
            Get-PropertyValue `
                -Object $Payload `
                -Name "usage"
    }


    $threadSnapshot =
        Get-UsageSnapshot `
            -Object $threadUsageObject


    Apply-UsageSnapshot `
        -Snapshot $threadSnapshot `
        -Status $Status


    # --------------------------------------------------------
    # Current context / latest turn usage
    # --------------------------------------------------------

    $turnUsageObject =
        Get-PropertyValue `
            -Object $Payload `
            -Name "turn_token_usage"


    if ($null -eq $turnUsageObject) {

        $usage =
            Get-PropertyValue `
                -Object $Payload `
                -Name "usage"

        if ($usage) {

            $turnUsageObject =
                Get-PropertyValue `
                    -Object $usage `
                    -Name "last_token_usage"
        }
    }


    $turnSnapshot =
        Get-UsageSnapshot `
            -Object $turnUsageObject


    $contextUsed =
        if ($turnSnapshot) {
            $turnSnapshot.total
        }
        else {
            $null
        }


    $usageObject =
        Get-PropertyValue `
            -Object $Payload `
            -Name "usage"


    $contextTotal =
        if ($usageObject) {

            Get-FirstNumber @(
                (
                    Get-PropertyValue `
                        $usageObject `
                        "model_context_window"
                ),
                (
                    Get-PropertyValue `
                        $usageObject `
                        "context_window"
                )
            )

        }
        else {
            $null
        }


    Update-ContextWindow `
        -Status $Status `
        -Total $contextTotal `
        -Used $contextUsed
}


# ============================================================
# Status object
# ============================================================

$status =
    [ordered]@{

        version =
            4

        sessionId =
            $SessionId

        threadName =
            $null

        threadNameUpdatedAt =
            $null

        projectName =
            $null

        cwd =
            $null

        rolloutPath =
            $null

        cliVersion =
            $null

        model =
            $null

        reasoningEffort =
            $null

        modelProvider =
            $null

        permissions =
            $null

        approvalPolicy =
            $null

        collaborationMode =
            $null

        personality =
            $null

        tokenUsage =
            [ordered]@{

                total =
                    $null

                input =
                    $null

                cachedInput =
                    $null

                output =
                    $null

                reasoningOutput =
                    $null
            }

        contextWindow =
            [ordered]@{

                used =
                    $null

                total =
                    $null

                percentLeft =
                    $null
            }

        state =
            "Starting"

        lastActivity =
            "Observer attached"

        lastEventType =
            $null

        lastEventTime =
            $null

        observerPid =
            $PID

        observerState =
            "Running"

        observerStartedAt =
            (Get-Date).ToString("o")

        observerUpdatedAt =
            (Get-Date).ToString("o")
    }


function Write-Status {

    $status["observerUpdatedAt"] =
        (Get-Date).ToString("o")

    Write-JsonAtomic `
        -Path $statusPath `
        -Value $status
}


# ============================================================
# Thread-name refresh
# ============================================================

$script:lastSessionIndexWriteUtc =
    [datetime]::MinValue


function Refresh-ThreadName {

    param(
        [switch]$Force
    )

    if (-not (Test-Path $sessionIndexPath)) {
        return
    }

    try {

        $item =
            Get-Item `
                $sessionIndexPath `
                -ErrorAction Stop

        if (
            -not $Force -and
            $item.LastWriteTimeUtc -eq
            $script:lastSessionIndexWriteUtc
        ) {
            return
        }

        $script:lastSessionIndexWriteUtc =
            $item.LastWriteTimeUtc


        $thread =
            Get-LatestThreadInfo


        if ($thread) {

            if (
                -not [string]::IsNullOrWhiteSpace(
                    $thread.ThreadName
                )
            ) {

                $status["threadName"] =
                    $thread.ThreadName
            }

            $status["threadNameUpdatedAt"] =
                $thread.UpdatedAt
        }

    }
    catch {

        Write-Log (
            "Unable to refresh thread name: " +
            $_.Exception.Message
        )
    }
}


# ============================================================
# Event processing
# ============================================================

function Get-EventTimestamp {

    param(
        [object]$Event
    )

    $timestamp =
        Get-PropertyValue `
            -Object $Event `
            -Name "timestamp"

    if ($timestamp) {
        return [string]$timestamp
    }

    return (
        (Get-Date).ToString("o")
    )
}


function Apply-ThreadSettings {

    param(
        [object]$Settings
    )

    if ($null -eq $Settings) {
        return
    }


    $model =
        Get-PropertyValue `
            $Settings `
            "model"

    if ($model) {
        $status["model"] =
            [string]$model
    }


    $provider =
        Get-PropertyValue `
            $Settings `
            "model_provider_id"

    if ($provider) {
        $status["modelProvider"] =
            [string]$provider
    }


    $reasoning =
        Get-PropertyValue `
            $Settings `
            "reasoning_effort"

    if ($reasoning) {
        $status["reasoningEffort"] =
            [string]$reasoning
    }


    $cwd =
        Get-PropertyValue `
            $Settings `
            "cwd"

    if ($cwd) {

        $status["cwd"] =
            [string]$cwd

        $status["projectName"] =
            Get-ProjectName `
                -Path ([string]$cwd)
    }


    $approval =
        Get-PropertyValue `
            $Settings `
            "approval_policy"

    if ($approval) {
        $status["approvalPolicy"] =
            [string]$approval
    }


    $permissionProfile =
        Get-PropertyValue `
            $Settings `
            "permission_profile"

    if ($permissionProfile) {

        $status["permissions"] =
            Convert-PermissionProfile `
                -PermissionProfile $permissionProfile
    }


    $personality =
        Get-PropertyValue `
            $Settings `
            "personality"

    if ($personality) {
        $status["personality"] =
            [string]$personality
    }


    $collaboration =
        Get-PropertyValue `
            $Settings `
            "collaboration_mode"

    if ($collaboration) {

        $mode =
            Get-PropertyValue `
                $collaboration `
                "mode"

        if ($mode) {
            $status["collaborationMode"] =
                [string]$mode
        }
    }
}


function Apply-Event {

    param(
        [object]$Event
    )

    if ($null -eq $Event) {
        return
    }


    $outerType =
        [string](
            Get-PropertyValue `
                $Event `
                "type"
        )

    $payload =
        Get-PropertyValue `
            $Event `
            "payload"

    $eventTime =
        Get-EventTimestamp `
            -Event $Event


    $effectiveType =
        $outerType


    if ($payload) {

        $payloadType =
            Get-PropertyValue `
                $payload `
                "type"

        if ($payloadType) {

            # Important:
            # ${outerType} is required because "$outerType:"
            # is parsed by PowerShell as a scoped variable.
            $effectiveType =
                "${outerType}:$payloadType"
        }
    }


    $status["lastEventType"] =
        $effectiveType

    $status["lastEventTime"] =
        $eventTime


    # ========================================================
    # session_meta
    # ========================================================

    if ($outerType -eq "session_meta") {

        $cwd =
            Get-PropertyValue `
                $payload `
                "cwd"

        if ($cwd) {

            $status["cwd"] =
                [string]$cwd

            $status["projectName"] =
                Get-ProjectName `
                    -Path ([string]$cwd)
        }


        $cliVersion =
            Get-PropertyValue `
                $payload `
                "cli_version"

        if ($cliVersion) {
            $status["cliVersion"] =
                [string]$cliVersion
        }


        $provider =
            Get-PropertyValue `
                $payload `
                "model_provider"

        if ($provider) {
            $status["modelProvider"] =
                [string]$provider
        }


        $contextWindow =
            Get-FirstNumber @(
                (
                    Get-PropertyValue `
                        $payload `
                        "context_window"
                )
            )


        Update-ContextWindow `
            -Status $status `
            -Total $contextWindow `
            -Used $null


        return
    }


    # ========================================================
    # turn_context
    # ========================================================

    if ($outerType -eq "turn_context") {

        $cwd =
            Get-PropertyValue `
                $payload `
                "cwd"

        if ($cwd) {

            $status["cwd"] =
                [string]$cwd

            $status["projectName"] =
                Get-ProjectName `
                    -Path ([string]$cwd)
        }


        $model =
            Get-PropertyValue `
                $payload `
                "model"

        if ($model) {
            $status["model"] =
                [string]$model
        }


        $approval =
            Get-PropertyValue `
                $payload `
                "approval_policy"

        if ($approval) {
            $status["approvalPolicy"] =
                [string]$approval
        }


        $permission =
            Get-PropertyValue `
                $payload `
                "permission_profile"

        if ($permission) {

            $status["permissions"] =
                Convert-PermissionProfile `
                    -PermissionProfile $permission
        }


        $personality =
            Get-PropertyValue `
                $payload `
                "personality"

        if ($personality) {
            $status["personality"] =
                [string]$personality
        }


        $collaboration =
            Get-PropertyValue `
                $payload `
                "collaboration_mode"

        if ($collaboration) {

            $mode =
                Get-PropertyValue `
                    $collaboration `
                    "mode"

            if ($mode) {
                $status["collaborationMode"] =
                    [string]$mode
            }
        }


        $status["state"] =
            "Running"

        $status["lastActivity"] =
            "Turn in progress"

        return
    }


    # ========================================================
    # token_usage_record
    # ========================================================

    if (
        $outerType -eq
        "token_usage_record"
    ) {

        Apply-TokenUsageRecord `
            -Payload $payload `
            -Status $status

        return
    }


    # ========================================================
    # event_msg
    # ========================================================

    if ($outerType -eq "event_msg") {

        $kind =
            [string](
                Get-PropertyValue `
                    $payload `
                    "type"
            )


        $threadSettings =
            Get-PropertyValue `
                $payload `
                "thread_settings"


        if ($threadSettings) {

            Apply-ThreadSettings `
                -Settings $threadSettings
        }


        $modelContextWindow =
            Get-FirstNumber @(
                (
                    Get-PropertyValue `
                        $payload `
                        "model_context_window"
                )
            )


        if ($null -ne $modelContextWindow) {

            Update-ContextWindow `
                -Status $status `
                -Total $modelContextWindow `
                -Used $null
        }


        switch -Regex ($kind) {

            "^(task_started|turn_started|turn_start|turn_begin)$" {

                $status["state"] =
                    "Running"

                $status["lastActivity"] =
                    "Task running"

                break
            }


            "^(task_complete|task_completed|turn_complete|turn_completed)$" {

                $status["state"] =
                    "Waiting"

                $status["lastActivity"] =
                    "Task completed; waiting for input"

                break
            }


            "(aborted|cancelled|canceled|interrupted)" {

                $status["state"] =
                    "Waiting"

                $status["lastActivity"] =
                    "Task interrupted; waiting for input"

                break
            }


            "^(item_started|item_start)$" {

                $status["state"] =
                    "Running"

                $status["lastActivity"] =
                    "Processing item"

                break
            }


            "thread_settings_applied" {

                # Metadata update only.
                break
            }
        }


        return
    }


    # ========================================================
    # response_item
    # ========================================================

    if ($outerType -eq "response_item") {

        $itemType =
            [string](
                Get-PropertyValue `
                    $payload `
                    "type"
            )


        switch -Regex ($itemType) {

            "^reasoning$" {

                $status["state"] =
                    "Running"

                $status["lastActivity"] =
                    "Reasoning"

                break
            }


            "(function_call|custom_tool_call|tool_call|web_search_call)" {

                $status["state"] =
                    "Running"

                $toolName =
                    Get-PropertyValue `
                        $payload `
                        "name"

                if ($toolName) {

                    $status["lastActivity"] =
                        "Tool: $toolName"

                }
                else {

                    $status["lastActivity"] =
                        "Tool call"
                }

                break
            }


            "(function_call_output|custom_tool_call_output|tool_output)" {

                $status["state"] =
                    "Running"

                $status["lastActivity"] =
                    "Tool completed"

                break
            }


            "^message$" {

                $role =
                    [string](
                        Get-PropertyValue `
                            $payload `
                            "role"
                    )

                if ($role -eq "assistant") {

                    $status["state"] =
                        "Running"

                    $status["lastActivity"] =
                        "Assistant responding"

                }
                elseif ($role -eq "user") {

                    $status["state"] =
                        "Running"

                    $status["lastActivity"] =
                        "User input received"
                }

                break
            }
        }
    }
}


# ============================================================
# Locate rollout
# ============================================================

if (-not (Test-Path $sessionRoot)) {

    Write-Log (
        "Session directory does not exist: " +
        $sessionRoot
    )

    exit 1
}


$rolloutPath =
    Find-RolloutPath `
        -Id $SessionId


if (-not $rolloutPath) {

    Write-Log (
        "Unable to find rollout for Session " +
        $SessionId
    )

    exit 1
}


$status["rolloutPath"] =
    $rolloutPath


Refresh-ThreadName -Force

Write-Status


Write-Log (
    "Observer started. " +
    "Session=$SessionId " +
    "Rollout=$rolloutPath"
)


# ============================================================
# Follow rollout JSONL read-only
# ============================================================

$stream = $null
$reader = $null


try {

    $shareMode =
        [System.IO.FileShare]::ReadWrite -bor
        [System.IO.FileShare]::Delete


    $stream =
        New-Object `
            System.IO.FileStream(
                $rolloutPath,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                $shareMode
            )


    $reader =
        New-Object `
            System.IO.StreamReader(
                $stream,
                [System.Text.Encoding]::UTF8,
                $true
            )


    $initialCatchup =
        $true


    $nextHeartbeat =
        (Get-Date).AddSeconds(
            $HeartbeatSeconds
        )


    while ($true) {

        while (
            $null -ne (
                $line =
                    $reader.ReadLine()
            )
        ) {

            if (
                [string]::IsNullOrWhiteSpace(
                    $line
                )
            ) {
                continue
            }


            try {

                $event =
                    $line |
                    ConvertFrom-Json

            }
            catch {

                continue
            }


            Apply-Event `
                -Event $event


            # During initial catch-up, do not rewrite status
            # thousands of times for a large resumed Session.
            if (-not $initialCatchup) {

                Refresh-ThreadName

                Write-Status
            }
        }


        if ($initialCatchup) {

            Refresh-ThreadName -Force

            Write-Status

            $initialCatchup =
                $false
        }


        if (
            (Get-Date) -ge
            $nextHeartbeat
        ) {

            Refresh-ThreadName

            Write-Status


            $nextHeartbeat =
                (Get-Date).AddSeconds(
                    $HeartbeatSeconds
                )
        }


        Start-Sleep `
            -Milliseconds 200
    }

}
catch {

    Write-Log (
        "Observer error: " +
        $_.Exception.Message
    )

}
finally {

    if ($reader) {
        $reader.Dispose()
    }

    if ($stream) {
        $stream.Dispose()
    }


    try {

        $status["observerState"] =
            "Stopped"

        $status["observerUpdatedAt"] =
            (Get-Date).ToString("o")

        Write-JsonAtomic `
            -Path $statusPath `
            -Value $status

    }
    catch {
    }


    Write-Log "Observer stopped."
}