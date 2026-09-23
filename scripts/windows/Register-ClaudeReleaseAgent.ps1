param(
    [string]$AgentScript =
        "$HOME\Scripts\Watch-ClaudeRelease.ps1",

    [switch]$Unregister
)

$ErrorActionPreference = "Stop"


# ============================================================
# Register-ClaudeReleaseAgent.ps1
#
# Runs Watch-ClaudeRelease.ps1 elevated at every logon, and
# starts it now.
#
# Why a scheduled task
#
#   The agent must be elevated to release Claude windows
#   opened from an elevated terminal. The Lark bridge cannot
#   start it: the bridge is itself a LIMITED scheduled task,
#   and a non-elevated process can only start an elevated
#   one through a UAC prompt nobody is there to answer.
#
#   Codex avoids this because codex3 launches its Release
#   Agent from the elevated terminal it runs in. Claude is
#   started directly, so its agent is started here instead:
#   a task registered with /RL HIGHEST runs elevated with no
#   prompt. It is the same mechanism the bridge uses
#   (\LarkChannelBridge.Bot.<profile>), with HIGHEST in place
#   of LIMITED.
#
# Run once from an elevated PowerShell:
#
#   .\Register-ClaudeReleaseAgent.ps1
#   .\Register-ClaudeReleaseAgent.ps1 -Unregister
# ============================================================


$taskName =
    "LarkChannelBridge.ClaudeReleaseAgent"

$principal =
    New-Object Security.Principal.WindowsPrincipal(
        [Security.Principal.WindowsIdentity]::GetCurrent()
    )

if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated (Run as administrator) PowerShell."
}


if ($Unregister) {

    & schtasks.exe /End /TN $taskName 2>$null | Out-Null
    & schtasks.exe /Delete /TN $taskName /F

    Write-Host "Unregistered $taskName." -ForegroundColor Green
    return
}


if (-not (Test-Path -LiteralPath $AgentScript)) {
    throw "Agent script not found: $AgentScript (run Install-CodexBridgeScripts.ps1 first)."
}

$command =
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AgentScript`""

& schtasks.exe `
    /Create `
    /F `
    /SC ONLOGON `
    /RL HIGHEST `
    /TN $taskName `
    /TR $command

if ($LASTEXITCODE -ne 0) {
    throw "schtasks /Create failed with exit code $LASTEXITCODE."
}

# Start it now rather than at next logon. The agent is a
# singleton, so this is harmless if one is already running.
& schtasks.exe /Run /TN $taskName | Out-Null

Write-Host "Registered and started $taskName." -ForegroundColor Green
Write-Host "Heartbeat: $HOME\.claude-monitor\agent.json" -ForegroundColor Cyan
