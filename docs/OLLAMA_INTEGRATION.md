# Ollama Integration for Oriole

This document explains how to run Oriole maze navigation experiments using local Ollama LLMs instead of AWS Bedrock.

## Why Use Ollama?

- **Cost**: Zero marginal cost after setup (vs ~$0.001-0.01 per Bedrock turn)
- **Speed Control**: Run experiments on your own hardware without cloud rate limits
- **Full Control**: All data stays local, instant iteration on prompts
- **Same Infrastructure**: Uses identical database, viewer UI, and orchestration as Bedrock
- **A/B Testing Ready**: Shares exact tool definitions with Bedrock for fair comparisons

## Architecture

```
AWS Step Functions (orchestration)
    ↓
InvokeAgentOllamaFunction → HTTPS (Let's Encrypt) → Home Router (port 11435)
    ↓                                                     ↓
    └─────────────────────────────────→ Mac Mini: ollama-auth-proxy (port 11435)
                                                ↓ HTTP (internal LAN)
                                         Windows: Ollama Server (192.168.0.208:11434)
    ↓
router.js (action execution) → PostgreSQL
    ↓
Viewer UI (unchanged)
```

**Key Differences from Bedrock:**
- `invoke-agent-ollama.js` calls local Ollama via HTTPS with API key auth
- Uses function calling instead of Bedrock Agent orchestration
- Manually implements multi-turn loop (Bedrock does this automatically)
- Everything else is identical to Bedrock setup

**Security Architecture:**
- Only Mac Mini is exposed to internet (router forwards external port 11435 → Mac Mini)
- Mac Mini handles authentication and HTTPS encryption
- Windows Ollama stays completely internal, accessed only via LAN
- API key validation happens at gateway before reaching Ollama

## How It Works

### Function Calling (Not Text Parsing)

Ollama receives tool definitions in OpenAI-compatible format:
```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "move_north",
        "description": "Move one tile north (decreasing Y coordinate)",
        "parameters": {
          "type": "object",
          "properties": {
            "experimentId": {"type": "integer"},
            "reasoning": {"type": "string"}
          }
        }
      }
    }
  ]
}
```

Ollama returns structured tool calls (not free text):
```json
{
  "message": {
    "role": "assistant",
    "tool_calls": [
      {
        "function": {
          "name": "move_north",
          "arguments": {"experimentId": 123, "reasoning": "Exploring northward"}
        }
      }
    ]
  }
}
```

### Orchestration Loop

Each Step Functions turn:
1. Lambda calls Ollama with conversation history + tool definitions
2. Ollama returns tool call(s)
3. Lambda executes each tool via router.js
4. Lambda feeds tool results (including vision data) back to Ollama
5. Repeat steps 1-4 until Ollama stops calling tools or max 8 actions reached

This mirrors Bedrock Agent's multi-turn orchestration within a single Step Functions turn.

### Vision Data Flow

After each move, the agent receives vision feedback:
```json
{
  "success": true,
  "message": "Moved north to (2, 1)",
  "visible": "(2,1): empty, (2,0): wall, (2,2): empty, (3,1): empty, (4,1): empty",
  "position": {"x": 2, "y": 1}
}
```

This tells the agent what it can see from its new position, enabling informed navigation.

## Setup

### 1. Install Ollama

```bash
# macOS
brew install ollama

# Start Ollama server
ollama serve
```

Verify it's running:
```bash
curl http://localhost:11434/api/tags
```

### 2. Pull a Model

```bash
# Start with a capable model (llama3.2 is too small for good tool use)
ollama pull llama3.3:70b

# Or try these alternatives:
ollama pull qwen2.5:72b
ollama pull deepseek-r1:70b
```

**Model Requirements:**
- Must support function calling
- Should be 70B+ parameters for good tool use
- Smaller models (3B-14B) struggle with vision feedback integration

### 3. Set Up HTTPS Auth Proxy

The auth proxy adds API key authentication to Ollama's API.

**Install dependencies:**
```bash
cd tools
npm install express http-proxy-middleware
```

**Generate API key:**
```bash
openssl rand -base64 32
# Save this, you'll need it for Parameter Store
```

**Get SSL certificates (Let's Encrypt):**
```bash
# Install certbot
brew install certbot

# Get certificates for your domain (e.g., sf1.tplinkdns.com)
sudo certbot certonly --standalone -d sf1.tplinkdns.com

# Copy certificates to accessible location
sudo cp /etc/letsencrypt/live/sf1.tplinkdns.com/privkey.pem ~/certs/
sudo cp /etc/letsencrypt/live/sf1.tplinkdns.com/fullchain.pem ~/certs/
sudo chown $USER ~/certs/*.pem
```

**Start auth proxy (pointing to Windows Ollama):**
```bash
export OLLAMA_API_KEY="your-32-char-api-key-here"
export SSL_KEY_PATH="$HOME/certs/privkey.pem"
export SSL_CERT_PATH="$HOME/certs/fullchain.pem"
export OLLAMA_PORT=11435
export OLLAMA_TARGET="http://192.168.0.208:11434"  # Your Windows PC's IP

node tools/ollama-auth-proxy.js
```

You should see:
```
🔒 Ollama auth proxy (HTTPS) listening on 0.0.0.0:11435
Proxying to: http://192.168.0.208:11434
API key configured: ********...
SSL cert: /Users/bobbyburgess/certs/fullchain.pem
Logging to: /Users/bobbyburgess/Documents/code/oriole/tools/ollama-proxy.log
```

**Note:** `OLLAMA_TARGET` can point to:
- `http://localhost:11434` - Ollama running on same Mac as proxy
- `http://192.168.0.x:11434` - Ollama running on different machine (Windows, Linux, etc.)
- Any internal network IP where Ollama is accessible

### 4. Configure Router Port Forwarding

On your home router:
1. Forward external port `11435` → **Mac Mini's internal IP:11435** (not Windows)
   - Example: `11435 (WAN) → 192.168.0.x:11435 (LAN)` where x is your Mac Mini
2. Ensure HTTPS (port 443 is not required, we use custom port 11435)
3. Use your dynamic DNS hostname (e.g., `sf1.tplinkdns.com:11435`)

**Important:** The router forwards to the **Mac Mini (proxy)**, not the Windows Ollama server. The Mac Mini then forwards internally to Windows via LAN.

**Testing Note - Hairpin NAT:**
Many consumer routers don't support "hairpin NAT" (also called NAT loopback). This means you may not be able to test the connection from inside your own network:

```bash
# This may timeout due to hairpin NAT limitation:
curl https://sf1.tplinkdns.com:11435/api/version -H "X-API-Key: your-key"
```

However, **external connections (from AWS Lambda) will work fine** even if local testing fails. To test locally:
- Use internal IP: `curl https://192.168.0.x:11435/api/version`
- Or test from cellular: Turn off WiFi and test from phone
- Or use AWS Lambda test (the real use case)

### 5. Store Ollama Endpoint in Parameter Store

```bash
# Ollama endpoint (HTTPS with custom port)
aws ssm put-parameter \
  --name /oriole/ollama/endpoint \
  --value "https://sf1.tplinkdns.com:11435" \
  --type String \
  --overwrite \
  --profile bobby

# API key (SecureString for encryption)
aws ssm put-parameter \
  --name /oriole/ollama/api-key \
  --value "your-32-char-api-key-here" \
  --type SecureString \
  --overwrite \
  --profile bobby

# Rate limit (600 rpm = 1 second between turns, essentially no limiting)
aws ssm put-parameter \
  --name /oriole/models/llama3-3-70b/rate-limit-rpm \
  --value "600" \
  --type String \
  --overwrite \
  --profile bobby
```

**Note:** Model configuration (context, temperature, repeat penalty) is **NOT** stored in Parameter Store. These parameters are passed in the event for each experiment. See "Configuration: Atomic Config-in-Event Pattern" section above.

### 6. Deploy via CDK

The Ollama Lambda is already defined in the CDK stack:

```bash
npx cdk deploy --profile bobby
```

This creates:
- `InvokeAgentOllamaFunction` Lambda
- IAM role with SSM + Lambda invoke permissions
- Step Functions routing to Ollama or Bedrock based on `llmProvider`

## Shared Tool Definitions (DRY)

Both Bedrock and Ollama use the **same tool definitions** from `lambda/shared/tools.json`:

```json
{
  "tools": [
    {
      "name": "move_north",
      "description": "Move one tile north (decreasing Y coordinate)",
      "parameters": {
        "type": "object",
        "properties": {
          "experimentId": {"type": "integer"},
          "reasoning": {"type": "string"}
        },
        "required": ["experimentId"]
      }
    }
  ]
}
```

**Converters:**
- `getOllamaTools()` → Ollama function calling format
- `getBedrockOpenAPISchema()` → Bedrock Agent OpenAPI format

This ensures **identical tool definitions** for A/B testing.

## Configuration: Atomic Config-in-Event Pattern

**Important:** Ollama experiments use an **atomic configuration** approach to prevent race conditions during parameter sweeps.

### How It Works

Configuration flows **with the event message** through the entire workflow:

```
trigger-experiment.sh → EventBridge → SQS → Lambda → Step Functions
   (config params)         (in event)    (FIFO)  (from event)  (passes through)
```

Each experiment's config is embedded in the EventBridge event and travels atomically through the system. No shared mutable state (Parameter Store) is read at runtime.

### Why Atomic Config?

**Problem with Parameter Store:**
- Parameter Store is shared mutable state across all experiments
- When running parameter sweeps, experiments can capture the wrong config
- Timing-dependent race conditions require magic number delays (180s+)

**Solution with Event Config:**
- Config embedded in event message (immutable, atomic)
- Each experiment guaranteed to use exactly the config it was triggered with
- No race conditions = can reduce delays from 180s to 5s (36x faster)
- Perfect reproducibility

### Configuration Hierarchy

1. **Per-experiment config** (from event, varies per experiment):
   - `numCtx`: Context window size (e.g., 2048, 8192, 32768)
   - `temperature`: Sampling temperature (e.g., 0.0, 0.2, 0.5, 1.0)
   - `repeatPenalty`: Repetition penalty (e.g., 1.0, 1.2, 1.4, 1.6)
   - `numPredict`: Max output tokens (default: 2000)

2. **System config** (from Parameter Store, stable across experiments):
   - `recall_interval`: Moves between recall_all calls (default: 10)
   - `max_recall_actions`: Max items returned by recall (default: 50)
   - `max_moves`: Max actions per experiment (default: 500)
   - `max_duration_minutes`: Timeout in minutes (default: 120)

The Lambda combines both: event config for per-experiment tuning + Parameter Store for stable system settings.

## Usage

### Run Ollama Experiment with Custom Config

```bash
# With config parameters (context, temp, repeat_penalty, num_predict)
./scripts/trigger-experiment.sh OLLAMA NOTUSED qwen2.5:7b 1 v1 "" 8192 0.2 1.4 2000

# Small context window (2K)
./scripts/trigger-experiment.sh OLLAMA NOTUSED qwen2.5:7b 1 v1 "" 2048 0.2 1.4

# High temperature (creative)
./scripts/trigger-experiment.sh OLLAMA NOTUSED qwen2.5:7b 1 v1 "" 32768 0.7 1.4

# No repeat penalty
./scripts/trigger-experiment.sh OLLAMA NOTUSED qwen2.5:7b 1 v1 "" 32768 0.2 1.0
```

**Parameter order:**
```
./scripts/trigger-experiment.sh \
  <llm-provider> \      # "OLLAMA" (triggers Ollama path)
  <agent-alias-id> \    # "NOTUSED" (not used for Ollama)
  <model-name> \        # e.g., "qwen2.5:7b"
  <maze-id> \           # e.g., 1
  <prompt-version> \    # e.g., "v1"
  <goal-description> \  # "" (default: "Find the goal marker")
  [num-ctx] \           # Optional: 2048, 8192, 32768
  [temperature] \       # Optional: 0.0-1.0
  [repeat-penalty] \    # Optional: 1.0-2.0
  [num-predict]         # Optional: max output tokens
```

### Run Ollama Experiment (Default Config)

If you omit config parameters, the Lambda will **fail fast** and require you to provide them:

```bash
# This will FAIL - config required for Ollama
./scripts/trigger-by-name.sh llama3.3:70b 1 v1
# Error: "Config must be provided in event for Ollama experiments"
```

**Why no fallback?** To ensure experiments are reproducible and avoid accidentally using stale Parameter Store values.

### Run Parameter Sweep

The parameter sweep script passes config atomically for each experiment:

```bash
./scripts/run-parameter-sweep.sh
```

This triggers 12 experiments with different configs:
- **Series A**: Context window (2K, 8K, 32K)
- **Series B**: Temperature (0.0, 0.1, 0.2, 0.5, 0.7, 1.0)
- **Series C**: Repeat penalty (1.0, 1.2, 1.6)

Each experiment receives its config in the event message - no timing dependencies or race conditions.

### Run Bedrock Experiment (for comparison)

```bash
./scripts/trigger-by-name.sh claude-3-5-haiku 1 v1
```

### View Results

Both Ollama and Bedrock write to the same database. The `model_config` JSONB column captures the full configuration for each experiment:

```sql
-- View experiments with their config
SELECT
  id,
  model_name,
  model_config->>'num_ctx' as context,
  model_config->>'temperature' as temp,
  model_config->>'repeat_penalty' as rep_penalty,
  (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = experiments.id) as actions,
  (SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = experiments.id) as turns,
  goal_found
FROM experiments
WHERE id >= 9
ORDER BY id DESC;
```

**Example output:**
```
 id | model_name | context | temp | rep_penalty | actions | turns | goal_found
----+------------+---------+------+-------------+---------+-------+------------
 12 | qwen2.5:7b | 32768   | 0.2  | 1.6         |     305 |    45 | f
 11 | qwen2.5:7b | 32768   | 0.2  | 1.2         |     402 |    58 | f
 10 | qwen2.5:7b | 32768   | 0.2  | 1.0         |     500 |    72 | f
  9 | qwen2.5:7b | 2048    | 0.2  | 1.4         |     198 |    29 | f
```

This shows each experiment captured exactly the config it was triggered with - no config bleed between experiments.

## Model Comparison

From actual testing on maze 1:

| Model | Provider | Actions | Turns | Behavior |
|-------|----------|---------|-------|----------|
| claude-3.5-haiku | Bedrock | 26 | 4 | Efficient, learns from failures, strategic tool use |
| llama3.2:latest (3B) | Ollama | 30 | 27 | Gets stuck, ignores vision data, repeats failed moves |
| llama3.3:70b | Ollama | TBD | TBD | Should match Bedrock quality |

**Key Insight:** Model size matters for function calling! Use 70B+ models for comparable results.

## Troubleshooting

### "Failed to connect to Ollama"

1. **Check Ollama is running on Windows:**
   ```cmd
   REM On Windows
   curl http://localhost:11434/api/tags

   REM Or check if listening on all interfaces (not just 127.0.0.1)
   netstat -an | findstr 11434
   ```

   Should show: `TCP 0.0.0.0:11434 ... LISTENING`

   If it shows `127.0.0.1:11434`, Ollama is only listening on localhost. Fix with:
   ```cmd
   REM In PowerShell
   $env:OLLAMA_HOST = "0.0.0.0:11434"
   ollama serve
   ```

2. **Check Mac Mini can reach Windows Ollama (LAN test):**
   ```bash
   # On Mac Mini
   curl http://192.168.0.208:11434/api/tags
   ```

   If this fails, check:
   - Windows Firewall allows port 11434
   - Correct Windows IP address
   - Both machines on same network

3. **Check auth proxy is running (on Mac Mini):**
   ```bash
   curl https://sf1.tplinkdns.com:11435/api/tags \
     -H "X-API-Key: your-api-key"
   ```

   Note: This may timeout from inside your network due to hairpin NAT, but work fine from AWS Lambda.

4. **Check Parameter Store:**
   ```bash
   aws ssm get-parameter --name /oriole/ollama/endpoint --profile bobby
   aws ssm get-parameter --name /oriole/ollama/api-key --with-decryption --profile bobby
   ```

5. **Check Lambda logs:**
   ```bash
   aws logs tail /aws/lambda/OrioleStack-InvokeAgentOllamaFunction... --follow --profile bobby
   ```

6. **Check proxy logs (on Mac Mini):**
   ```bash
   tail -f /Users/bobbyburgess/Documents/code/oriole/tools/ollama-proxy.log
   ```

### "No tool calls requested"

The model isn't using tools. This happens with:
- **Models too small** (< 14B parameters)
- **Models without tool training** (some older models)
- **Prompt issues** (check SSM parameter `/oriole/prompts/v1`)

**Solution:** Use a larger, tool-capable model like llama3.3:70b or qwen2.5:72b

### "Agent gets stuck repeating failed moves"

The model isn't integrating vision feedback. This is a **model capability issue**, not infrastructure.

**What the agent receives:**
```json
{
  "success": false,
  "message": "Cannot move north - wall in the way",
  "visible": "(2,0): wall, (2,1): empty, (2,2): empty"
}
```

**What small models do:** Ignore the feedback, try move_north again

**Solution:** Use a 70B+ parameter model with strong reasoning

### SSL Certificate Expired

Let's Encrypt certificates expire after 90 days:

```bash
# Renew certificate
sudo certbot renew

# Copy new certificates
sudo cp /etc/letsencrypt/live/sf1.tplinkdns.com/privkey.pem ~/certs/
sudo cp /etc/letsencrypt/live/sf1.tplinkdns.com/fullchain.pem ~/certs/
sudo chown $USER ~/certs/*.pem

# Restart auth proxy
# (Press Ctrl+C to stop, then re-run with environment variables)
```

## Cost Comparison

**Per experiment (maze 1, ~50 turns):**

| Provider | Model | Cost |
|----------|-------|------|
| AWS Bedrock | claude-3-5-haiku | ~$0.003 |
| AWS Bedrock | claude-3-haiku | ~$0.001 |
| Local Ollama | llama3.3:70b | ~$0.0001 (electricity) |
| Local Ollama | qwen2.5:72b | ~$0.0001 (electricity) |

**100 experiments:**
- Bedrock: $0.10 - $0.30
- Ollama: $0.01 (electricity)

**Savings:** ~10-30x cheaper

**Note:** This assumes you already own capable hardware (M4 Pro, etc.)

## Architecture Details

### Why Not Use Bedrock Agent Directly?

AWS Bedrock Agents don't support "bring your own model" - the agent definition is hardcoded to a specific Bedrock foundation model ID. You can't swap in a custom endpoint.

### Why Port Forwarding Instead of ngrok?

- **ngrok free**: URLs change on restart, 2-hour timeout
- **ngrok paid**: $8/month for static URL
- **Port forwarding**: Free, permanent, but requires home router access

### Why HTTPS Auth Proxy?

- Ollama API has no authentication
- Exposing unauthenticated LLM to internet = security risk
- Auth proxy adds API key requirement
- HTTPS prevents MITM attacks

### Why Separate Proxy and Ollama Machines?

**Benefits of Mac Mini (proxy) → Windows (Ollama) setup:**

1. **Security**: Windows never exposed to internet - only Mac Mini accepts external connections
2. **Hardware flexibility**: Run Ollama on powerful Windows PC with better GPU, keep lightweight Mac Mini as gateway
3. **Separation of concerns**: Mac Mini handles SSL/auth/logging, Windows focuses on model inference
4. **Easy maintenance**: Update/restart Windows Ollama without affecting external connectivity
5. **Firewall simplification**: Only Mac Mini needs incoming firewall rules, Windows stays internal

**Alternative (single-machine):**
```bash
export OLLAMA_TARGET="http://localhost:11434"
```
Run both proxy and Ollama on same Mac. Simpler but requires Mac to have sufficient resources for large models.

### Why Function Calling Instead of Text Parsing?

**Old approach (regex):**
```javascript
const actions = response.match(/move_north|move_south/gi);
```

**Problems:**
- LLM output varies ("I'll move_north" vs "move north" vs "go north")
- Can't pass structured parameters
- Can't reliably get reasoning

**New approach (function calling):**
```javascript
const tools = getOllamaTools();  // From shared tools.json
const response = await callOllamaChat(model, messages, tools);
// Response includes structured: {name: "move_north", arguments: {...}}
```

**Benefits:**
- Reliable structured output
- Can pass parameters (reasoning, experimentId)
- Same tool definitions as Bedrock (fair A/B testing)

## Next Steps

1. **Test with capable model:**
   ```bash
   ollama pull llama3.3:70b
   ./scripts/trigger-by-name.sh llama3.3:70b 1 v1
   ```

2. **Compare to Bedrock:**
   ```bash
   ./scripts/trigger-by-name.sh claude-3-5-haiku 1 v1
   ```

3. **Query results:**
   ```sql
   SELECT
     model_name,
     COUNT(*) as experiments,
     AVG((SELECT COUNT(*) FROM agent_actions WHERE experiment_id = experiments.id)) as avg_actions,
     SUM(CASE WHEN goal_found THEN 1 ELSE 0 END)::float / COUNT(*) as success_rate
   FROM experiments
   WHERE model_name IN ('llama3.3:70b', 'claude-3-5-haiku')
   GROUP BY model_name;
   ```

4. **Iterate on prompts** using Parameter Store (no redeploy needed)

## References

- **Ollama function calling docs**: https://ollama.com/blog/tool-support
- **Bedrock Agent format**: See `lambda/actions/router.js` comments
- **Shared tool definitions**: `lambda/shared/tools.json`
- **CDK stack**: `lib/oriole-stack.js` (search for "Ollama")
