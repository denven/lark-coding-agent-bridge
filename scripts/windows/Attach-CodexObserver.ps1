param(
    [Parameter(Mandatory = $true)]
    [string]$LaunchId,

    [Parameter(Mandatory = $true)]
    [string]$LaunchTime,

    [Parameter(Mandatory = $true)]
    [string]$Cwd,

    [Parameter(Mandatory = $true)]
    [int]$OwnerPowerShellPid,

    [string]$CodexHome =
        "$HOME\.codex-cli-thirdparty",

    [string]$ObserverScript =
        "$HOME\Scripts\Watch-CodexSession.ps1",

    [string]$ReleaseAgentScript =
        "$HOME\Scripts\Watch-CodexRelease.ps1",

    # This timeout is ONLY for discovering the Codex process.
    # Once the Codex process exists, we keep waiting for its
    # Session/rollout for as long as Codex remains alive.
    [int]$TimeoutSeconds = 60,

    [int]$PollMilliseconds = 400,

    [int]$ProgressLogSeconds = 10,

    [int]$ClaimStaleSeconds = 300
)

$ErrorActionPreference = "Stop"


# ============================================================
# Paths
# ============================================================

$monitorHome =
    "$HOME\.codex-monitor"

$claimDir =
    Join-Path $monitorHome "claims"

$launchDir =
    Join-Path $monitorHome "launches"

$logDir =
    Join-Path $monitorHome "logs"

$launchFile =
    Join-Path `
        $launchDir `
        "$LaunchId.json"

$logFile =
    Join-Path `
        $logDir `
        "attach-$LaunchId.log"


foreach (
    $dir in @(
        $monitorHome,
        $claimDir,
        $launchDir,
        $logDir
    )
) {

    New-Item `
        -ItemType Directory `
        -Path $dir `
        -Force |
        Out-Null
}


# ============================================================
# Logging
# ============================================================

function Write-Log {

    param(
        [string]$Message
    )

    try {

        Add-Content `
            -Path $logFile `
            -Value (
                "$(Get-Date -Format o) $Message"
            ) `
            -Encoding UTF8

    }
    catch {
    }
}


# ============================================================
# JSON helpers
# ============================================================

function Write-JsonNoBom {

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

    [System.IO.File]::WriteAllText(
        $Path,
        $json,
        $utf8
    )
}


function Read-JsonFile {

    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path $Path)) {
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
            )

        $raw =
            $raw.TrimStart(
                [char]0xFEFF
            )

        if (
            [string]::IsNullOrWhiteSpace(
                $raw
            )
        ) {
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


# ============================================================
# Path helpers
# ============================================================

function Normalize-Path {

    param(
        [string]$Path
    )

    if (
        [string]::IsNullOrWhiteSpace(
            $Path
        )
    ) {
        return ""
    }

    try {

        return (
            [System.IO.Path]::GetFullPath(
                $Path
            ).
            TrimEnd("\").
            ToLowerInvariant()
        )

    }
    catch {

        return (
            $Path.
            TrimEnd("\").
            ToLowerInvariant()
        )
    }
}


# ============================================================
# Process helpers
# ============================================================

function Get-CimProcessById {

    param(
        [int]$ProcessId
    )

    return (
        Get-CimInstance `
            Win32_Process `
            -Filter "ProcessId=$ProcessId" `
            -ErrorAction SilentlyContinue
    )
}


function Convert-CreationDateToUtc {

    param(
        [object]$Value
    )

    if ($null -eq $Value) {
        return $null
    }

    try {

        if ($Value -is [datetime]) {

            return (
                ([datetime]$Value).
                ToUniversalTime()
            )
        }

        return (
            [Management.ManagementDateTimeConverter]::
            ToDateTime(
                [string]$Value
            ).
            ToUniversalTime()
        )

    }
    catch {

        return $null
    }
}


function Test-ProcessAlive {

    param(
        [int]$ProcessId
    )

    if ($ProcessId -le 0) {
        return $false
    }

    return (
        $null -ne (
            Get-Process `
                -Id $ProcessId `
                -ErrorAction SilentlyContinue
        )
    )
}


function Test-SameProcess {

    param(
        [int]$ProcessId,

        [datetime]$ExpectedCreatedUtc
    )

    $process =
        Get-CimProcessById `
            -ProcessId $ProcessId

    if (-not $process) {
        return $false
    }

    $actualCreatedUtc =
        Convert-CreationDateToUtc `
            -Value $process.CreationDate

    if (-not $actualCreatedUtc) {
        return $false
    }

    $difference =
        [math]::Abs(
            (
                $actualCreatedUtc -
                $ExpectedCreatedUtc
            ).TotalSeconds
        )

    return (
        $difference -le 2
    )
}


# ============================================================
# Process tree
# ============================================================

function Get-ChildProcessTree {

    param(
        [int]$RootPid
    )

    $all =
        Get-CimInstance `
            Win32_Process `
            -ErrorAction SilentlyContinue

    if (-not $all) {
        return @()
    }

    $result =
        New-Object `
            System.Collections.Generic.List[object]

    $queue =
        New-Object `
            System.Collections.Queue

    $queue.Enqueue(
        [pscustomobject]@{
            Pid   = $RootPid
            Depth = 0
        }
    )

    $visited =
        @{}

    while ($queue.Count -gt 0) {

        $item =
            $queue.Dequeue()

        $parentPid =
            [int]$item.Pid

        if (
            $visited.ContainsKey(
                $parentPid
            )
        ) {
            continue
        }

        $visited[$parentPid] =
            $true

        $children =
            $all |
            Where-Object {
                [int]$_.ParentProcessId -eq
                $parentPid
            }

        foreach ($child in $children) {

            $depth =
                [int]$item.Depth + 1

            $result.Add(
                [pscustomobject]@{
                    Process = $child
                    Depth   = $depth
                }
            )

            $queue.Enqueue(
                [pscustomobject]@{
                    Pid =
                        [int]$child.ProcessId

                    Depth =
                        $depth
                }
            )
        }
    }

    return $result
}


function Find-CodexProcess {

    param(
        [int]$OwnerPid,

        [datetime]$LaunchUtc
    )

    $tree =
        Get-ChildProcessTree `
            -RootPid $OwnerPid

    $candidates =
        @()

    foreach ($entry in $tree) {

        $process =
            $entry.Process

        $name =
            [string]$process.Name

        $commandLine =
            [string]$process.CommandLine


        # Ignore our own helpers.
        if (
            $commandLine -match
            "(?i)Attach-CodexObserver|Watch-CodexSession|Watch-CodexRelease|Request-CodexRelease|Release-CodexSession|Stop-CodexObserver"
        ) {
            continue
        }


        $looksLikeCodex =
            (
                $name -match
                "(?i)^codex(?:\.exe)?$"
            ) -or (
                $commandLine -match
                '(?i)(@openai[\\/]+codex[\\/]|[\\/]codex\.js(?:["\s]|$)|[\\/]codex(?:\.cmd|\.ps1|\.exe)(?:["\s]|$))'
            )


        if (-not $looksLikeCodex) {
            continue
        }


        $createdUtc =
            Convert-CreationDateToUtc `
                -Value $process.CreationDate


        if (-not $createdUtc) {
            continue
        }


        # Do not accidentally attach to an older Codex process.
        if (
            $createdUtc -lt
            $LaunchUtc.AddSeconds(-3)
        ) {
            continue
        }


        $candidates +=
            [pscustomobject]@{

                ProcessId =
                    [int]$process.ProcessId

                ParentProcessId =
                    [int]$process.ParentProcessId

                Name =
                    $name

                CommandLine =
                    $commandLine

                CreatedUtc =
                    $createdUtc

                Depth =
                    [int]$entry.Depth
            }
    }


    if ($candidates.Count -eq 0) {
        return $null
    }


    # Typical:
    #
    # powershell.exe
    # └─ node.exe       <- choose this
    #    └─ codex.exe
    #
    return (
        $candidates |
        Sort-Object `
            Depth,
            CreatedUtc,
            ProcessId |
        Select-Object -First 1
    )
}


function Write-ProcessTreeDebug {

    param(
        [int]$OwnerPid
    )

    $tree =
        Get-ChildProcessTree `
            -RootPid $OwnerPid

    foreach ($entry in $tree) {

        $process =
            $entry.Process

        Write-Log (
            "TREE " +
            "Depth=$($entry.Depth) " +
            "PID=$($process.ProcessId) " +
            "PPID=$($process.ParentProcessId) " +
            "Name=$($process.Name) " +
            "Command=$($process.CommandLine)"
        )
    }
}


# ============================================================
# Tail of a file, as lines
#
# The first line of the window is usually cut mid-way and is
# dropped. A line longer than the whole window yields nothing,
# which callers treat as "no recent event found".
# ============================================================

$RolloutTailBytes =
    4MB


function Read-FileTail {

    param(
        [string]$Path,

        [long]$Bytes
    )

    $stream =
        $null

    try {

        $stream =
            [System.IO.File]::Open(
                $Path,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                # Codex may be appending to the rollout right now.
                [System.IO.FileShare]::ReadWrite
            )

        $start =
            [Math]::Max(
                [long]0,
                $stream.Length - $Bytes
            )

        $length =
            [int]($stream.Length - $start)

        $buffer =
            New-Object byte[] $length

        $null =
            $stream.Seek(
                $start,
                [System.IO.SeekOrigin]::Begin
            )

        $read =
            0

        while ($read -lt $length) {

            $n =
                $stream.Read(
                    $buffer,
                    $read,
                    $length - $read
                )

            if ($n -le 0) {
                break
            }

            $read += $n
        }


        $lines =
            [System.Text.Encoding]::UTF8.GetString(
                $buffer,
                0,
                $read
            ) -split "\r?\n"

        if ($start -gt 0 -and $lines.Count -gt 0) {
            $lines =
                $lines |
                Select-Object -Skip 1
        }

        return ,@($lines)
    }
    catch {

        return ,@()
    }
    finally {

        if ($stream) {
            $stream.Dispose()
        }
    }
}


# ============================================================
# Rollout metadata
#
# session_meta gives us the canonical Session ID.
#
# For resumed sessions, the latest cwd may appear in
# turn_context or thread_settings_applied, so inspect the tail
# as well as session_meta.
# ============================================================

function Get-RolloutMetadata {

    param(
        [string]$RolloutPath
    )

    $sessionId =
        $null

    $cwd =
        $null


    try {

        $head =
            Get-Content `
                -Path $RolloutPath `
                -TotalCount 100 `
                -Encoding UTF8 `
                -ErrorAction Stop


        foreach ($line in $head) {

            # Cheap filter before the (slow) JSON parse.
            if (-not $line.Contains('"session_meta"')) {
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


            if (
                [string]$event.type -ne
                "session_meta"
            ) {
                continue
            }


            if ($event.payload.session_id) {

                $sessionId =
                    [string]$event.payload.session_id

            }
            elseif ($event.payload.id) {

                $sessionId =
                    [string]$event.payload.id
            }


            if ($event.payload.cwd) {

                $cwd =
                    [string]$event.payload.cwd
            }


            break
        }


        if (-not $sessionId) {
            return $null
        }


        # Inspect recent events for the latest cwd.
        #
        # Read a byte window from the end instead of
        # `Get-Content -Tail`: on a large rollout with
        # megabyte-long lines, -Tail in Windows PowerShell 5.1
        # ran for minutes (measured on a 64 MB rollout). Only
        # small turn_context / thread_settings lines are parsed;
        # ConvertFrom-Json on the huge lines is slow as well.
        $tail =
            Read-FileTail `
                -Path $RolloutPath `
                -Bytes $RolloutTailBytes


        foreach ($line in $tail) {

            if (
                -not $line.Contains('"turn_context"') -and
                -not $line.Contains('"thread_settings"')
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


            if (
                [string]$event.type -eq
                "turn_context"
            ) {

                if ($event.payload.cwd) {
                    $cwd =
                        [string]$event.payload.cwd
                }
            }


            if (
                [string]$event.type -eq
                "event_msg" -and
                $event.payload.thread_settings
            ) {

                if (
                    $event.payload.
                    thread_settings.cwd
                ) {

                    $cwd =
                        [string]$event.payload.
                        thread_settings.cwd
                }
            }
        }


        return (
            [pscustomobject]@{

                SessionId =
                    $sessionId

                Cwd =
                    $cwd
            }
        )

    }
    catch {

        return $null
    }
}


# ============================================================
# Resume target
#
# `codex resume <id|name>` reopens an EXISTING rollout and
# writes nothing to it until the first prompt. The activity
# scan in Phase 2 (rollouts written after launch) therefore
# cannot see a resumed Session for as long as the user only
# looks at the TUI — and never, if they leave it idle.
#
# The command line already names the Session, so resolve it
# directly. Anything ambiguous returns $null and Phase 2 keeps
# its original activity matching: attaching the Observer to
# the wrong Session would let a later handoff terminate this
# Codex while binding a different Session to Lark.
# ============================================================

$sessionIdPattern =
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'


function Split-CommandLine {

    param(
        [string]$CommandLine
    )

    # Double-quoted segments stay whole: thread names may
    # contain spaces.
    $tokens =
        @()

    foreach (
        $match in [regex]::Matches(
            [string]$CommandLine,
            '"([^"]*)"|(\S+)'
        )
    ) {

        if ($match.Groups[1].Success) {
            $tokens += $match.Groups[1].Value
        }
        else {
            $tokens += $match.Groups[2].Value
        }
    }

    return ,$tokens
}


function Get-ResumeSelectors {

    param(
        [string]$CommandLine
    )

    $tokens =
        Split-CommandLine `
            -CommandLine $CommandLine


    # Only a `resume` after the Codex entry point is the
    # subcommand; node.exe's own arguments come before it.
    $codexIndex =
        -1

    for ($i = 0; $i -lt $tokens.Count; $i++) {

        if (
            $tokens[$i] -match
            '(?i)(^|[\\/])codex(\.js|\.exe|\.cmd)?$'
        ) {
            $codexIndex = $i
            break
        }
    }

    if ($codexIndex -lt 0) {
        return @()
    }


    $resumeIndex =
        -1

    for ($i = $codexIndex + 1; $i -lt $tokens.Count; $i++) {

        if ($tokens[$i] -ieq "resume") {
            $resumeIndex = $i
            break
        }
    }

    # Also covers a bare `resume` (interactive picker): nothing
    # follows it.
    if (
        $resumeIndex -lt 0 -or
        $resumeIndex -ge ($tokens.Count - 1)
    ) {
        return @()
    }


    # Positional tokens only. A flag's value (e.g. a model name)
    # may still slip through; it just fails to resolve and the
    # next token is tried.
    return @(
        $tokens[($resumeIndex + 1)..($tokens.Count - 1)] |
        Where-Object {
            $_ -and
            -not $_.StartsWith("-")
        }
    )
}


function Find-RolloutById {

    param(
        [string]$SessionId
    )

    return (
        Get-ChildItem `
            $sessionRoot `
            -Recurse `
            -Filter "rollout-*$SessionId.jsonl" `
            -File `
            -ErrorAction SilentlyContinue |
        Sort-Object `
            LastWriteTimeUtc `
            -Descending |
        Select-Object -First 1
    )
}


function Find-SessionIdsByThreadName {

    param(
        [string]$ThreadName
    )

    $indexPath =
        Join-Path `
            $CodexHome `
            "session_index.jsonl"

    if (-not (Test-Path $indexPath)) {
        return @()
    }


    # Append-only log: each Session's LATEST record carries its
    # current name (renames append a new line).
    $latest =
        @{}

    $order =
        0

    foreach (
        $line in [System.IO.File]::ReadLines(
            $indexPath,
            [System.Text.Encoding]::UTF8
        )
    ) {

        $order++

        try {
            $record =
                $line |
                ConvertFrom-Json
        }
        catch {
            continue
        }

        if (-not $record.id) {
            continue
        }


        $at =
            [datetimeoffset]::MinValue

        try {
            $at =
                [datetimeoffset]::Parse(
                    [string]$record.updated_at
                )
        }
        catch {
        }


        $id =
            [string]$record.id

        $previous =
            $latest[$id]

        if (
            -not $previous -or
            $at -gt $previous.At -or
            (
                $at -eq $previous.At -and
                $order -gt $previous.Order
            )
        ) {

            $latest[$id] =
                [pscustomobject]@{
                    Name  = [string]$record.thread_name
                    At    = $at
                    Order = $order
                }
        }
    }


    $wanted =
        $ThreadName.Trim()

    return @(
        $latest.GetEnumerator() |
        Where-Object {
            $_.Value.Name -and
            $_.Value.Name.Trim() -ieq $wanted
        } |
        ForEach-Object {
            $_.Key
        }
    )
}


function Resolve-ResumeTarget {

    param(
        [string]$CommandLine
    )

    foreach (
        $selector in (
            Get-ResumeSelectors `
                -CommandLine $CommandLine
        )
    ) {

        if ($selector -match $sessionIdPattern) {

            $sessionId =
                $selector.ToLowerInvariant()

            $via =
                "Session ID"
        }
        else {

            $ids =
                @(
                    Find-SessionIdsByThreadName `
                        -ThreadName $selector
                )

            if ($ids.Count -eq 0) {
                continue
            }

            # Which of several same-named Sessions Codex picked
            # cannot be known from here, so do not guess.
            if ($ids.Count -gt 1) {

                Write-Log (
                    "Resume thread name '$selector' matches " +
                    "$($ids.Count) Sessions; falling back to activity matching."
                )

                return $null
            }

            $sessionId =
                $ids[0]

            $via =
                "thread name '$selector'"
        }


        $file =
            Find-RolloutById `
                -SessionId $sessionId

        if (-not $file) {

            Write-Log (
                "Resume target $sessionId ($via) has no rollout file; " +
                "falling back to activity matching."
            )

            return $null
        }


        $meta =
            Get-RolloutMetadata `
                -RolloutPath $file.FullName

        if (-not $meta) {
            return $null
        }


        # Keep Phase 2's cwd rule: the Session must belong to the
        # directory this codex3 was started in.
        if (
            (Normalize-Path $meta.Cwd) -ne
            $targetCwd
        ) {

            Write-Log (
                "Resume target $sessionId ($via) belongs to " +
                "$($meta.Cwd), not this directory; falling back to activity matching."
            )

            return $null
        }


        Write-Log (
            "Resume target from command line ($via): " +
            $meta.SessionId
        )

        return (
            [pscustomobject]@{
                File = $file
                Meta = $meta
            }
        )
    }

    return $null
}


# ============================================================
# Observer health
# ============================================================

function Test-FreshObserver {

    param(
        [string]$SessionId
    )

    $statusFile =
        Join-Path `
            $monitorHome `
            "status-$SessionId.json"

    $status =
        Read-JsonFile `
            -Path $statusFile

    if (-not $status) {
        return $false
    }


    if (
        [string]$status.observerState -ne
        "Running"
    ) {
        return $false
    }


    if (
        -not $status.observerUpdatedAt
    ) {
        return $false
    }


    try {

        $updated =
            [datetimeoffset]::Parse(
                [string]$status.observerUpdatedAt
            )

    }
    catch {

        return $false
    }


    $age =
        (
            [datetimeoffset]::Now -
            $updated
        ).TotalSeconds


    if ($age -gt 20) {
        return $false
    }


    if ($status.observerPid) {

        if (
            -not (
                Test-ProcessAlive `
                    -ProcessId (
                        [int]$status.observerPid
                    )
            )
        ) {
            return $false
        }
    }


    return $true
}


# ============================================================
# Claim
# ============================================================

function Try-ClaimSession {

    param(
        [string]$SessionId,

        [string]$CurrentLaunchId,

        [int]$CurrentOwnerPid,

        [int]$CurrentCodexPid
    )

    $claimPath =
        Join-Path `
            $claimDir `
            "$SessionId.claim"


    if (
        Test-FreshObserver `
            -SessionId $SessionId
    ) {
        return $false
    }


    if (Test-Path $claimPath) {

        $existing =
            Read-JsonFile `
                -Path $claimPath

        $claimAge =
            [double]::PositiveInfinity


        try {

            $claimInfo =
                Get-Item `
                    $claimPath `
                    -ErrorAction Stop

            $claimAge =
                (
                    (Get-Date).ToUniversalTime() -
                    $claimInfo.LastWriteTimeUtc
                ).TotalSeconds

        }
        catch {
        }


        if (
            $existing -and
            [string]$existing.launchId -eq
            $CurrentLaunchId
        ) {
            return $true
        }


        # A different live launch owns this Session.
        if ($existing) {

            foreach (
                $pidValue in @(
                    $existing.observerPid,
                    $existing.codexRootPid,
                    $existing.ownerPowerShellPid
                )
            ) {

                if (-not $pidValue) {
                    continue
                }

                if (
                    Test-ProcessAlive `
                        -ProcessId ([int]$pidValue)
                ) {
                    return $false
                }
            }
        }


        if (
            $claimAge -lt
            $ClaimStaleSeconds
        ) {
            return $false
        }


        Write-Log (
            "Removing stale claim: " +
            "Session=$SessionId " +
            "Age=" +
            [math]::Round(
                $claimAge,
                1
            ) +
            "s"
        )


        Remove-Item `
            $claimPath `
            -Force `
            -ErrorAction SilentlyContinue
    }


    try {

        $stream =
            [System.IO.File]::Open(
                $claimPath,
                [System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None
            )

        $stream.Close()

    }
    catch {

        return $false
    }


    $claim =
        [ordered]@{

            version =
                4

            launchId =
                $CurrentLaunchId

            sessionId =
                $SessionId

            ownerPowerShellPid =
                $CurrentOwnerPid

            codexRootPid =
                $CurrentCodexPid

            claimedAt =
                (Get-Date).ToString("o")
        }


    try {

        Write-JsonNoBom `
            -Path $claimPath `
            -Value $claim

    }
    catch {

        Remove-Item `
            $claimPath `
            -Force `
            -ErrorAction SilentlyContinue

        return $false
    }


    return $true
}


# ============================================================
# Validation
# ============================================================

if (-not (Test-Path $ObserverScript)) {

    Write-Log (
        "Observer script not found: " +
        $ObserverScript
    )

    exit 1
}


if (-not (Test-Path $ReleaseAgentScript)) {

    Write-Log (
        "Release Agent script not found: " +
        $ReleaseAgentScript
    )

    exit 1
}


$sessionRoot =
    Join-Path `
        $CodexHome `
        "sessions"


if (-not (Test-Path $sessionRoot)) {

    Write-Log (
        "Session root not found: " +
        $sessionRoot
    )

    exit 1
}


try {

    $launch =
        [datetimeoffset]::Parse(
            $LaunchTime
        )

}
catch {

    Write-Log (
        "Invalid LaunchTime: " +
        $LaunchTime
    )

    exit 1
}


$launchUtc =
    $launch.UtcDateTime

$targetCwd =
    Normalize-Path `
        $Cwd


Write-Log "============================================================"
Write-Log "Attach-CodexObserver started"
Write-Log "LaunchId=$LaunchId"
Write-Log "OwnerPowerShellPid=$OwnerPowerShellPid"
Write-Log "CWD=$Cwd"
Write-Log "NormalizedCWD=$targetCwd"
Write-Log "CODEX_HOME=$CodexHome"
Write-Log "SessionRoot=$sessionRoot"
Write-Log "LaunchUtc=$($launchUtc.ToString("o"))"


# ============================================================
# Phase 1
#
# Wait for the Codex process.
#
# This phase has a finite timeout because if Codex itself
# failed to start there is nothing useful to monitor.
# ============================================================

Write-Log "Waiting for Codex process..."


$processDeadline =
    (Get-Date).AddSeconds(
        $TimeoutSeconds
    )

$nextProgressLog =
    (Get-Date).AddSeconds(
        $ProgressLogSeconds
    )

$processTreeLogged =
    $false

$codexProcess =
    $null


while (
    (Get-Date) -lt
    $processDeadline
) {

    if (
        -not (
            Test-ProcessAlive `
                -ProcessId $OwnerPowerShellPid
        )
    ) {

        Write-Log (
            "Owner PowerShell exited before Codex was discovered."
        )

        exit 0
    }


    $codexProcess =
        Find-CodexProcess `
            -OwnerPid $OwnerPowerShellPid `
            -LaunchUtc $launchUtc


    if ($codexProcess) {
        break
    }


    if (
        (Get-Date) -ge
        $nextProgressLog
    ) {

        Write-Log (
            "Still waiting for Codex process..."
        )


        if (-not $processTreeLogged) {

            Write-ProcessTreeDebug `
                -OwnerPid $OwnerPowerShellPid

            $processTreeLogged =
                $true
        }


        $nextProgressLog =
            (Get-Date).AddSeconds(
                $ProgressLogSeconds
            )
    }


    Start-Sleep `
        -Milliseconds $PollMilliseconds
}


if (-not $codexProcess) {

    Write-Log (
        "Timed out waiting for Codex process."
    )

    exit 2
}


Write-Log (
    "Codex process discovered: " +
    "PID=$($codexProcess.ProcessId) " +
    "ParentPID=$($codexProcess.ParentProcessId) " +
    "Depth=$($codexProcess.Depth) " +
    "Name=$($codexProcess.Name)"
)

Write-Log (
    "Codex command: " +
    $codexProcess.CommandLine
)


# ============================================================
# Phase 2
#
# Wait for the Session/rollout.
#
# IMPORTANT:
#
# There is intentionally NO fixed timeout here.
#
# Codex may be started and sit at the TUI for many minutes
# before the first prompt causes the rollout to become
# discoverable.
#
# We continue waiting for as long as THIS Codex process and
# its owner PowerShell are still alive.
# ============================================================

Write-Log (
    "Codex process found. Waiting for matching Session/rollout."
)

# Resolved once: the command line cannot change.
$resumeTarget =
    Resolve-ResumeTarget `
        -CommandLine $codexProcess.CommandLine

$claimRefusedLogged =
    $false

$nextProgressLog =
    (Get-Date).AddSeconds(
        $ProgressLogSeconds
    )


while ($true) {


    # --------------------------------------------------------
    # Owner PowerShell gone
    # --------------------------------------------------------

    if (
        -not (
            Test-ProcessAlive `
                -ProcessId $OwnerPowerShellPid
        )
    ) {

        Write-Log (
            "Owner PowerShell exited while waiting for Session."
        )

        exit 0
    }


    # --------------------------------------------------------
    # Codex gone / PID reused
    # --------------------------------------------------------

    if (
        -not (
            Test-SameProcess `
                -ProcessId $codexProcess.ProcessId `
                -ExpectedCreatedUtc $codexProcess.CreatedUtc
        )
    ) {

        Write-Log (
            "Codex process exited or PID changed while waiting for Session."
        )

        exit 0
    }


    # --------------------------------------------------------
    # Candidate rollout files
    #
    # When the command line named the Session, it is the ONLY
    # candidate: never fall back to some other rollout that
    # happens to be active in the same directory.
    #
    # Otherwise, a resumed Session may use an older rollout
    # file, but its LastWriteTimeUtc will move forward when
    # Codex writes new activity. Therefore filter on
    # LastWriteTimeUtc rather than creation time.
    # --------------------------------------------------------

    if ($resumeTarget) {

        $candidates =
            @($resumeTarget.File)
    }
    else {

        $candidates =
            Get-ChildItem `
                $sessionRoot `
                -Recurse `
                -Filter "rollout-*.jsonl" `
                -File `
                -ErrorAction SilentlyContinue |
            Where-Object {

                $_.LastWriteTimeUtc -ge
                $launchUtc.AddSeconds(-5)

            } |
            Sort-Object `
                LastWriteTimeUtc `
                -Descending
    }


    foreach ($file in $candidates) {

        # A resume target's metadata is already known; re-reading
        # a large rollout every poll would be wasted work.
        $meta =
            if ($resumeTarget) {
                $resumeTarget.Meta
            }
            else {
                Get-RolloutMetadata `
                    -RolloutPath $file.FullName
            }


        if (-not $meta) {
            continue
        }


        $sessionCwd =
            Normalize-Path `
                $meta.Cwd


        if (
            $sessionCwd -ne
            $targetCwd
        ) {
            continue
        }


        $sessionId =
            [string]$meta.SessionId


        if (
            [string]::IsNullOrWhiteSpace(
                $sessionId
            )
        ) {
            continue
        }


        $claimed =
            Try-ClaimSession `
                -SessionId $sessionId `
                -CurrentLaunchId $LaunchId `
                -CurrentOwnerPid $OwnerPowerShellPid `
                -CurrentCodexPid $codexProcess.ProcessId


        if (-not $claimed) {

            # Otherwise this loop would wait silently: say why once.
            if (
                $resumeTarget -and
                -not $claimRefusedLogged
            ) {

                Write-Log (
                    "Session $sessionId is held by a live launch or a " +
                    "running Observer; waiting for it to be released."
                )

                $claimRefusedLogged =
                    $true
            }

            continue
        }


        Write-Log (
            "Claimed Session " +
            $sessionId
        )


        # ====================================================
        # Start Observer
        # ====================================================

        # CodexPid / CodexCreatedUtc / LaunchId let the Observer exit
        # by itself when this Codex dies without codex3's cleanup
        # (e.g. the terminal closed with the X button).
        $observerArgs =
            "-NoProfile " +
            "-ExecutionPolicy Bypass " +
            "-File `"$ObserverScript`" " +
            "-SessionId `"$sessionId`" " +
            "-CodexHome `"$CodexHome`" " +
            "-MonitorHome `"$monitorHome`" " +
            "-CodexPid $($codexProcess.ProcessId) " +
            "-CodexCreatedUtc `"$($codexProcess.CreatedUtc.ToString("o"))`" " +
            "-LaunchId `"$LaunchId`""


        try {

            $observer =
                Start-Process `
                    -FilePath "powershell.exe" `
                    -ArgumentList $observerArgs `
                    -WindowStyle Hidden `
                    -PassThru

        }
        catch {

            Write-Log (
                "Failed to start Observer: " +
                $_.Exception.Message
            )


            Remove-Item `
                (Join-Path `
                    $claimDir `
                    "$sessionId.claim"
                ) `
                -Force `
                -ErrorAction SilentlyContinue


            exit 3
        }


        Write-Log (
            "Observer PID=" +
            $observer.Id
        )


        # ----------------------------------------------------
        # Verify Observer survives startup and creates status.
        # ----------------------------------------------------

        $observerStatusPath =
            Join-Path `
                $monitorHome `
                "status-$sessionId.json"


        $observerReady =
            $false


        $observerDeadline =
            (Get-Date).AddSeconds(5)


        while (
            (Get-Date) -lt
            $observerDeadline
        ) {

            $observerAlive =
                Test-ProcessAlive `
                    -ProcessId $observer.Id


            if (-not $observerAlive) {
                break
            }


            if (
                Test-Path $observerStatusPath
            ) {

                $observerReady =
                    $true

                break
            }


            Start-Sleep `
                -Milliseconds 200
        }


        if (-not $observerReady) {

            Write-Log (
                "Observer failed startup verification. " +
                "PID=$($observer.Id) " +
                "StatusExists=$(Test-Path $observerStatusPath)"
            )


            Stop-Process `
                -Id $observer.Id `
                -Force `
                -ErrorAction SilentlyContinue


            Remove-Item `
                (Join-Path `
                    $claimDir `
                    "$sessionId.claim"
                ) `
                -Force `
                -ErrorAction SilentlyContinue


            exit 4
        }


        # ====================================================
        # Start Local Release Agent
        # ====================================================

        $releaseAgentArgs =
            "-NoProfile " +
            "-ExecutionPolicy Bypass " +
            "-File `"$ReleaseAgentScript`" " +
            "-SessionId `"$sessionId`" " +
            "-CodexRootPid `"$($codexProcess.ProcessId)`" " +
            "-MonitorHome `"$monitorHome`""


        try {

            $releaseAgent =
                Start-Process `
                    -FilePath "powershell.exe" `
                    -ArgumentList $releaseAgentArgs `
                    -WindowStyle Hidden `
                    -PassThru

        }
        catch {

            Write-Log (
                "Failed to start Release Agent: " +
                $_.Exception.Message
            )


            Stop-Process `
                -Id $observer.Id `
                -Force `
                -ErrorAction SilentlyContinue


            Remove-Item `
                (Join-Path `
                    $claimDir `
                    "$sessionId.claim"
                ) `
                -Force `
                -ErrorAction SilentlyContinue


            exit 5
        }


        Write-Log (
            "Release Agent PID=" +
            $releaseAgent.Id
        )


        # ====================================================
        # Launch mapping
        # ====================================================

        $record =
            [ordered]@{

                version =
                    4

                launchId =
                    $LaunchId

                sessionId =
                    $sessionId

                cwd =
                    $Cwd

                codexHome =
                    $CodexHome

                ownerPowerShellPid =
                    $OwnerPowerShellPid

                codexRootPid =
                    $codexProcess.ProcessId

                codexRootParentPid =
                    $codexProcess.ParentProcessId

                codexRootName =
                    $codexProcess.Name

                codexRootCommandLine =
                    $codexProcess.CommandLine

                codexRootCreatedAt =
                    $codexProcess.CreatedUtc.
                    ToString("o")

                rolloutPath =
                    $file.FullName

                observerPid =
                    $observer.Id

                releaseAgentPid =
                    $releaseAgent.Id

                attachedAt =
                    (Get-Date).ToString("o")
            }


        try {

            Write-JsonNoBom `
                -Path $launchFile `
                -Value $record

        }
        catch {

            Write-Log (
                "Failed writing launch mapping: " +
                $_.Exception.Message
            )


            Stop-Process `
                -Id $releaseAgent.Id `
                -Force `
                -ErrorAction SilentlyContinue

            Stop-Process `
                -Id $observer.Id `
                -Force `
                -ErrorAction SilentlyContinue

            Remove-Item `
                (Join-Path `
                    $claimDir `
                    "$sessionId.claim"
                ) `
                -Force `
                -ErrorAction SilentlyContinue


            exit 6
        }


        # ====================================================
        # Update claim with active process IDs
        # ====================================================

        $claimRecord =
            [ordered]@{

                version =
                    4

                launchId =
                    $LaunchId

                sessionId =
                    $sessionId

                ownerPowerShellPid =
                    $OwnerPowerShellPid

                codexRootPid =
                    $codexProcess.ProcessId

                observerPid =
                    $observer.Id

                releaseAgentPid =
                    $releaseAgent.Id

                claimedAt =
                    (Get-Date).ToString("o")
            }


        try {

            Write-JsonNoBom `
                -Path (
                    Join-Path `
                        $claimDir `
                        "$sessionId.claim"
                ) `
                -Value $claimRecord

        }
        catch {

            Write-Log (
                "Warning: unable to update claim record: " +
                $_.Exception.Message
            )
        }


        Write-Log (
            "Launch mapping written: " +
            $launchFile
        )

        Write-Log (
            "Attach completed."
        )


        exit 0
    }


    # --------------------------------------------------------
    # Progress
    # --------------------------------------------------------

    if (
        (Get-Date) -ge
        $nextProgressLog
    ) {

        Write-Log (
            "Codex PID=$($codexProcess.ProcessId) is alive; " +
            "still waiting for matching rollout Session..."
        )


        $nextProgressLog =
            (Get-Date).AddSeconds(
                $ProgressLogSeconds
            )
    }


    Start-Sleep `
        -Milliseconds $PollMilliseconds
}