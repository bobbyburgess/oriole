# Oriole System Diagrams

Visual documentation of the Oriole AI agent maze navigation platform architecture and data flows.

## 📋 Diagram Index

### 1. [System Architecture](./architecture.md)
**Overview**: High-level system architecture showing all components and their relationships

**Key Concepts**:
- External LLM providers (AWS Bedrock, Ollama)
- AWS infrastructure (Step Functions, Lambda, RDS, Parameter Store)
- Frontend viewer and API
- Data flow between components

**When to read**: First introduction to the system

---

### 2. [Experiment Flow](./experiment-flow.md)
**Overview**: Complete lifecycle of an experiment from start to completion

**Key Concepts**:
- Step Functions state machine workflow
- Provider routing (Bedrock vs Ollama)
- Turn loop execution
- Success/failure conditions
- Timeout handling (application vs infrastructure)

**When to read**: Understanding how experiments run end-to-end

---

### 3. [Agent Turn Loop](./agent-turn.md)
**Overview**: Detailed sequence of a single agent turn with LLM function calling

**Key Concepts**:
- Ollama API integration
- Function calling (tool use)
- Action execution and vision feedback
- Context window management
- Message history building

**When to read**: Understanding how the agent makes decisions each turn

---

### 4. [Data Model](./data-model.md)
**Overview**: PostgreSQL database schema and table relationships

**Key Concepts**:
- `experiments` table with `model_config` JSONB
- `agent_actions` table for action logging
- `mazes` table for grid layouts
- Indexes for performance
- Common query patterns

**When to read**: Working with database queries or analysis

---

### 5. [Parameter Configuration Flow](./parameter-flow.md)
**Overview**: How model parameters flow from Parameter Store to database and runtime

**Key Concepts**:
- Parameter Store structure
- Configuration capture at experiment start
- Runtime parameter usage with caching
- Two-level caching strategy
- Analysis queries for A/B testing

**When to read**: Configuring model parameters or analyzing parameter impact

---

## 🎯 Quick Navigation

### I want to understand...

**"How does the whole system work?"**
→ Start with [System Architecture](./architecture.md)

**"How does an experiment run from start to finish?"**
→ Read [Experiment Flow](./experiment-flow.md)

**"How does the agent think and make decisions?"**
→ Read [Agent Turn Loop](./agent-turn.md)

**"What data is stored and how?"**
→ Read [Data Model](./data-model.md)

**"How do I change model settings and analyze their impact?"**
→ Read [Parameter Configuration Flow](./parameter-flow.md)

---

## 🔑 Key Insights

### Context Window Problem (Solved!)

**Before** (Experiments 340-343):
- Default `num_ctx`: 2,048 tokens
- Actual usage: 25,939 tokens
- **92% of context truncated!** ❌

**After** (Current):
- Configured `num_ctx`: 32,768 tokens
- Full conversation history preserved ✅
- Recall data actually visible to models ✅

**Impact**: Expected 50-70% reduction in wall hits, 3-5x improvement in exploration

---

### Model Configuration Tracking

**Problem**: No way to compare experiments with different settings

**Solution**: `model_config` JSONB column captures all parameters:
```json
{
  "num_ctx": 32768,
  "temperature": 0.2,
  "num_predict": 2000,
  "repeat_penalty": 1.4,
  "recall_interval": 10,
  "max_recall_actions": 50,
  "max_moves": 10000,
  "max_duration_minutes": 120
}
```

**Impact**: Enable scientific A/B testing and reproducibility

---

### Timeout Hierarchy

1. **Application Limits** (Graceful):
   - `max_moves`: 10,000 actions
   - `max_duration_minutes`: 120 minutes
   - Result: Sets `completed_at`, proper finalization

2. **Infrastructure Limit** (Hard Stop):
   - Step Functions: 7,200 seconds (2 hours)
   - Result: Kills execution, creates "zombie" experiment
   - Fixed: Viewer detects stale (no actions in 5 min)

**Best Practice**: Keep both limits aligned (both at 2 hours)

---

## 📊 Key Metrics to Track

### Exploration Efficiency
```sql
-- Unique positions visited per action
SELECT
  id,
  model_name,
  (SELECT COUNT(DISTINCT (to_x, to_y))
   FROM agent_actions
   WHERE experiment_id = experiments.id)::float /
  (SELECT COUNT(*)
   FROM agent_actions
   WHERE experiment_id = experiments.id) as efficiency
FROM experiments
ORDER BY efficiency DESC;
```

### Wall Hit Rate
```sql
-- Percentage of moves that hit walls
SELECT
  id,
  model_name,
  ROUND(100.0 * SUM(CASE WHEN success = false THEN 1 ELSE 0 END) / COUNT(*), 1) as wall_hit_pct
FROM experiments e
JOIN agent_actions a ON e.id = a.experiment_id
WHERE a.action_type LIKE 'move_%'
GROUP BY id, model_name;
```

### Parameter Impact
```sql
-- Compare temperature settings
SELECT
  model_config->>'temperature' as temp,
  model_name,
  COUNT(*) as experiments,
  AVG(goal_found::int) as success_rate
FROM experiments
WHERE model_config->>'temperature' IS NOT NULL
GROUP BY model_config->>'temperature', model_name;
```

---

## 🏗️ System Design Principles

### 1. Stateless Orchestration
- Lambda functions are stateless
- All state stored in PostgreSQL
- Step Functions passes position between steps
- Enables horizontal scaling

### 2. Provider Abstraction
- Same workflow handles Bedrock and Ollama
- Choice state routes to correct handler
- Action router provides common interface
- Easy to add new LLM providers

### 3. Configuration as Code
- All parameters in Parameter Store
- No hardcoded values
- Change settings without deployment
- Historical tracking via `model_config`

### 4. Data-Driven Optimization
- Every action logged with reasoning
- Token usage tracked
- JSONB for flexible schema
- GIN indexes for fast queries

### 5. Graceful Degradation
- Fallback defaults if Parameter Store fails
- Timeout handling at multiple levels
- Stale experiment detection
- Error logging for debugging

---

## 🚀 Common Development Tasks

### Add a New Parameter
1. Create in Parameter Store:
   ```bash
   aws ssm put-parameter \
     --name /oriole/ollama/top-p \
     --value 0.9
   ```

2. Update `getOllamaOptions()` in `invoke-agent-ollama.js`:
   ```javascript
   const topP = await ssmClient.send(...)
     .then(r => parseFloat(r.Parameter.Value))
     .catch(() => 0.9);
   modelOptionsCache.top_p = topP;
   ```

3. Update `start-experiment.js` to capture:
   ```javascript
   modelConfig.top_p = topP;
   ```

4. Deploy!

### Query Parameter Impact
```sql
SELECT
  model_config->>'new_param' as param_value,
  AVG(goal_found::int) as success_rate
FROM experiments
WHERE model_config->>'new_param' IS NOT NULL
GROUP BY model_config->>'new_param';
```

### Debug Stuck Agent
```sql
-- Find repeated failed moves
SELECT
  from_x, from_y, action_type,
  COUNT(*) as attempts
FROM agent_actions
WHERE experiment_id = 350
  AND success = false
GROUP BY from_x, from_y, action_type
HAVING COUNT(*) > 10
ORDER BY attempts DESC;
```

---

## 📚 Additional Resources

- **Source Code**: `/Users/bobbyburgess/Documents/code/oriole/`
- **Lambda Functions**: `lambda/` directory
- **CDK Infrastructure**: `lib/oriole-stack.js`
- **Database Migrations**: Manual SQL scripts
- **Viewer UI**: Served via API Gateway

## 🤝 Contributing

When adding new features:
1. Update relevant diagrams in Mermaid format
2. Add comments to code referencing diagram sections
3. Document new parameters in Parameter Flow
4. Add example queries in Data Model

---

## 🎓 Learning Path

**Beginner** (New to the system):
1. System Architecture
2. Experiment Flow
3. Try running an experiment

**Intermediate** (Running experiments):
1. Agent Turn Loop
2. Parameter Configuration Flow
3. A/B test temperature settings

**Advanced** (Optimizing performance):
1. Data Model (all queries)
2. Parameter impact analysis
3. Custom parameter tuning

---

**Last Updated**: 2025-01-27
**Version**: 1.0 (Initial comprehensive documentation)
