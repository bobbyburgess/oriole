# Ollama Setup for Windows (Network Access)

This guide explains how to configure Ollama on Windows to accept network connections from other machines (e.g., Mac running Oriole experiments).

## Problem

By default, Ollama on Windows only listens on `127.0.0.1:11434` (localhost), which means it can only be accessed from the Windows machine itself. To use Ollama from other machines on the network, it needs to listen on `0.0.0.0:11434` (all network interfaces).

## Solution Overview

1. Set the `OLLAMA_HOST` environment variable to `0.0.0.0:11434`
2. Stop the Ollama system tray app
3. Start `ollama serve` from PowerShell with the environment variable set
4. Add a Windows Firewall rule to allow incoming connections on port 11434

## Step-by-Step Instructions

### 1. Set Machine-Level Environment Variable (Optional - for persistence)

Run PowerShell as Administrator:

```powershell
[System.Environment]::SetEnvironmentVariable('OLLAMA_HOST', '0.0.0.0:11434', 'Machine')
```

**Note:** This sets the variable permanently, but existing processes won't see it until after a reboot.

### 2. Start Ollama with Network Access

Run this PowerShell script (can be run as regular user):

```powershell
Write-Host "=== Configuring Ollama for network access ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Step 1: Stopping ALL Ollama processes (including system tray app)..." -ForegroundColor Yellow
Get-Process | Where-Object {$_.Name -like "*ollama*"} | Stop-Process -Force
Start-Sleep -Seconds 2
Write-Host "All Ollama processes stopped" -ForegroundColor Green
Write-Host ""
Write-Host "Step 2: Setting OLLAMA_HOST for this session..." -ForegroundColor Yellow
$env:OLLAMA_HOST = "0.0.0.0:11434"
Write-Host "OLLAMA_HOST = $env:OLLAMA_HOST" -ForegroundColor Green
Write-Host ""
Write-Host "Step 3: Starting ollama serve (NOT the app)..." -ForegroundColor Yellow
Start-Process "ollama" -ArgumentList "serve" -WindowStyle Hidden
Start-Sleep -Seconds 5
Write-Host "Started" -ForegroundColor Green
Write-Host ""
Write-Host "Step 4: Verifying it's listening on 0.0.0.0:11434..." -ForegroundColor Yellow
netstat -ano | Select-String "11434"
Write-Host ""
Write-Host "You should see: 0.0.0.0:11434 (not 127.0.0.1:11434)" -ForegroundColor Cyan
Write-Host "Keep this PowerShell window open - if you close it, Ollama will stop!" -ForegroundColor Red
```

**Expected output:**
```
TCP    0.0.0.0:11434          0.0.0.0:0              LISTENING       29224
TCP    [::]:11434             [::]:0                 LISTENING       29224
```

### 3. Add Windows Firewall Rule

Run PowerShell as Administrator:

```powershell
New-NetFirewallRule -DisplayName "Ollama API" -Direction Inbound -LocalPort 11434 -Protocol TCP -Action Allow
```

Verify the rule was created:

```powershell
Get-NetFirewallRule -DisplayName "Ollama API" | Format-Table -Property DisplayName, Enabled, Direction, Action
```

### 4. Test the Connection

From another machine on the network (e.g., Mac):

```bash
# Replace 192.168.0.208 with your Windows machine's IP address
curl http://192.168.0.208:11434/api/version

# List available models
curl http://192.168.0.208:11434/api/tags
```

## Important Notes

1. **Keep PowerShell Window Open**: If you close the PowerShell window where you ran `ollama serve`, Ollama will stop. This is intentional - it allows you to easily stop network access when you're done.

2. **System Tray App Conflicts**: Do NOT start the Ollama system tray app while `ollama serve` is running with network access. They will conflict on port 11434.

3. **Network Security**: Only enable network access when needed. Your Ollama instance will be accessible to any device on your local network when configured this way.

4. **Finding Your Windows IP Address**:
   ```powershell
   ipconfig | Select-String "IPv4"
   ```

## Stopping Ollama Network Access

When you're done:

1. Close the PowerShell window running `ollama serve`
2. Optionally, restart the Ollama system tray app for normal (localhost-only) operation

## Troubleshooting

### Still showing 127.0.0.1:11434?

The environment variable wasn't picked up. Make sure you:
1. Set `$env:OLLAMA_HOST` in the same PowerShell session **before** starting `ollama serve`
2. Killed all existing Ollama processes first

### Connection times out from other machines?

1. Check Windows Firewall rule exists and is enabled
2. Verify `netstat` shows `0.0.0.0:11434` not `127.0.0.1:11434`
3. Check both machines are on the same network
4. Try disabling Windows Firewall temporarily to test (then re-enable!)

### Can't access Ollama locally anymore?

You can still use `localhost`:
```powershell
curl http://localhost:11434/api/version
```

## Installed Models

As of 2025-10-26, the following models are installed and support Ollama tool calling:

- llama3.1:8b
- llama3.2:latest
- llama3.3:70b
- mistral-small:latest
- mixtral:8x7b
- qwen2.5:1.5b
- qwen2.5:3b
- qwen2.5:7b
- qwen2.5:14b
- qwen2.5:72b

**Removed models** (don't support Ollama tool calling):
- codellama:13b
- mistral:7b
- phi4:latest
- qwen2.5-coder:32b

## References

- [Ollama Environment Variables](https://github.com/ollama/ollama/blob/main/docs/faq.md#how-do-i-configure-ollama-server)
- Oriole project location: `/Users/bobbyburgess/Documents/code/oriole`
- Windows machine IP: 192.168.0.208 (as of 2025-10-26)
- Mac machine IP: 192.168.0.101
