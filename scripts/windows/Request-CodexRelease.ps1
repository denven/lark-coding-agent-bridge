param(
    [Parameter(Mandatory = $true)]
    [string]$SessionSelector,

    [string]$MonitorHome =
        "$HOME\.codex-monitor",

    [int]$TimeoutSeconds = 15,

    [int]$MaxHeartbeatAgeSeconds = 20
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


function Get-StatusEntries {

    $files =
        Get-ChildItem `
            $MonitorHome `
            -Filter "status-*.json" `
            -File `
            -ErrorAction SilentlyContinue

    $entries =
        @()


    foreach ($file in $files) {

        $status =
            Read-JsonFile `
                -Path $file.FullName

        if (-not $status) {
            continue
        }


        $sessionId =
            [string]$status.sessionId

        if (
            [string]::IsNullOrWhiteSpace(
                $sessionId
            )
        ) {
            continue
        }


        $threadName =
            [string]$status.threadName


        $updatedAt =
            [datetimeoffset]::MinValue


        foreach (
            $candidate in @(
                $status.observerUpdatedAt,
                $status.lastEventTime,
                $status.threadNameUpdatedAt
            )
        ) {

            if (-not $candidate) {
                continue
            }

            try {

                $parsed =
                    [datetimeoffset]::Parse(
                        [string]$candidate
                    )

                if ($parsed -gt $updatedAt) {
                    $updatedAt = $parsed
                }

            }
            catch {
            }
        }


        $entries +=
            [pscustomobject]@{

                File =
                    $file

                Status =
                    $status

                SessionId =
                    $sessionId

                ThreadName =
                    $threadName

                State =
                    [string]$status.state

                UpdatedAt =
                    $updatedAt
            }
    }


    return @(
        $entries |
        Sort-Object `
            UpdatedAt `
            -Descending
    )
}


function Write-AmbiguousError {

    param(
        [string]$Selector,
        [object[]]$Matches
    )

    $ids =
        @(
            $Matches |
            ForEach-Object {
                $_.SessionId
            }
        )


    Write-Output (
        "ERROR|AMBIGUOUS_SESSION|" +
        $Selector +
        "|" +
        ($ids -join ",")
    )

    exit 11
}


# ============================================================
# Resolve selector
#
# Precedence:
#
# 1. Exact Session ID
# 2. Session ID prefix
# 3. Exact Thread name
# 4. Thread-name prefix
#
# Historical Exited Sessions are not considered for
# Thread-name lookup because renamed/reused names would
# otherwise cause unnecessary ambiguity.
#
# Direct Session-ID lookup still sees historical records so
# the caller can receive SESSION_NOT_WAITING instead of an
# incorrect SESSION_NOT_FOUND.
# ============================================================

function Resolve-Session {

    param(
        [Parameter(Mandatory = $true)]
        [string]$Selector,

        [Parameter(Mandatory = $true)]
        [object[]]$Entries
    )


    # --------------------------------------------------------
    # 1. Exact Session ID
    # --------------------------------------------------------

    $matches =
        @(
            $Entries |
            Where-Object {

                [string]::Equals(
                    $_.SessionId,
                    $Selector,
                    [System.StringComparison]::
                        OrdinalIgnoreCase
                )
            }
        )


    if ($matches.Count -eq 1) {
        return $matches[0]
    }


    if ($matches.Count -gt 1) {

        Write-AmbiguousError `
            -Selector $Selector `
            -Matches $matches
    }


    # --------------------------------------------------------
    # 2. Session ID prefix
    # --------------------------------------------------------

    $matches =
        @(
            $Entries |
            Where-Object {

                $_.SessionId.StartsWith(
                    $Selector,
                    [System.StringComparison]::
                        OrdinalIgnoreCase
                )
            }
        )


    if ($matches.Count -eq 1) {
        return $matches[0]
    }


    if ($matches.Count -gt 1) {

        Write-AmbiguousError `
            -Selector $Selector `
            -Matches $matches
    }


    # --------------------------------------------------------
    # Thread names operate on non-Exited Sessions first.
    #
    # This prevents an old historical Session with the same
    # Thread name from blocking release of the currently
    # running Session.
    # --------------------------------------------------------

    $currentEntries =
        @(
            $Entries |
            Where-Object {

                [string]$_.State -ne
                "Exited"
            }
        )


    # --------------------------------------------------------
    # 3. Exact Thread name
    # --------------------------------------------------------

    $matches =
        @(
            $currentEntries |
            Where-Object {

                -not (
                    [string]::IsNullOrWhiteSpace(
                        $_.ThreadName
                    )
                ) -and

                [string]::Equals(
                    $_.ThreadName,
                    $Selector,
                    [System.StringComparison]::
                        OrdinalIgnoreCase
                )
            }
        )


    if ($matches.Count -eq 1) {
        return $matches[0]
    }


    if ($matches.Count -gt 1) {

        Write-AmbiguousError `
            -Selector $Selector `
            -Matches $matches
    }


    # --------------------------------------------------------
    # 4. Thread-name prefix
    # --------------------------------------------------------

    $matches =
        @(
            $currentEntries |
            Where-Object {

                -not (
                    [string]::IsNullOrWhiteSpace(
                        $_.ThreadName
                    )
                ) -and

                $_.ThreadName.StartsWith(
                    $Selector,
                    [System.StringComparison]::
                        OrdinalIgnoreCase
                )
            }
        )


    if ($matches.Count -eq 1) {
        return $matches[0]
    }


    if ($matches.Count -gt 1) {

        Write-AmbiguousError `
            -Selector $Selector `
            -Matches $matches
    }


    # --------------------------------------------------------
    # Check whether the Thread name exists only in history.
    #
    # This provides a better error than SESSION_NOT_FOUND.
    # --------------------------------------------------------

    $historicalNameMatches =
        @(
            $Entries |
            Where-Object {

                [string]$_.State -eq
                "Exited" -and

                -not (
                    [string]::IsNullOrWhiteSpace(
                        $_.ThreadName
                    )
                ) -and

                (
                    [string]::Equals(
                        $_.ThreadName,
                        $Selector,
                        [System.StringComparison]::
                            OrdinalIgnoreCase
                    ) -or

                    $_.ThreadName.StartsWith(
                        $Selector,
                        [System.StringComparison]::
                            OrdinalIgnoreCase
                    )
                )
            }
        )


    if ($historicalNameMatches.Count -gt 0) {

        Write-Output (
            "ERROR|SESSION_NOT_ACTIVE|" +
            $Selector
        )

        exit 12
    }


    return $null
}


# ============================================================
# Input validation
# ============================================================

$selector =
    $SessionSelector.Trim()


if (
    [string]::IsNullOrWhiteSpace(
        $selector
    )
) {

    Write-Output (
        "ERROR|EMPTY_SELECTOR"
    )

    exit 9
}


# ============================================================
# Read monitor status
# ============================================================

$entries =
    Get-StatusEntries


if ($entries.Count -eq 0) {

    Write-Output (
        "ERROR|SESSION_NOT_FOUND|" +
        $selector
    )

    exit 10
}


$entry =
    Resolve-Session `
        -Selector $selector `
        -Entries $entries


if (-not $entry) {

    Write-Output (
        "ERROR|SESSION_NOT_FOUND|" +
        $selector
    )

    exit 10
}


$status =
    $entry.Status


$sessionId =
    [string]$entry.SessionId


$threadName =
    [string]$entry.ThreadName


# ============================================================
# Safety: only Waiting Session may be released
# ============================================================

if (
    [string]$status.state -ne
    "Waiting"
) {

    Write-Output (
        "ERROR|SESSION_NOT_WAITING|" +
        "$sessionId|" +
        "$($status.state)"
    )

    exit 13
}


# ============================================================
# Safety: Observer must still be running
# ============================================================

if (
    [string]$status.observerState -ne
    "Running"
) {

    Write-Output (
        "ERROR|OBSERVER_NOT_RUNNING|" +
        $sessionId
    )

    exit 14
}


# ============================================================
# Safety: Observer heartbeat must be valid/fresh
# ============================================================

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
# Request / result directories
# ============================================================

$requestDir =
    Join-Path `
        $MonitorHome `
        "requests"


$resultDir =
    Join-Path `
        $MonitorHome `
        "results"


New-Item `
    -ItemType Directory `
    -Path $requestDir `
    -Force |
    Out-Null


New-Item `
    -ItemType Directory `
    -Path $resultDir `
    -Force |
    Out-Null


# ============================================================
# Create release request
# ============================================================

$requestId =
    [guid]::NewGuid().
    ToString("N")


$requestPath =
    Join-Path `
        $requestDir `
        "release-$requestId.json"


$resultPath =
    Join-Path `
        $resultDir `
        "release-$requestId.json"


$requestedAt =
    [datetimeoffset]::Now


$expiresAt =
    $requestedAt.AddSeconds(
        $TimeoutSeconds
    )


$request =
    [ordered]@{

        version =
            2

        action =
            "release"

        requestId =
            $requestId

        sessionId =
            $sessionId

        threadName =
            if (
                [string]::IsNullOrWhiteSpace(
                    $threadName
                )
            ) {
                $null
            }
            else {
                $threadName
            }

        selector =
            $selector

        requestedAt =
            $requestedAt.ToString("o")

        expiresAt =
            $expiresAt.ToString("o")
    }


Write-JsonNoBom `
    -Path $requestPath `
    -Value $request


# ============================================================
# Wait for Local Release Agent
# ============================================================

$deadline =
    (Get-Date).AddSeconds(
        $TimeoutSeconds
    )


while ((Get-Date) -lt $deadline) {

    if (Test-Path $resultPath) {

        try {

            $result =
                Read-JsonFile `
                    -Path $resultPath


            if (-not $result) {

                Write-Output (
                    "ERROR|INVALID_RELEASE_RESULT|" +
                    $sessionId
                )

                exit 21
            }


            $output =
                [string]$result.output


            Remove-Item `
                $resultPath `
                -Force `
                -ErrorAction SilentlyContinue


            Remove-Item `
                $requestPath `
                -Force `
                -ErrorAction SilentlyContinue


            if (
                [bool]$result.success
            ) {

                Write-Output $output

                exit 0
            }


            if (
                [string]::IsNullOrWhiteSpace(
                    $output
                )
            ) {

                Write-Output (
                    "ERROR|RELEASE_FAILED|" +
                    $sessionId
                )

            }
            else {

                Write-Output $output
            }


            exit 20

        }
        catch {

            Write-Output (
                "ERROR|INVALID_RELEASE_RESULT|" +
                $sessionId
            )

            exit 21
        }
    }


    Start-Sleep `
        -Milliseconds 200
}


# ============================================================
# Timeout
# ============================================================

Remove-Item `
    $requestPath `
    -Force `
    -ErrorAction SilentlyContinue


Write-Output (
    "ERROR|RELEASE_REQUEST_TIMEOUT|" +
    $sessionId
)

exit 22