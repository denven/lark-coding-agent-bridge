param(
    [Parameter(Mandatory = $true)]
    [string]$SessionPrefix,

    [string]$MonitorHome =
        "$HOME\.codex-monitor",

    [int]$TimeoutSeconds = 15
)

$ErrorActionPreference = "Stop"


function Read-JsonFile {

    param(
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


function Write-JsonNoBom {

    param(
        [string]$Path,
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


# ============================================================
# Resolve Session prefix
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

            $_.BaseName.
            Substring(7).
            StartsWith(
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


$status =
    Read-JsonFile `
        -Path $matches[0].FullName


$sessionId =
    [string]$status.sessionId


# ============================================================
# Only Waiting Session may request release
# ============================================================

if (
    $status.state -ne
    "Waiting"
) {

    Write-Output (
        "ERROR|SESSION_NOT_WAITING|" +
        "$sessionId|" +
        "$($status.state)"
    )

    exit 12
}


if (
    $status.observerState -ne
    "Running"
) {

    Write-Output (
        "ERROR|OBSERVER_NOT_RUNNING|" +
        $sessionId
    )

    exit 13
}


# ============================================================
# Prepare request
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


$expiresAt =
    [datetimeoffset]::Now.
    AddSeconds(
        $TimeoutSeconds
    )


$request =
    [ordered]@{

        version =
            1

        action =
            "release"

        requestId =
            $requestId

        sessionId =
            $sessionId

        requestedAt =
            (Get-Date).ToString("o")

        expiresAt =
            $expiresAt.ToString("o")
    }


Write-JsonNoBom `
    -Path $requestPath `
    -Value $request


# ============================================================
# Wait for Local Release Agent result
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


            Write-Output $output

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