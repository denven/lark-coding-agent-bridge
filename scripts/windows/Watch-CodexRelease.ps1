param(
    [Parameter(Mandatory = $true)]
    [string]$SessionId,

    [Parameter(Mandatory = $true)]
    [int]$CodexRootPid,

    [string]$MonitorHome =
        "$HOME\.codex-monitor",

    [string]$ReleaseScript =
        "$HOME\Scripts\Release-CodexSession.ps1"
)

$ErrorActionPreference = "Stop"

$requestDir =
    Join-Path $MonitorHome "requests"

$resultDir =
    Join-Path $MonitorHome "results"

$logDir =
    Join-Path $MonitorHome "logs"

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

New-Item `
    -ItemType Directory `
    -Path $logDir `
    -Force |
    Out-Null


$logFile =
    Join-Path `
        $logDir `
        "release-agent-$SessionId.log"


function Write-Log {

    param(
        [string]$Message
    )

    Add-Content `
        -Path $logFile `
        -Value "$(Get-Date -Format o) $Message" `
        -Encoding UTF8
}


function Read-JsonFile {

    param(
        [string]$Path
    )

    try {

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
    catch {

        return $null
    }
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


Write-Log (
    "Release Agent started. " +
    "Session=$SessionId " +
    "CodexRootPid=$CodexRootPid"
)


while ($true) {

    # ========================================================
    # If local Codex already exited normally, this agent
    # no longer has anything to manage.
    # ========================================================

    $codexProcess =
        Get-Process `
            -Id $CodexRootPid `
            -ErrorAction SilentlyContinue


    if (-not $codexProcess) {

        Write-Log (
            "Codex root process no longer exists. " +
            "Release Agent exiting."
        )

        exit 0
    }


    # ========================================================
    # Find pending release requests.
    # ========================================================

    $requests =
        Get-ChildItem `
            $requestDir `
            -Filter "release-*.json" `
            -File `
            -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc


    foreach ($requestFile in $requests) {

        $request =
            Read-JsonFile `
                -Path $requestFile.FullName


        if (-not $request) {
            continue
        }


        if (
            [string]$request.action -ne
            "release"
        ) {
            continue
        }


        if (
            [string]$request.sessionId -ne
            $SessionId
        ) {
            continue
        }


        # ====================================================
        # Reject an expired request.
        # ====================================================

        if ($request.expiresAt) {

            try {

                $expiresAt =
                    [datetimeoffset]::Parse(
                        [string]$request.expiresAt
                    )

                if (
                    [datetimeoffset]::Now -gt
                    $expiresAt
                ) {

                    Write-Log (
                        "Ignoring expired request " +
                        "$($request.requestId)"
                    )

                    Remove-Item `
                        $requestFile.FullName `
                        -Force `
                        -ErrorAction SilentlyContinue

                    continue
                }

            }
            catch {

                Remove-Item `
                    $requestFile.FullName `
                    -Force `
                    -ErrorAction SilentlyContinue

                continue
            }
        }


        $requestId =
            [string]$request.requestId


        # ====================================================
        # Claim this request by atomically renaming it.
        # ====================================================

        $processingFile =
            Join-Path `
                $requestDir `
                "processing-$requestId.json"


        try {

            Move-Item `
                -Path $requestFile.FullName `
                -Destination $processingFile `
                -ErrorAction Stop

        }
        catch {

            continue
        }


        Write-Log (
            "Processing release request " +
            $requestId
        )


        # ====================================================
        # Execute release script in a CHILD PowerShell.
        #
        # Important:
        # this child inherits the same Windows security context
        # as this local Release Agent / codex3.
        # ====================================================

        $outputFile =
            Join-Path `
                $requestDir `
                "output-$requestId.txt"


        $errorFile =
            Join-Path `
                $requestDir `
                "error-$requestId.txt"


        try {

            $process =
                Start-Process `
                    -FilePath "powershell.exe" `
                    -ArgumentList @(
                        "-NoProfile",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                        "`"$ReleaseScript`"",
                        "-SessionPrefix",
                        "`"$SessionId`""
                    ) `
                    -WindowStyle Hidden `
                    -RedirectStandardOutput $outputFile `
                    -RedirectStandardError $errorFile `
                    -Wait `
                    -PassThru


            $stdout = ""

            $stderr = ""


            if (Test-Path $outputFile) {

                $stdout =
                    Get-Content `
                        $outputFile `
                        -Raw `
                        -ErrorAction SilentlyContinue
            }


            if (Test-Path $errorFile) {

                $stderr =
                    Get-Content `
                        $errorFile `
                        -Raw `
                        -ErrorAction SilentlyContinue
            }


            $combined =
                (
                    "$stdout`n$stderr"
                ).Trim()


            $success =
                $combined -match
                "^OK\|RELEASED\|"


            $result =
                [ordered]@{

                    requestId =
                        $requestId

                    sessionId =
                        $SessionId

                    success =
                        $success

                    exitCode =
                        $process.ExitCode

                    output =
                        $combined

                    completedAt =
                        (Get-Date).ToString("o")
                }


            $resultFile =
                Join-Path `
                    $resultDir `
                    "release-$requestId.json"


            Write-JsonNoBom `
                -Path $resultFile `
                -Value $result


            Write-Log (
                "Release request completed. " +
                "Request=$requestId " +
                "Success=$success " +
                "ExitCode=$($process.ExitCode)"
            )

        }
        catch {

            $result =
                [ordered]@{

                    requestId =
                        $requestId

                    sessionId =
                        $SessionId

                    success =
                        $false

                    exitCode =
                        -1

                    output =
                        $_.Exception.Message

                    completedAt =
                        (Get-Date).ToString("o")
                }


            $resultFile =
                Join-Path `
                    $resultDir `
                    "release-$requestId.json"


            Write-JsonNoBom `
                -Path $resultFile `
                -Value $result


            Write-Log (
                "Release execution failed: " +
                $_.Exception.Message
            )
        }
        finally {

            Remove-Item `
                $processingFile `
                -Force `
                -ErrorAction SilentlyContinue

            Remove-Item `
                $outputFile `
                -Force `
                -ErrorAction SilentlyContinue

            Remove-Item `
                $errorFile `
                -Force `
                -ErrorAction SilentlyContinue
        }


        # If release succeeded, our Codex should now be exiting.
        # This Release Agent has completed its purpose.
        if ($success) {

            Start-Sleep `
                -Milliseconds 300

            exit 0
        }
    }


    Start-Sleep `
        -Milliseconds 400
}