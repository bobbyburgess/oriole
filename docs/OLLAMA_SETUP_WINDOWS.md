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

## Setting Up as a Persistent Windows Service (Auto-Start)

If you want Ollama to automatically start with network access on boot, you can configure it as a Windows service. This is more convenient but less secure (always accessible on network).

### Prerequisites

1. **Set the machine-level environment variable permanently** (run PowerShell as Administrator):

   ```powershell
   [System.Environment]::SetEnvironmentVariable('OLLAMA_HOST', '0.0.0.0:11434', 'Machine')
   ```

2. **Reboot** to ensure the environment variable takes effect system-wide.

### Option 1: Using NSSM (Non-Sucking Service Manager)

**Step 1: Install NSSM**

Download NSSM from [nssm.cc](https://nssm.cc/download) or via Chocolatey:

```powershell
# Using Chocolatey (requires admin PowerShell)
choco install nssm
```

**Step 2: Create the Service** (run PowerShell as Administrator)

```powershell
# Navigate to Ollama installation directory
cd "C:\Program Files\Ollama"

# Create service using NSSM
nssm install OllamaService "C:\Program Files\Ollama\ollama.exe" serve

# Set service to start automatically
nssm set OllamaService Start SERVICE_AUTO_START

# Set environment variable for the service
nssm set OllamaService AppEnvironmentExtra OLLAMA_HOST=0.0.0.0:11434

# Start the service
nssm start OllamaService
```

**Step 3: Verify Service is Running**

```powershell
# Check service status
Get-Service OllamaService

# Verify it's listening on 0.0.0.0:11434
netstat -ano | Select-String "11434"
```

**Managing the Service:**

```powershell
# Stop the service
nssm stop OllamaService

# Start the service
nssm start OllamaService

# Restart the service
nssm restart OllamaService

# Remove the service (if you want to uninstall)
nssm remove OllamaService confirm
```

### Option 2: Using Windows Task Scheduler

**Step 1: Create a PowerShell startup script**

Create `C:\Scripts\start-ollama-network.ps1`:

```powershell
# Stop any existing Ollama processes
Get-Process | Where-Object {$_.Name -like "*ollama*"} | Stop-Process -Force
Start-Sleep -Seconds 2

# Start Ollama with network access
Start-Process "C:\Program Files\Ollama\ollama.exe" -ArgumentList "serve" -WindowStyle Hidden
```

**Step 2: Create a scheduled task** (run PowerShell as Administrator)

```powershell
$action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-ExecutionPolicy Bypass -File C:\Scripts\start-ollama-network.ps1"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName "Ollama Network Service" -Action $action -Trigger $trigger -Principal $principal -Settings $settings
```

**Step 3: Test the task**

```powershell
# Manually run the task to test
Start-ScheduledTask -TaskName "Ollama Network Service"

# Verify it's running
netstat -ano | Select-String "11434"
```

### Security Considerations

**⚠️ Important:** Running Ollama as a persistent service with network access means:

1. **Always accessible**: Your Ollama instance will be accessible on the network whenever the machine is running
2. **No authentication**: Ollama does not have built-in authentication - anyone on your network can use it
3. **Resource usage**: The service will consume memory even when not in use
4. **Auto-recovery**: If Ollama crashes, the service will restart automatically

**Recommendations:**
- Only use persistent service mode on trusted networks
- Consider using Windows Firewall rules to restrict access to specific IP addresses
- Monitor resource usage and set up alerting if needed
- Use manual mode (non-service) for occasional use

### Reverting to Manual Mode

**If using NSSM:**
```powershell
nssm stop OllamaService
nssm remove OllamaService confirm
```

**If using Task Scheduler:**
```powershell
Unregister-ScheduledTask -TaskName "Ollama Network Service" -Confirm:$false
```

**Remove environment variable:**
```powershell
[System.Environment]::SetEnvironmentVariable('OLLAMA_HOST', $null, 'Machine')
```

Then reboot to return to default localhost-only behavior.

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

As of 2025-10-28, the following models are installed and support Ollama tool calling:

- llama3.1:8b ✅ Function calling supported
- llama3.3:70b
- mistral-small:latest
- mixtral:8x7b
- qwen2.5:1.5b
- qwen2.5:3b
- qwen2.5:7b ✅ Function calling supported
- qwen2.5:72b

**Removed models** (don't support Ollama function calling):
- codellama:13b - No tool support
- llama3.2:latest (3b) - Lightweight model lacks function calling
- mistral:7b - No tool support
- phi4:latest - No tool support
- qwen2.5:14b - Invalid response format (no message field)
- qwen2.5-coder:32b - No tool support

## References

- [Ollama Environment Variables](https://github.com/ollama/ollama/blob/main/docs/faq.md#how-do-i-configure-ollama-server)
- Oriole project location: `/Users/bobbyburgess/Documents/code/oriole`
- Windows machine IP: 192.168.0.208 (as of 2025-10-26)
- Mac machine IP: 192.168.0.101
