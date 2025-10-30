# AWS Bedrock Deprecation Plan

**Status**: Planning
**Created**: October 29, 2025
**Reason**: Pain-Driven Development - $70 Bedrock costs led to superior stateless Ollama architecture

---

## Executive Summary

This codebase has **two complete LLM integration paths**:
1. **Bedrock path**: 5 AWS agents, rate limiting, queuing, $$ per token
2. **Ollama path**: Local inference, free, fully functional

**Goal**: Remove Bedrock entirely, keep only Ollama path.

**Why this is safe**: Ollama path is production-ready and provides identical functionality at zero cost.

---

## Current Bedrock Integration Inventory

### 1. Core Lambda Functions

| File | Purpose | Dependencies |
|------|---------|--------------|
| `lambda/orchestration/invoke-agent.js` | Invokes Bedrock agents via InvokeAgentCommand | @aws-sdk/client-bedrock-agent-runtime, SSM, RDS |
| `lambda/orchestration/package.json` | Bedrock SDK dependency | @aws-sdk/client-bedrock-agent-runtime@^3.0.0 |

### 2. CDK Infrastructure

**File**: `lib/oriole-stack.js`

| Lines | Component | Type |
|-------|-----------|------|
| 18 | BedrockAgentConstruct import | Import |
| 82-85 | bedrock:InvokeAgent, bedrock:InvokeModel IAM policies | IAM |
| 227-274 | 5 Bedrock Agent instances (Claude 3.5/3 Haiku, Nova Micro/Lite/Pro/Premier) | Bedrock Agents |
| 308-312 | Bedrock agent runtime IAM permissions | IAM |
| 327-335 | InvokeAgent Lambda with reserved concurrency=1 | Lambda |
| 486-494 | InvokeBedrockAgent Step Functions task | Step Functions |
| 530-535 | AgentProviderRouter Choice state (routes llmProvider='bedrock') | Step Functions |
| 618-625 | BedrockExperimentQueue (FIFO for serializing Bedrock experiments) | SQS |
| 650-668 | BedrockQueueProcessor Lambda with reserved concurrency=1 | Lambda |
| 699+ | CDK outputs exporting agent IDs | CloudFormation Outputs |

**File**: `lib/bedrock-agent-construct.js` (Complete file - 131 lines)
- Creates Bedrock Agent resources
- Configures foundation model ARNs
- Sets up IAM roles for agent execution
- Creates Lambda resource policies

**File**: `lib/action-group-schema.js`
- OpenAPI schema for Bedrock Agent action group
- Defines maze navigation actions
- Only used by Bedrock agents

### 3. Scripts

| File | Purpose | Status |
|------|---------|--------|
| `scripts/setup-agent-ids.sh` | Discovers and stores agent IDs in Parameter Store | Critical - required after CDK deploy |
| `scripts/trigger-by-name.sh` | Triggers experiments, detects Bedrock vs Ollama models | Critical - user-facing |
| `scripts/create-nova-agents.sh` | Creates Nova agents via CLI | Optional - duplicate of CDK |
| `scripts/configure-agent-prompts.sh` | Updates agent instructions | Optional - can be done via CDK |
| `scripts/fix-nova-prompts.sh` | Patches Nova agent prompts | Optional - temporary fix |

### 4. Parameter Store Configuration

Bedrock-specific parameters:
- `/oriole/bedrock/pricing` - Pricing per model
- `/oriole/models/<model-name>/rate-limit-rpm` - Model-specific rate limits
- `/oriole/agents/<model-name>/id` - Agent IDs
- `/oriole/agents/<model-name>/alias-id` - Agent alias IDs
- `/oriole/lambda/invoke-agent-max-execution-seconds` - Lambda timeout for Bedrock

### 5. Database Schema

**File**: `db/migrations/002_add_cost_tracking.sql`

Token/cost tracking columns (Lines 5-12):
- `experiments.total_input_tokens`
- `experiments.total_output_tokens`
- `experiments.total_cost_usd`
- `agent_actions.input_tokens`
- `agent_actions.output_tokens`
- `agent_actions.cost_usd`

**Note**: These columns are useful for Ollama too - recommend keeping them.

### 6. Documentation

| File | Purpose |
|------|---------|
| `docs/BEDROCK_AGENT_LEARNINGS.md` | Technical guide on Bedrock integration architecture |
| `docs/aws/nova-agents.html` | Nova model documentation |
| `docs/aws/nova-tool-use.html` | Nova tool use guide |
| `docs/aws/bedrock-tool-use-inference.html` | Bedrock tool use reference |
| `README.md` | Architecture diagram includes Bedrock components |

---

## Removal Plan - 3 Phases

### Phase 1: Update Routing (Low Risk) ⚡ 30 minutes

**Goal**: Make Ollama the default, disable Bedrock path without deleting infrastructure.

#### 1.1 Change Default LLM Provider

**File**: `lambda/orchestration/start-experiment.js`

```javascript
// Line 107 - BEFORE:
const llmProvider = modelConfig.llmProvider || 'bedrock'; // Backwards compat

// AFTER:
const llmProvider = modelConfig.llmProvider || 'ollama'; // Default to local
```

#### 1.2 Simplify Step Functions Routing

**File**: `lib/oriole-stack.js`

**Option A: Comment out Bedrock path** (safer, reversible)
```javascript
// Lines 486-494 - Comment out InvokeBedrockAgent task
// Lines 530-535 - Modify AgentProviderRouter to always route to Ollama
const agentProviderRouter = new sfn.Choice(this, 'AgentProviderRouter')
  .when(sfn.Condition.stringEquals('$.llmProvider', 'ollama'), invokeOllamaAgent)
  // .otherwise(invokeBedrockAgent);  // COMMENTED OUT
  .otherwise(invokeOllamaAgent);  // ALWAYS USE OLLAMA
```

**Option B: Direct routing** (cleaner, less reversible)
```javascript
// Remove AgentProviderRouter entirely
// Connect CheckProgress directly to InvokeOllamaAgent
checkProgress.next(invokeOllamaAgent);
```

#### 1.3 Deploy and Test

```bash
# Deploy changes
AWS_PROFILE=bobby npx cdk deploy --require-approval never

# Trigger test experiment
./scripts/trigger-by-name.sh qwen2.5:7b

# Verify in logs (should show Ollama, not Bedrock)
aws logs tail /aws/lambda/OrioleStack-InvokeAgentOllamaFunction* --follow --profile bobby

# Check costs remain $0
# Check experiment completes successfully
```

**Rollback Plan**: Revert commit, redeploy

**Success Criteria**:
- ✅ All new experiments use Ollama
- ✅ No Bedrock API calls in CloudWatch logs
- ✅ Costs remain $0
- ✅ Experiments complete successfully

---

### Phase 2: Remove Bedrock Infrastructure (Medium Risk) ⚙️ 2 hours

**Goal**: Delete all Bedrock resources, dependencies, and code.

#### 2.1 Remove CDK Resources

**File**: `lib/oriole-stack.js`

Delete these sections:
```javascript
// Line 18 - Remove import
- const { BedrockAgentConstruct } = require('./bedrock-agent-construct');

// Lines 82-85 - Remove Bedrock IAM policies
- lambdaRole.addToPolicy(new iam.PolicyStatement({
-   actions: ['bedrock:InvokeAgent', 'bedrock:InvokeModel'],
-   resources: ['*']
- }));

// Lines 227-274 - DELETE all 5 Bedrock Agent instances
- const claude35HaikuAgent = new BedrockAgentConstruct(...)
- const claude3HaikuAgent = new BedrockAgentConstruct(...)
- const novaMicroAgent = new BedrockAgentConstruct(...)
- const novaLiteAgent = new BedrockAgentConstruct(...)
- const novaProAgent = new BedrockAgentConstruct(...)
- const novaPremierAgent = new BedrockAgentConstruct(...)

// Lines 308-312 - Remove Bedrock runtime permissions
- lambdaRole.addToPolicy(new iam.PolicyStatement({
-   actions: ['bedrock:InvokeAgent'],
-   resources: ['*']
- }));

// Lines 327-335 - Remove InvokeAgent Lambda
- const invokeAgentLambda = new lambda.Function(this, 'InvokeAgentFunction', {
-   ...
-   reservedConcurrentExecutions: 1
- });

// Lines 486-494 - Remove InvokeBedrockAgent Step Functions task
- const invokeBedrockAgent = new tasks.LambdaInvoke(...)

// Lines 530-535 - Remove AgentProviderRouter (if not already done in Phase 1)
- const agentProviderRouter = new sfn.Choice(...)

// Lines 618-625 - Remove BedrockExperimentQueue
- const bedrockExperimentQueue = new sqs.Queue(this, 'BedrockExperimentQueue', {
-   ...
- });

// Lines 650-668 - Remove BedrockQueueProcessor Lambda
- const bedrockQueueProcessor = new lambda.Function(this, 'BedrockQueueProcessorFunction', {
-   ...
-   reservedConcurrentExecutions: 1
- });

// Lines 699+ - Remove agent ID outputs
- new cdk.CfnOutput(this, 'Claude35AgentId', ...)
- new cdk.CfnOutput(this, 'Claude3AgentId', ...)
- new cdk.CfnOutput(this, 'NovaMicroAgentId', ...)
- new cdk.CfnOutput(this, 'NovaLiteAgentId', ...)
- new cdk.CfnOutput(this, 'NovaProAgentId', ...)
- new cdk.CfnOutput(this, 'NovaPremierAgentId', ...)
```

#### 2.2 Delete Bedrock-Specific Files

```bash
# Core Bedrock integration
rm lambda/orchestration/invoke-agent.js
rm lib/bedrock-agent-construct.js
rm lib/action-group-schema.js

# Setup/management scripts
rm scripts/setup-agent-ids.sh
rm scripts/create-nova-agents.sh
rm scripts/configure-agent-prompts.sh
rm scripts/fix-nova-prompts.sh
```

#### 2.3 Remove Bedrock SDK Dependency

```bash
cd lambda/orchestration
npm uninstall @aws-sdk/client-bedrock-agent-runtime
cd ../..
```

#### 2.4 Update Routing Logic

**File**: `lambda/orchestration/start-experiment.js`

Remove llmProvider logic entirely (Lines 77-109):
```javascript
// BEFORE:
const llmProvider = determineProvider(modelName);
const nextState = llmProvider === 'ollama' ? 'InvokeOllamaAgent' : 'InvokeBedrockAgent';

// AFTER:
const llmProvider = 'ollama';  // Always Ollama
const nextState = 'InvokeOllamaAgent';
```

Or even simpler:
```javascript
// Remove llmProvider field entirely
- llmProvider: llmProvider,
```

#### 2.5 Review CDK Diff

```bash
# See what will be destroyed
AWS_PROFILE=bobby npx cdk diff

# Should show:
# - 5 Bedrock Agents will be destroyed
# - 1 InvokeAgent Lambda will be destroyed
# - 1 BedrockQueue will be destroyed
# - 1 BedrockQueueProcessor will be destroyed
# - IAM policies will be modified
```

#### 2.6 Deploy

```bash
# Deploy infrastructure changes
AWS_PROFILE=bobby npx cdk deploy --require-approval never

# Commit changes
git add .
git commit -m "Remove AWS Bedrock integration entirely

Deleted:
- 5 Bedrock Agents (Claude, Nova models)
- invoke-agent.js Lambda
- bedrock-agent-construct.js
- Bedrock SQS queue and processor
- Bedrock IAM policies
- Bedrock SDK dependency

Rationale: Ollama path is production-ready and provides identical
functionality at zero cost. Bedrock integration added $0-70/experiment
cost and unnecessary complexity.

Phase 2 of 3 - Infrastructure removal complete."

git push
```

#### 2.7 Test Thoroughly

```bash
# Trigger multiple experiments
./scripts/trigger-by-name.sh qwen2.5:7b
./scripts/trigger-by-name.sh llama3.1:8b
./scripts/trigger-by-name.sh qwen2.5:14b

# Verify all experiments complete
./scripts/check-batch-results.sh

# Check CloudWatch logs for errors
aws logs tail /aws/lambda/OrioleStack-* --follow --profile bobby
```

**Rollback Plan**:
```bash
git revert HEAD
git push
AWS_PROFILE=bobby npx cdk deploy --require-approval never
```

**Success Criteria**:
- ✅ CDK deployment succeeds
- ✅ All Bedrock resources deleted from AWS
- ✅ Experiments still run successfully
- ✅ No references to Bedrock in active code paths
- ✅ Stack is simpler and easier to understand

---

### Phase 3: Cleanup (Low Risk) 🧹 1 hour

**Goal**: Remove documentation, scripts, and optional parameters.

#### 3.1 Update Trigger Scripts

**File**: `scripts/trigger-by-name.sh`

Simplify to remove Bedrock model detection:
```bash
# Remove Lines 80-132 (Bedrock model detection)
# Remove Lines 95-123 (Agent ID lookups)

# Simplify to:
MODEL_NAME="$1"
EXPERIMENT_CONFIG="{
  \"modelName\": \"$MODEL_NAME\",
  \"llmProvider\": \"ollama\",
  \"promptVersion\": \"v6\",
  ...
}"
```

#### 3.2 Archive Documentation

```bash
# Create archive directory
mkdir -p docs/archive/bedrock

# Move Bedrock-specific docs
mv docs/BEDROCK_AGENT_LEARNINGS.md docs/archive/bedrock/
mv docs/aws/nova-*.html docs/archive/bedrock/
mv docs/aws/bedrock-*.html docs/archive/bedrock/

# Add deprecation notice
cat > docs/archive/bedrock/README.md << 'EOF'
# Bedrock Integration - Archived

These documents describe the AWS Bedrock integration that was removed
from Oriole on October 29, 2025.

Reason for removal: Ollama path provides identical functionality at
zero cost. Bedrock integration added $0-70/experiment cost.

See BEDROCK_DEPRECATION_PLAN.md for removal details.
EOF
```

#### 3.3 Update README.md

**File**: `README.md`

Update architecture section:
```markdown
## Architecture (BEFORE)
EventBridge → SQS (Bedrock/Ollama Queues) → Step Functions → Bedrock Agents OR Ollama

## Architecture (AFTER)
EventBridge → SQS (Ollama Queue) → Step Functions → Ollama
```

Remove sections:
- Bedrock Agents component description
- Bedrock rate limiting strategy
- Claude/Nova model configuration

Add section:
```markdown
## Previous Bedrock Integration

This project previously integrated with AWS Bedrock Agents (Claude and Nova models).
The integration was removed on October 29, 2025 in favor of local Ollama inference.

See `docs/archive/bedrock/` for historical documentation.
```

#### 3.4 Clean Parameter Store (Optional)

```bash
# Remove Bedrock-specific parameters
aws ssm delete-parameter --profile bobby --region us-west-2 --name /oriole/agents/claude-3-5-haiku/id
aws ssm delete-parameter --profile bobby --region us-west-2 --name /oriole/agents/claude-3-5-haiku/alias-id
aws ssm delete-parameter --profile bobby --region us-west-2 --name /oriole/agents/claude-3-haiku/id
aws ssm delete-parameter --profile bobby --region us-west-2 --name /oriole/agents/claude-3-haiku/alias-id
aws ssm delete-parameter --profile bobby --region us-west-2 --name /oriole/agents/nova-micro/id
aws ssm delete-parameter --profile bobby --region us-west-2 --name /oriole/agents/nova-micro/alias-id
aws ssm delete-parameter --profile bobby --region us-west-2 --name /oriole/agents/nova-lite/id
aws ssm delete-parameter --profile bobby --region us-west-2 --name /oriole/agents/nova-lite/alias-id
aws ssm delete-parameter --profile bobby --region us-west-2 --name /oriole/agents/nova-pro/id
aws ssm delete-parameter --profile bobby --region us-west-2 --name /oriole/agents/nova-pro/alias-id
aws ssm delete-parameter --profile bobby --region us-west-2 --name /oriole/agents/nova-premier/id
aws ssm delete-parameter --profile bobby --region us-west-2 --name /oriole/agents/nova-premier/alias-id

# Remove pricing parameters (if they exist)
aws ssm delete-parameters-by-path --profile bobby --region us-west-2 --path /oriole/bedrock/pricing

# Remove Bedrock-specific Lambda timeout
aws ssm delete-parameter --profile bobby --region us-west-2 --name /oriole/lambda/invoke-agent-max-execution-seconds
```

#### 3.5 Clean Database Schema (Optional - NOT RECOMMENDED)

**Only do this if you don't want token tracking for Ollama:**

```sql
-- Connect to database
PGPASSWORD='oR8tK3mP9vL2qN7xW4bZ6jH5yT1nM3s' psql \
  -h continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com \
  -U oriole_user \
  -p 5432 \
  -d oriole

-- Remove token/cost columns
ALTER TABLE experiments DROP COLUMN total_input_tokens;
ALTER TABLE experiments DROP COLUMN total_output_tokens;
ALTER TABLE experiments DROP COLUMN total_cost_usd;

ALTER TABLE agent_actions DROP COLUMN input_tokens;
ALTER TABLE agent_actions DROP COLUMN output_tokens;
ALTER TABLE agent_actions DROP COLUMN cost_usd;

-- Exit
\q
```

**Note**: These columns are useful for Ollama experiments too (tracking token usage even though cost = $0). **Recommend keeping them.**

#### 3.6 Final Commit

```bash
git add .
git commit -m "Complete Bedrock deprecation cleanup

Phase 3 of 3 - Cleanup complete:
- Archived Bedrock documentation
- Updated README architecture diagram
- Simplified trigger scripts
- Removed Bedrock parameters from Parameter Store

Bedrock integration fully removed. Oriole now runs entirely on
local Ollama models with zero external LLM API costs."

git push
```

**Success Criteria**:
- ✅ No references to Bedrock in user-facing documentation
- ✅ Trigger scripts simplified
- ✅ Parameter Store cleaned
- ✅ Historical docs archived for reference

---

## What to Keep (No Bedrock Dependency)

These components work with Ollama and should be retained:

### Lambda Functions
- ✅ `lambda/orchestration/invoke-agent-ollama.js` - Production Ollama path
- ✅ `lambda/orchestration/check-progress.js` - Works for both providers
- ✅ `lambda/orchestration/finalize-experiment.js`
- ✅ `lambda/orchestration/start-experiment.js` (after Phase 2 updates)
- ✅ `lambda/orchestration/queue-processor.js` - Ollama queue processor
- ✅ `lambda/actions/router.js` - Action handler (works for both)
- ✅ `lambda/actions/move_handler.js` - Movement logic
- ✅ `lambda/actions/recall.js` - Memory recall
- ✅ `lambda/shared/tools.js` - Tool definitions
- ✅ `lambda/shared/db.js` - Database operations
- ✅ `lambda/shared/vision.js` - Vision calculations
- ✅ `lambda/viewer/viewer.js` - Viewer UI

### Infrastructure
- ✅ Step Functions orchestration (minus Bedrock-specific states)
- ✅ EventBridge trigger
- ✅ OllamaExperimentQueue (SQS FIFO)
- ✅ OllamaQueueProcessorFunction (Lambda)
- ✅ RDS PostgreSQL database
- ✅ All database tables and views
- ✅ Viewer API Gateway

### Scripts
- ✅ `scripts/trigger-experiment.sh` (after Phase 3 updates)
- ✅ `scripts/check-batch-results.sh`
- ✅ `scripts/setup-db-parameters.sh`

### Documentation
- ✅ `README.md` (after Phase 3 updates)
- ✅ `docs/CHEATSHEET`
- ✅ This file (`docs/BEDROCK_DEPRECATION_PLAN.md`)

---

## Risk Assessment

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Accidentally break Ollama path | High | Low | Phase 1 tests Ollama thoroughly before deletions |
| Delete wrong Lambda in Phase 2 | High | Low | Review CDK diff carefully before deploy |
| Lose experiment history data | Medium | Very Low | Database unchanged - no data loss possible |
| Can't revert to Bedrock | Medium | Low | All changes in git, fully revertible |
| Miss a Bedrock reference | Low | Medium | Grep for "bedrock", "claude", "nova" before Phase 3 |
| Break viewer functionality | Low | Very Low | Viewer has no Bedrock dependencies |

---

## Estimated Impact

### Code Changes
- **Files deleted**: 8 files
- **CDK resources removed**: ~20 resources (5 agents, 2 Lambdas, 2 queues, IAM policies)
- **Lines of code removed**: ~800 lines
- **NPM dependencies removed**: 1 package

### Cost Savings
- **Before**: $0-70 per Bedrock experiment (depending on model and actions)
- **After**: $0 per experiment (local Ollama only)
- **Annual savings**: $0-25,000+ (depending on experiment volume)

### Functionality Lost
- ❌ Access to Claude 3.5 Haiku, Claude 3 Haiku models
- ❌ Access to Nova Micro, Lite, Pro, Premier models
- ❌ AWS-managed rate limiting and throttling
- ❌ Bedrock's built-in observability

### Functionality Retained
- ✅ All maze navigation capabilities
- ✅ Tool calling (move, recall)
- ✅ Vision processing
- ✅ Step Functions orchestration
- ✅ Database persistence
- ✅ Viewer UI
- ✅ Experiment tracking and analytics

---

## Timeline

| Phase | Duration | Effort | Risk |
|-------|----------|--------|------|
| Phase 1: Update Routing | 30 minutes | Low | Low |
| Phase 2: Remove Infrastructure | 2 hours | Medium | Medium |
| Phase 3: Cleanup | 1 hour | Low | Low |
| **Total** | **~4 hours** | **Medium** | **Low-Medium** |

**Recommended approach**: Execute phases sequentially with testing between each phase.

---

## Decision Checklist

Before proceeding, confirm:

- [ ] Ollama path is working in production
- [ ] No future need for Bedrock-exclusive models (Claude Opus, etc.)
- [ ] Current Ollama experiments meeting quality/performance needs
- [ ] Team comfortable with local-only LLM inference
- [ ] Ready to save $0-70 per experiment
- [ ] Have tested Ollama with all required model sizes (8B-16B)
- [ ] Understand this is reversible via git revert
- [ ] Have CDK deployment permissions
- [ ] Have Parameter Store write permissions (for Phase 3)

---

## Rollback Procedures

### If Phase 1 Fails
```bash
git revert HEAD
AWS_PROFILE=bobby npx cdk deploy --require-approval never
```

### If Phase 2 Fails
```bash
git revert HEAD~2..HEAD  # Revert Phase 1 and 2
AWS_PROFILE=bobby npx cdk deploy --require-approval never
./scripts/setup-agent-ids.sh  # Restore agent IDs
```

### If Phase 3 Fails
```bash
git revert HEAD  # Revert Phase 3 only
git push
# Manually restore Parameter Store values if needed
```

---

## Post-Deprecation Validation

After completing all phases, verify:

1. **Functionality**
   - [ ] Can trigger experiments via trigger-by-name.sh
   - [ ] Experiments complete successfully
   - [ ] Viewer shows experiments correctly
   - [ ] Database records all actions

2. **Infrastructure**
   - [ ] No Bedrock resources in AWS Console
   - [ ] CloudFormation stack deploys cleanly
   - [ ] Step Functions executions succeed
   - [ ] Lambda logs show no Bedrock errors

3. **Code Quality**
   - [ ] No references to "bedrock" in active code (grep -r "bedrock" lambda/)
   - [ ] No references to "claude" or "nova" in active code
   - [ ] CDK synth succeeds without errors
   - [ ] All tests pass (if you have tests)

4. **Documentation**
   - [ ] README reflects Ollama-only architecture
   - [ ] Bedrock docs archived
   - [ ] This deprecation plan marked as complete

---

## Completion Criteria

This deprecation is complete when:

1. ✅ All 3 phases executed successfully
2. ✅ No Bedrock resources exist in AWS
3. ✅ All experiments run on Ollama
4. ✅ Costs = $0 per experiment
5. ✅ Documentation updated
6. ✅ Team trained on Ollama-only workflow
7. ✅ Post-deprecation validation checklist complete

---

## Lessons Learned (Pain-Driven Development)

This deprecation is a direct result of **Pain-Driven Development (PDD)**:

1. **Initial pain**: $70 Bedrock cost from context accumulation bug
2. **Reaction**: "No more context! Fresh slate every turn!"
3. **Accidental genius**: Created stateless architecture superior to "smart" context preservation
4. **Result**: Event sourcing pattern with bounded context
5. **Bonus**: Realized Ollama provides same functionality at $0 cost

**Key insight**: Sometimes the constraint (avoiding cost) drives better architecture than careful planning would have produced.

---

## References

- Original Bedrock integration: `docs/archive/bedrock/BEDROCK_AGENT_LEARNINGS.md` (after Phase 3)
- Ollama integration: `lambda/orchestration/invoke-agent-ollama.js`
- Architecture decisions: `README.md`
- Development practices: `docs/CHEATSHEET`

---

## Approval

Before executing this plan:

- [ ] Reviewed by: _______________
- [ ] Approved by: _______________
- [ ] Scheduled for: _______________

**Status**: Draft - Not yet executed
