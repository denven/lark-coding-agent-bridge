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

    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"


# ============================================================
# Configuration / Paths
# ============================================================

$monitorHome =
    "$HOME\.codex-monitor"

$claimDir =
    Join-Path $monitorHome "claims"

$launchDir =
    Join-Path $monitorHome "launches"

$logDir =
    Join-Path $monitorHome "logs"


# A claim younger than this is treated as active.
$ClaimStaleSeconds =
    [Math]::Max(
        $TimeoutSeconds + 30,
        150
    )


New-Item `
    -ItemType Directory `
    -Path $monitorHome `
    -Force |
    Out-Null

New-Item `
    -ItemType Directory `
    -Path $claimDir `
    -Force |
    Out-Null

New-Item `
    -ItemType Directory `
    -Path $launchDir `
    -Force |
    Out-Null

New-Item `
    -ItemType Directory `
    -Path $logDir `
    -Force |
    Out-Null


$logFile =
    Join-Path `
        $logDir `
        "attach-$LaunchId.log"


$launchFile =
    Join-Path `
        $launchDir `
        "$LaunchId.json"


# ============================================================
# Logging
# ============================================================

function Write-Log {

    param(
        [string]$Message
    )

    $line =
        "$(Get-Date -Format o) $Message"

    Add-Content `
        -Path $logFile `
        -Value $line `
        -Encoding UTF8
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
        ConvertTo-Json -Depth 20

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

        $raw =
            [System.IO.File]::ReadAllText(
                $Path
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

    if (-not $Path) {
        return ""
    }

    try {

        return (
            [System.IO.Path]::GetFullPath(
                $Path
            )
        ).
        TrimEnd("\").
        ToLowerInvariant()
    }
    catch {

        return $Path.
            TrimEnd("\").
            ToLowerInvariant()
    }
}


# ============================================================
# Process helpers
# ============================================================

function Test-ProcessAlive {

    param(
        [int]$ProcessId
    )

    if (-not $ProcessId) {
        return $false
    }

    $process =
        Get-Process `
            -Id $ProcessId `
            -ErrorAction SilentlyContinue

    return (
        $null -ne $process
    )
}


# ============================================================
# Convert Win32_Process CreationDate safely
#
# Get-CimInstance normally returns System.DateTime.
# Older WMI-style data may still return DMTF text.
# ============================================================

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


# ============================================================
# Read Codex Session metadata from rollout JSONL
# ============================================================

function Get-SessionMetadata {

    param(
        [Parameter(Mandatory = $true)]
        [string]$RolloutPath
    )

    try {

        $lines =
            Get-Content `
                -Path $RolloutPath `
                -TotalCount 50 `
                -ErrorAction Stop

        foreach ($line in $lines) {

            try {

                $event =
                    $line |
                    ConvertFrom-Json

            }
            catch {

                continue
            }

            if (
                $event.type -ne
                "session_meta"
            ) {
                continue
            }


            $sessionId =
                $null


            if ($event.payload.id) {

                $sessionId =
                    [string]$event.payload.id

            }
            elseif (
                $event.payload.session_id
            ) {

                $sessionId =
                    [string]$event.payload.session_id
            }


            if (-not $sessionId) {
                continue
            }


            return (
                [pscustomobject]@{

                    SessionId =
                        $sessionId

                    Cwd =
                        [string]$event.payload.cwd
                }
            )
        }
    }
    catch {

        Write-Log (
            "Failed reading rollout metadata: " +
            "$RolloutPath : " +
            $_.Exception.Message
        )
    }

    return $null
}


# ============================================================
# Get descendants of the PowerShell running codex3
#
# Output:
#   Process = Win32_Process
#   Depth   = distance from owner PowerShell
# ============================================================

function Get-ChildProcessTree {

    param(
        [Parameter(Mandatory = $true)]
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


    $visited = @{}


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

                    Process =
                        $child

                    Depth =
                        $depth
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


# ============================================================
# Find Codex process belonging to THIS codex3 invocation
#
# Typical Windows layout:
#
# powershell.exe
#   └─ node.exe          <- codexRootPid
#       └─ codex.exe
# ============================================================

function Find-CodexProcess {

    param(
        [Parameter(Mandatory = $true)]
        [int]$OwnerPid,

        [Parameter(Mandatory = $true)]
        [datetime]$LaunchUtc
    )


    $tree =
        Get-ChildProcessTree `
            -RootPid $OwnerPid


    if (-not $tree) {
        return $null
    }


    $candidates =
        @()


    foreach ($entry in $tree) {

        $process =
            $entry.Process


        $commandLine =
            [string]$process.CommandLine


        $processName =
            [string]$process.Name


        # ----------------------------------------------------
        # Ignore Observer / detector / release helper processes
        # ----------------------------------------------------

        if (
            $commandLine -match
            "(?i)Attach-CodexObserver|Watch-CodexSession|Watch-CodexRelease|Request-CodexRelease|Release-CodexSession|Stop-CodexObserver"
        ) {
            continue
        }


        # ----------------------------------------------------
        # Detect Codex CLI
        # ----------------------------------------------------

        $nameLooksLikeCodex =
            $processName -match
            "(?i)^codex(?:\.exe)?$"


        $commandLooksLikeCodex =
            $commandLine -match
            '(?i)(@openai[\\/]+codex[\\/]|[\\/]codex\.js(?:["\s]|$)|[\\/]codex(?:\.cmd|\.ps1|\.exe)(?:["\s]|$))'


        if (
            -not $nameLooksLikeCodex -and
            -not $commandLooksLikeCodex
        ) {
            continue
        }


        # ----------------------------------------------------
        # CreationDate compatibility
        # ----------------------------------------------------

        $createdUtc =
            Convert-CreationDateToUtc `
                -Value $process.CreationDate


        if (-not $createdUtc) {

            Write-Log (
                "Could not parse CreationDate: " +
                "PID=$($process.ProcessId) " +
                "Name=$processName " +
                "Value=$($process.CreationDate)"
            )

            continue
        }


        # ----------------------------------------------------
        # Avoid selecting an older Codex process
        # ----------------------------------------------------

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
                    $processName

                CommandLine =
                    $commandLine

                CreatedUtc =
                    $createdUtc

                Depth =
                    [int]$entry.Depth
            }
    }


    if (-not $candidates) {
        return $null
    }


    # Prefer the Codex process closest to owner PowerShell.
    #
    # With:
    #
    # powershell
    #   └─ node.exe
    #       └─ codex.exe
    #
    # node.exe is selected.
    return (
        $candidates |
        Sort-Object `
            Depth,
            CreatedUtc,
            ProcessId |
        Select-Object -First 1
    )
}


# ============================================================
# Diagnostic process-tree logging
# ============================================================

function Write-ProcessTreeDebug {

    param(
        [Parameter(Mandatory = $true)]
        [int]$OwnerPid
    )

    $tree =
        Get-ChildProcessTree `
            -RootPid $OwnerPid


    if (-not $tree) {

        Write-Log (
            "Process tree for owner PID " +
            "$OwnerPid is empty."
        )

        return
    }


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
# Check whether Session already has healthy Observer
# ============================================================

function Test-FreshObserver {

    param(
        [Parameter(Mandatory = $true)]
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
        $status.observerState -ne
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
# Atomically claim a Session
#
# Critical for multiple codex3 terminals.
# ============================================================

function Try-ClaimSession {

    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,

        [Parameter(Mandatory = $true)]
        [string]$CurrentLaunchId,

        [Parameter(Mandatory = $true)]
        [int]$CurrentOwnerPid
    )


    $claimPath =
        Join-Path `
            $claimDir `
            "$SessionId.claim"


    # --------------------------------------------------------
    # Healthy Observer means Session is already owned
    # --------------------------------------------------------

    if (
        Test-FreshObserver `
            -SessionId $SessionId
    ) {
        return $false
    }


    # --------------------------------------------------------
    # Existing claim handling
    # --------------------------------------------------------

    if (Test-Path $claimPath) {

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


            $existingClaim =
                Read-JsonFile `
                    -Path $claimPath


            # Already belongs to this detector
            if (
                $existingClaim -and
                $existingClaim.launchId -eq
                $CurrentLaunchId
            ) {

                return $true
            }


            # Existing Observer is still alive
            if (
                $existingClaim -and
                $existingClaim.observerPid
            ) {

                if (
                    Test-ProcessAlive `
                        -ProcessId (
                            [int]$existingClaim.observerPid
                        )
                ) {
                    return $false
                }
            }


            # Existing Release Agent is still alive
            if (
                $existingClaim -and
                $existingClaim.releaseAgentPid
            ) {

                if (
                    Test-ProcessAlive `
                        -ProcessId (
                            [int]$existingClaim.releaseAgentPid
                        )
                ) {
                    return $false
                }
            }


            # Fresh claim from another detector
            if (
                $claimAge -lt
                $ClaimStaleSeconds
            ) {
                return $false
            }


            # Stale claim
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
                -ErrorAction Stop

        }
        catch {

            Write-Log (
                "Unable to inspect/remove claim " +
                "$claimPath : " +
                $_.Exception.Message
            )

            return $false
        }
    }


    # --------------------------------------------------------
    # Atomic file creation
    # --------------------------------------------------------

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


    $claimRecord =
        [ordered]@{

            version =
                3

            launchId =
                $CurrentLaunchId

            sessionId =
                $SessionId

            ownerPowerShellPid =
                $CurrentOwnerPid

            claimedAt =
                (Get-Date).ToString("o")
        }


    try {

        Write-JsonNoBom `
            -Path $claimPath `
            -Value $claimRecord

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


$owner =
    Get-Process `
        -Id $OwnerPowerShellPid `
        -ErrorAction SilentlyContinue


if (-not $owner) {

    Write-Log (
        "Owner PowerShell PID " +
        "$OwnerPowerShellPid does not exist."
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


$targetCwd =
    Normalize-Path $Cwd


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


$deadline =
    (Get-Date).AddSeconds(
        $TimeoutSeconds
    )


$nextProgressLog =
    (Get-Date).AddSeconds(10)


$processTreeLogged =
    $false


Write-Log "============================================================"
Write-Log "Attach-CodexObserver started"
Write-Log "LaunchId=$LaunchId"
Write-Log "OwnerPowerShellPid=$OwnerPowerShellPid"
Write-Log "CWD=$Cwd"
Write-Log "NormalizedCWD=$targetCwd"
Write-Log "CODEX_HOME=$CodexHome"
Write-Log "SessionRoot=$sessionRoot"
Write-Log "LaunchUtc=$($launchUtc.ToString("o"))"
Write-Log "Waiting for Codex process + Session..."


# ============================================================
# Discovery loop
# ============================================================

$codexProcess =
    $null


while ((Get-Date) -lt $deadline) {


    # ========================================================
    # 1. Discover Codex process
    # ========================================================

    if (-not $codexProcess) {

        $codexProcess =
            Find-CodexProcess `
                -OwnerPid $OwnerPowerShellPid `
                -LaunchUtc $launchUtc


        if ($codexProcess) {

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
        }
    }


    # --------------------------------------------------------
    # Do NOT claim Session until Codex PID is known
    # --------------------------------------------------------

    if (-not $codexProcess) {

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
                (Get-Date).AddSeconds(10)
        }


        Start-Sleep `
            -Milliseconds 400

        continue
    }


    # ========================================================
    # 2. Discover rollout / Session
    # ========================================================

    $candidates =
        Get-ChildItem `
            $sessionRoot `
            -Recurse `
            -Filter "rollout-*.jsonl" `
            -File `
            -ErrorAction SilentlyContinue |
        Where-Object {

            $_.LastWriteTimeUtc -ge
                $launchUtc.AddSeconds(-3)

        } |
        Sort-Object `
            LastWriteTimeUtc `
            -Descending


    foreach ($file in $candidates) {


        $meta =
            Get-SessionMetadata `
                -RolloutPath $file.FullName


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
            $meta.SessionId


        # ====================================================
        # 3. Claim Session
        # ====================================================

        $claimed =
            Try-ClaimSession `
                -SessionId $sessionId `
                -CurrentLaunchId $LaunchId `
                -CurrentOwnerPid $OwnerPowerShellPid


        if (-not $claimed) {
            continue
        }


        Write-Log (
            "Claimed Session " +
            $sessionId
        )


        # ====================================================
        # 4. Start Observer
        # ====================================================

        $observerArgs =
            "-NoProfile " +
            "-ExecutionPolicy Bypass " +
            "-File `"$ObserverScript`" " +
            "-SessionId `"$sessionId`" " +
            "-CodexHome `"$CodexHome`""


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


            exit 1
        }


        Write-Log (
            "Observer PID=" +
            $observer.Id
        )


        # ====================================================
        # 5. Start Local Release Agent
        #
        # This Agent runs under the same Windows security
        # context as codex3 and the local Codex process.
        # ====================================================

        $releaseAgent =
            $null


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


            exit 1
        }


        Write-Log (
            "Release Agent PID=" +
            $releaseAgent.Id
        )


        # ====================================================
        # 6. Persist complete mapping
        #
        # Terminal PowerShell
        #        ↓
        # Codex root process
        #        ↓
        # Session
        #        ↓
        # Observer
        #        ↓
        # Release Agent
        # ====================================================

        $record =
            [ordered]@{

                version =
                    3

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


            exit 1
        }


        # ====================================================
        # 7. Update claim with active process IDs
        # ====================================================

        $claimRecord =
            [ordered]@{

                version =
                    3

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
                "Warning: failed updating claim: " +
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


    # ========================================================
    # Progress logging
    # ========================================================

    if (
        (Get-Date) -ge
        $nextProgressLog
    ) {

        Write-Log (
            "Codex PID=$($codexProcess.ProcessId) found; " +
            "still waiting for matching rollout Session..."
        )


        $nextProgressLog =
            (Get-Date).AddSeconds(10)
    }


    Start-Sleep `
        -Milliseconds 400
}


Write-Log (
    "Timed out waiting for Codex process / matching Session."
)

exit 2