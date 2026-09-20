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
# Logging
# ============================================================

function Write-Log {

    param(
        [string]$Message
    )

    try {

        Add-Content `
            -Path $logPath `
            -Value "$(Get-Date -Format o) $Message" `
            -Encoding UTF8

    }
    catch {
        # Logging must never stop Observer.
    }
}


# ============================================================
# JSON
# ============================================================

function Write-JsonAtomic {

    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [object]$Value
    )

    $json =
        $Value |
        ConvertTo-Json -Depth 40

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


# ============================================================
# Generic helpers
# ============================================================

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


function Convert-ToLongOrNull {

    param(
        [object]$Value
    )

    if ($null -eq $Value) {
        return $null
    }

    try {
        return [long]$Value
    }
    catch {
        return $null
    }
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
                $Path.TrimEnd("\", "/") `
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


    switch ($type.ToLowerInvariant()) {

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
# Find rollout
# ============================================================

function Find-RolloutPath {

    param(
        [string]$Id
    )

    $deadline =
        (Get-Date).AddSeconds(30)


    while ((Get-Date) -lt $deadline) {

        $file =
            Get-ChildItem `
                $sessionRoot `
                -Recurse `
                -Filter "rollout-*$Id*.jsonl" `
                -File `
                -ErrorAction SilentlyContinue |
            Sort-Object `
                LastWriteTimeUtc `
                -Descending |
            Select-Object -First 1


        if ($file) {
            return $file.FullName
        }


        Start-Sleep `
            -Milliseconds 300
    }


    return $null
}


# ============================================================
# Thread name
#
# session_index.jsonl is append-only.
# Same Session ID may have multiple rename records.
# Latest updated_at wins.
# ============================================================

function Get-LatestThreadInfo {

    if (
        -not (
            Test-Path $sessionIndexPath
        )
    ) {
        return $null
    }


    $stream =
        $null

    $reader =
        $null


    try {

        $stream =
            [System.IO.File]::Open(
                $sessionIndexPath,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::ReadWrite
            )


        $reader =
            [System.IO.StreamReader]::new(
                $stream,
                [System.Text.Encoding]::UTF8,
                $true
            )


        $bestRecord =
            $null

        $bestTime =
            [datetimeoffset]::MinValue

        $bestLineNumber =
            -1

        $lineNumber =
            0


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


        $updatedAt =
            $null


        if (
            $bestTime -ne
            [datetimeoffset]::MinValue
        ) {

            $updatedAt =
                $bestTime.ToString("o")
        }


        return (
            [pscustomobject]@{

                ThreadName =
                    [string]$bestRecord.thread_name

                UpdatedAt =
                    $updatedAt
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
# Status model
# ============================================================

$status =
    [ordered]@{

        version =
            6

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


function Set-CurrentCwd {

    param(
        [string]$Value
    )

    if (
        [string]::IsNullOrWhiteSpace(
            $Value
        )
    ) {
        return
    }


    $status["cwd"] =
        $Value


    $status["projectName"] =
        Get-ProjectName `
            -Path $Value
}


function Write-Status {

    $status["observerUpdatedAt"] =
        (Get-Date).ToString("o")


    Write-JsonAtomic `
        -Path $statusPath `
        -Value $status
}


# ============================================================
# Thread name refresh
# ============================================================

$script:lastSessionIndexWriteUtc =
    [datetime]::MinValue


function Refresh-ThreadName {

    param(
        [switch]$Force
    )


    if (
        -not (
            Test-Path $sessionIndexPath
        )
    ) {
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


        if (-not $thread) {
            return
        }


        if (
            -not (
                [string]::IsNullOrWhiteSpace(
                    $thread.ThreadName
                )
            )
        ) {

            $status["threadName"] =
                $thread.ThreadName
        }


        $status["threadNameUpdatedAt"] =
            $thread.UpdatedAt

    }
    catch {

        Write-Log (
            "Unable to refresh Thread name: " +
            $_.Exception.Message
        )
    }
}


# ============================================================
# Usage parsing
# ============================================================

function Get-UsageSnapshot {

    param(
        [object]$Object
    )

    if ($null -eq $Object) {
        return $null
    }


    $total =
        Convert-ToLongOrNull (
            Get-PropertyValue `
                -Object $Object `
                -Name "total_tokens"
        )


    if ($null -eq $total) {

        $total =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $Object `
                    -Name "total"
            )
    }


    $input =
        Convert-ToLongOrNull (
            Get-PropertyValue `
                -Object $Object `
                -Name "input_tokens"
        )


    if ($null -eq $input) {

        $input =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $Object `
                    -Name "input"
            )
    }


    $cachedInput =
        Convert-ToLongOrNull (
            Get-PropertyValue `
                -Object $Object `
                -Name "cached_input_tokens"
        )


    if ($null -eq $cachedInput) {

        $cachedInput =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $Object `
                    -Name "cached_input"
            )
    }


    $output =
        Convert-ToLongOrNull (
            Get-PropertyValue `
                -Object $Object `
                -Name "output_tokens"
        )


    if ($null -eq $output) {

        $output =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $Object `
                    -Name "output"
            )
    }


    $reasoningOutput =
        Convert-ToLongOrNull (
            Get-PropertyValue `
                -Object $Object `
                -Name "reasoning_output_tokens"
        )


    if ($null -eq $reasoningOutput) {

        $reasoningOutput =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $Object `
                    -Name "reasoning_tokens"
            )
    }


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
        [object]$Snapshot
    )

    if (-not $Snapshot) {
        return
    }


    $value =
        Get-PropertyValue `
            -Object $Snapshot `
            -Name "total"

    if ($null -ne $value) {
        $status["tokenUsage"]["total"] =
            [long]$value
    }


    $value =
        Get-PropertyValue `
            -Object $Snapshot `
            -Name "input"

    if ($null -ne $value) {
        $status["tokenUsage"]["input"] =
            [long]$value
    }


    $value =
        Get-PropertyValue `
            -Object $Snapshot `
            -Name "cachedInput"

    if ($null -ne $value) {
        $status["tokenUsage"]["cachedInput"] =
            [long]$value
    }


    $value =
        Get-PropertyValue `
            -Object $Snapshot `
            -Name "output"

    if ($null -ne $value) {
        $status["tokenUsage"]["output"] =
            [long]$value
    }


    $value =
        Get-PropertyValue `
            -Object $Snapshot `
            -Name "reasoningOutput"

    if ($null -ne $value) {
        $status["tokenUsage"]["reasoningOutput"] =
            [long]$value
    }
}


function Update-ContextWindow {

    param(
        [object]$Total,

        [object]$Used
    )


    $totalValue =
        Convert-ToLongOrNull $Total


    if (
        $null -ne $totalValue -and
        $totalValue -gt 0
    ) {

        $status["contextWindow"]["total"] =
            $totalValue
    }


    $usedValue =
        Convert-ToLongOrNull $Used


    if (
        $null -ne $usedValue -and
        $usedValue -ge 0
    ) {

        $knownTotal =
            $status["contextWindow"]["total"]


        if (
            $null -eq $knownTotal -or
            $usedValue -le [long]$knownTotal
        ) {

            $status["contextWindow"]["used"] =
                $usedValue
        }
    }


    $finalTotal =
        $status["contextWindow"]["total"]

    $finalUsed =
        $status["contextWindow"]["used"]


    if (
        $null -ne $finalTotal -and
        $null -ne $finalUsed -and
        [long]$finalTotal -gt 0 -and
        [long]$finalUsed -le [long]$finalTotal
    ) {

        $left =
            (
                (
                    [long]$finalTotal -
                    [long]$finalUsed
                ) /
                [double]$finalTotal
            ) * 100


        $status["contextWindow"]["percentLeft"] =
            [int][math]::Round($left)
    }
}


function Apply-UsageContainer {

    param(
        [object]$Payload
    )

    if ($null -eq $Payload) {
        return
    }


    $usage =
        Get-PropertyValue `
            -Object $Payload `
            -Name "usage"


    $info =
        Get-PropertyValue `
            -Object $Payload `
            -Name "info"


    # --------------------------------------------------------
    # Thread cumulative usage
    # --------------------------------------------------------

    $threadUsage =
        Get-PropertyValue `
            -Object $Payload `
            -Name "thread_token_usage"


    if (
        $null -eq $threadUsage -and
        $null -ne $usage
    ) {

        $threadUsage =
            Get-PropertyValue `
                -Object $usage `
                -Name "total_token_usage"
    }


    if (
        $null -eq $threadUsage -and
        $null -ne $info
    ) {

        $threadUsage =
            Get-PropertyValue `
                -Object $info `
                -Name "thread_token_usage"
    }


    if (
        $null -eq $threadUsage -and
        $null -ne $info
    ) {

        $threadUsage =
            Get-PropertyValue `
                -Object $info `
                -Name "total_token_usage"
    }


    if (
        $null -eq $threadUsage -and
        $null -ne $usage
    ) {

        $threadUsage =
            $usage
    }


    $threadSnapshot =
        Get-UsageSnapshot `
            -Object $threadUsage


    Apply-UsageSnapshot `
        -Snapshot $threadSnapshot


    # --------------------------------------------------------
    # Latest/current turn usage
    # --------------------------------------------------------

    $turnUsage =
        Get-PropertyValue `
            -Object $Payload `
            -Name "turn_token_usage"


    if (
        $null -eq $turnUsage -and
        $null -ne $usage
    ) {

        $turnUsage =
            Get-PropertyValue `
                -Object $usage `
                -Name "last_token_usage"
    }


    if (
        $null -eq $turnUsage -and
        $null -ne $info
    ) {

        $turnUsage =
            Get-PropertyValue `
                -Object $info `
                -Name "turn_token_usage"
    }


    if (
        $null -eq $turnUsage -and
        $null -ne $info
    ) {

        $turnUsage =
            Get-PropertyValue `
                -Object $info `
                -Name "last_token_usage"
    }


    $turnSnapshot =
        Get-UsageSnapshot `
            -Object $turnUsage


    # --------------------------------------------------------
    # Context total
    # --------------------------------------------------------

    $contextTotal =
        Convert-ToLongOrNull (
            Get-PropertyValue `
                -Object $Payload `
                -Name "model_context_window"
        )


    if ($null -eq $contextTotal) {

        $contextTotal =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $Payload `
                    -Name "context_window"
            )
    }


    if (
        $null -eq $contextTotal -and
        $null -ne $usage
    ) {

        $contextTotal =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $usage `
                    -Name "model_context_window"
            )
    }


    if (
        $null -eq $contextTotal -and
        $null -ne $usage
    ) {

        $contextTotal =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $usage `
                    -Name "context_window"
            )
    }


    if (
        $null -eq $contextTotal -and
        $null -ne $info
    ) {

        $contextTotal =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $info `
                    -Name "model_context_window"
            )
    }


    if (
        $null -eq $contextTotal -and
        $null -ne $info
    ) {

        $contextTotal =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $info `
                    -Name "context_window"
            )
    }


    # --------------------------------------------------------
    # Context used
    # --------------------------------------------------------

    $contextUsed =
        Convert-ToLongOrNull (
            Get-PropertyValue `
                -Object $Payload `
                -Name "context_used"
        )


    if ($null -eq $contextUsed) {

        $contextUsed =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $Payload `
                    -Name "context_tokens"
            )
    }


    if (
        $null -eq $contextUsed -and
        $null -ne $usage
    ) {

        $contextUsed =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $usage `
                    -Name "context_used"
            )
    }


    if (
        $null -eq $contextUsed -and
        $null -ne $usage
    ) {

        $contextUsed =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $usage `
                    -Name "context_tokens"
            )
    }


    if (
        $null -eq $contextUsed -and
        $null -ne $info
    ) {

        $contextUsed =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $info `
                    -Name "context_used"
            )
    }


    if (
        $null -eq $contextUsed -and
        $null -ne $info
    ) {

        $contextUsed =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $info `
                    -Name "context_tokens"
            )
    }


    if (
        $null -eq $contextUsed -and
        $null -ne $turnSnapshot
    ) {

        $contextUsed =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $turnSnapshot `
                    -Name "total"
            )
    }


    Update-ContextWindow `
        -Total $contextTotal `
        -Used $contextUsed
}


# ============================================================
# Thread settings
# ============================================================

function Apply-ThreadSettings {

    param(
        [object]$Settings
    )

    if ($null -eq $Settings) {
        return
    }


    $model =
        Get-PropertyValue `
            -Object $Settings `
            -Name "model"

    if ($model) {
        $status["model"] =
            [string]$model
    }


    $provider =
        Get-PropertyValue `
            -Object $Settings `
            -Name "model_provider_id"

    if (-not $provider) {

        $provider =
            Get-PropertyValue `
                -Object $Settings `
                -Name "model_provider"
    }

    if ($provider) {
        $status["modelProvider"] =
            [string]$provider
    }


    $reasoning =
        Get-PropertyValue `
            -Object $Settings `
            -Name "reasoning_effort"

    if ($reasoning) {
        $status["reasoningEffort"] =
            [string]$reasoning
    }


    $cwd =
        Get-PropertyValue `
            -Object $Settings `
            -Name "cwd"

    if ($cwd) {

        Set-CurrentCwd `
            -Value ([string]$cwd)
    }


    $approval =
        Get-PropertyValue `
            -Object $Settings `
            -Name "approval_policy"

    if ($approval) {
        $status["approvalPolicy"] =
            [string]$approval
    }


    $permission =
        Get-PropertyValue `
            -Object $Settings `
            -Name "permission_profile"

    if ($permission) {

        $status["permissions"] =
            Convert-PermissionProfile `
                -PermissionProfile $permission
    }


    $personality =
        Get-PropertyValue `
            -Object $Settings `
            -Name "personality"

    if ($personality) {
        $status["personality"] =
            [string]$personality
    }


    $collaboration =
        Get-PropertyValue `
            -Object $Settings `
            -Name "collaboration_mode"

    if ($collaboration) {

        $mode =
            Get-PropertyValue `
                -Object $collaboration `
                -Name "mode"

        if (-not $mode) {

            $mode =
                Get-PropertyValue `
                    -Object $collaboration `
                    -Name "kind"
        }

        if ($mode) {

            $status["collaborationMode"] =
                [string]$mode
        }
    }
}


# ============================================================
# Event timestamp
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


# ============================================================
# Event processor
# ============================================================

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
                -Object $Event `
                -Name "type"
        )


    $payload =
        Get-PropertyValue `
            -Object $Event `
            -Name "payload"


    $eventTime =
        Get-EventTimestamp `
            -Event $Event


    $effectiveType =
        $outerType


    if ($payload) {

        $payloadType =
            Get-PropertyValue `
                -Object $payload `
                -Name "type"


        if ($payloadType) {

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

    if (
        $outerType -eq
        "session_meta"
    ) {

        $cwd =
            Get-PropertyValue `
                -Object $payload `
                -Name "cwd"


        if ($cwd) {

            Set-CurrentCwd `
                -Value ([string]$cwd)
        }


        $cliVersion =
            Get-PropertyValue `
                -Object $payload `
                -Name "cli_version"


        if ($cliVersion) {

            $status["cliVersion"] =
                [string]$cliVersion
        }


        $provider =
            Get-PropertyValue `
                -Object $payload `
                -Name "model_provider"


        if ($provider) {

            $status["modelProvider"] =
                [string]$provider
        }


        $contextTotal =
            Convert-ToLongOrNull (
                Get-PropertyValue `
                    -Object $payload `
                    -Name "context_window"
            )


        if ($null -eq $contextTotal) {

            $contextTotal =
                Convert-ToLongOrNull (
                    Get-PropertyValue `
                        -Object $payload `
                        -Name "model_context_window"
                )
        }


        Update-ContextWindow `
            -Total $contextTotal `
            -Used $null


        return
    }


    # ========================================================
    # turn_context
    # ========================================================

    if (
        $outerType -eq
        "turn_context"
    ) {

        $cwd =
            Get-PropertyValue `
                -Object $payload `
                -Name "cwd"


        if ($cwd) {

            Set-CurrentCwd `
                -Value ([string]$cwd)
        }


        $model =
            Get-PropertyValue `
                -Object $payload `
                -Name "model"


        if ($model) {

            $status["model"] =
                [string]$model
        }


        $reasoning =
            Get-PropertyValue `
                -Object $payload `
                -Name "reasoning_effort"


        if ($reasoning) {

            $status["reasoningEffort"] =
                [string]$reasoning
        }


        $provider =
            Get-PropertyValue `
                -Object $payload `
                -Name "model_provider_id"


        if (-not $provider) {

            $provider =
                Get-PropertyValue `
                    -Object $payload `
                    -Name "model_provider"
        }


        if ($provider) {

            $status["modelProvider"] =
                [string]$provider
        }


        $approval =
            Get-PropertyValue `
                -Object $payload `
                -Name "approval_policy"


        if ($approval) {

            $status["approvalPolicy"] =
                [string]$approval
        }


        $permission =
            Get-PropertyValue `
                -Object $payload `
                -Name "permission_profile"


        if ($permission) {

            $status["permissions"] =
                Convert-PermissionProfile `
                    -PermissionProfile $permission
        }


        $personality =
            Get-PropertyValue `
                -Object $payload `
                -Name "personality"


        if ($personality) {

            $status["personality"] =
                [string]$personality
        }


        $collaboration =
            Get-PropertyValue `
                -Object $payload `
                -Name "collaboration_mode"


        if ($collaboration) {

            $mode =
                Get-PropertyValue `
                    -Object $collaboration `
                    -Name "mode"

            if (-not $mode) {

                $mode =
                    Get-PropertyValue `
                        -Object $collaboration `
                        -Name "kind"
            }

            if ($mode) {

                $status["collaborationMode"] =
                    [string]$mode
            }
        }


        $collaborationKind =
            Get-PropertyValue `
                -Object $payload `
                -Name "collaboration_mode_kind"


        if ($collaborationKind) {

            $status["collaborationMode"] =
                [string]$collaborationKind
        }


        Apply-UsageContainer `
            -Payload $payload


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

        Apply-UsageContainer `
            -Payload $payload

        return
    }


    # ========================================================
    # event_msg
    # ========================================================

    if (
        $outerType -eq
        "event_msg"
    ) {

        $kind =
            [string](
                Get-PropertyValue `
                    -Object $payload `
                    -Name "type"
            )


        $threadSettings =
            Get-PropertyValue `
                -Object $payload `
                -Name "thread_settings"


        if ($threadSettings) {

            Apply-ThreadSettings `
                -Settings $threadSettings
        }


        Apply-UsageContainer `
            -Payload $payload


        switch -Regex ($kind) {

            "^(task_started|turn_started|turn_start|turn_begin)$" {

                $status["state"] =
                    "Running"

                $status["lastActivity"] =
                    "Task running"

                break
            }


            "^(task_complete|task_completed|turn_complete|turn_completed|turn_end|turn_ended)$" {

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


            "^thread_settings_applied$" {

                break
            }


            "^(token_count|token_usage)$" {

                break
            }
        }


        return
    }


    # ========================================================
    # response_item
    # ========================================================

    if (
        $outerType -eq
        "response_item"
    ) {

        $itemType =
            [string](
                Get-PropertyValue `
                    -Object $payload `
                    -Name "type"
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
                        -Object $payload `
                        -Name "name"


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
                            -Object $payload `
                            -Name "role"
                    )


                if ($role -eq "assistant") {

                    $status["state"] =
                        "Running"

                    $status["lastActivity"] =
                        "Assistant responding"
                }


                if ($role -eq "user") {

                    $status["state"] =
                        "Running"

                    $status["lastActivity"] =
                        "User input received"
                }


                break
            }
        }


        return
    }
}


# ============================================================
# Startup
# ============================================================

Write-Log "============================================================"
Write-Log "Watch-CodexSession started"
Write-Log "SessionId=$SessionId"
Write-Log "CODEX_HOME=$CodexHome"
Write-Log "MonitorHome=$MonitorHome"


if (
    -not (
        Test-Path $sessionRoot
    )
) {

    Write-Log (
        "Session root does not exist: " +
        $sessionRoot
    )

    exit 1
}


$rolloutPath =
    Find-RolloutPath `
        -Id $SessionId


if (-not $rolloutPath) {

    Write-Log (
        "Unable to locate rollout for Session " +
        $SessionId
    )

    exit 2
}


$status["rolloutPath"] =
    $rolloutPath


Write-Log (
    "Rollout=" +
    $rolloutPath
)


# ============================================================
# Prime metadata
# ============================================================

try {

    $primeLines =
        Get-Content `
            -Path $rolloutPath `
            -TotalCount 200 `
            -Encoding UTF8 `
            -ErrorAction Stop


    foreach ($line in $primeLines) {

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
    }

}
catch {

    Write-Log (
        "Initial metadata prime failed: " +
        $_.Exception.Message
    )
}


Refresh-ThreadName -Force

Write-Status


Write-Log (
    "Initial status created: " +
    $statusPath
)


# ============================================================
# Follow rollout
# ============================================================

$stream =
    $null

$reader =
    $null


try {

    $shareMode =
        [System.IO.FileShare]::ReadWrite -bor
        [System.IO.FileShare]::Delete


    $stream =
        [System.IO.FileStream]::new(
            $rolloutPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            $shareMode
        )


    $reader =
        [System.IO.StreamReader]::new(
            $stream,
            [System.Text.Encoding]::UTF8,
            $true
        )


    # ========================================================
    # Initial full catch-up
    # ========================================================

    Write-Log (
        "Starting initial rollout catch-up."
    )


    $eventCount =
        0

    $lastProgressWrite =
        Get-Date


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


        $eventCount++


        $elapsed =
            (
                (Get-Date) -
                $lastProgressWrite
            ).TotalSeconds


        if (
            $eventCount % 500 -eq 0 -or
            $elapsed -ge 2
        ) {

            Refresh-ThreadName

            Write-Status


            $lastProgressWrite =
                Get-Date
        }
    }


    Refresh-ThreadName -Force

    Write-Status


    Write-Log (
        "Initial catch-up complete. " +
        "Events=$eventCount"
    )


    # ========================================================
    # Live follow
    # ========================================================

    $nextHeartbeat =
        (Get-Date).AddSeconds(
            $HeartbeatSeconds
        )


    while ($true) {

        $processedAny =
            $false


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


            $processedAny =
                $true
        }


        if ($processedAny) {

            Refresh-ThreadName

            Write-Status
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


    Write-Log (
        "Watch-CodexSession stopped."
    )
}