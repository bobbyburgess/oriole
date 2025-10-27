# Data Model

PostgreSQL database schema for experiment tracking and maze storage.

```mermaid
erDiagram
    EXPERIMENTS ||--o{ AGENT_ACTIONS : has
    MAZES ||--o{ EXPERIMENTS : uses

    EXPERIMENTS {
        integer id PK
        varchar agent_id "Bedrock agent ID or 'OLLAMA'"
        varchar model_name "e.g., llama3.1:8b, qwen2.5:7b"
        varchar prompt_version "e.g., v5"
        integer maze_id FK
        text goal_description
        integer start_x
        integer start_y
        timestamp started_at
        timestamp completed_at "NULL for running/stale"
        boolean goal_found
        text failure_reason "NULL for success"
        jsonb model_config "NULL for Bedrock, config for Ollama"
    }

    AGENT_ACTIONS {
        integer id PK
        integer experiment_id FK
        integer step_number "Sequential action counter"
        varchar action_type "move_north, recall_all, etc."
        text reasoning "LLM's explanation"
        integer from_x "Position before move"
        integer from_y
        integer to_x "Position after move (NULL for recall)"
        integer to_y
        boolean success "false if hit wall"
        jsonb tiles_seen "Vision data: {\"x,y\": 0|1|2}"
        timestamp timestamp
        integer input_tokens
        integer output_tokens
        integer turn_number "Groups actions by turn"
    }

    MAZES {
        integer id PK
        varchar name "e.g., 01_sparse_maze"
        integer width "60"
        integer height "60"
        bytea layout "Compressed binary grid"
    }
```

## Table Details

### experiments
**Purpose**: One row per experiment run

**Key Fields**:
- `model_config`: **NEW!** JSONB storing model parameters for A/B testing
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
- `completed_at`: NULL means running or stale (timed out without finalization)
- `goal_found`: Set at finalization, indicates success/failure

**Indexes**:
- `idx_experiments_model_name` (btree)
- `idx_experiments_prompt_version` (btree)
- `idx_experiments_maze_id` (btree)
- `idx_experiments_model_config` (gin) - **NEW!** Fast JSONB queries

**Lifecycle States**:
```
1. Created      → completed_at = NULL, goal_found = false
2. Running      → completed_at = NULL, actions within 5 min
3. Stale        → completed_at = NULL, no actions for 5+ min (zombie)
4. Completed    → completed_at = timestamp, goal_found = true/false
```

---

### agent_actions
**Purpose**: Every action the agent takes (moves, recalls)

**Key Fields**:
- `step_number`: Global action counter (1, 2, 3, ...)
- `turn_number`: Groups actions into turns (1-8 actions per turn)
- `tiles_seen`: JSONB vision data from this action
  ```json
  {
    "25,10": 0,  // EMPTY
    "25,11": 1,  // WALL
    "26,10": 2   // GOAL!
  }
  ```
- `success`: false when hitting walls
- `input_tokens` / `output_tokens`: For cost tracking and analysis

**Indexes**:
- `idx_agent_actions_experiment_id` (btree)
- `idx_agent_actions_step_number` (btree, composite with experiment_id)
- `idx_agent_actions_turn` (btree, composite with experiment_id)

**Cascade Delete**: Deleting an experiment deletes all its actions

---

### mazes
**Purpose**: Maze layout storage (60x60 grids)

**Key Fields**:
- `layout`: Compressed binary representation
  - 0 = EMPTY (navigable)
  - 1 = WALL (blocked)
  - 2 = GOAL (target to find)

**Example Query**:
```sql
-- Get maze cell at position (25, 10)
SELECT get_byte(layout, y * width + x) as cell_type
FROM mazes
WHERE id = 1
  AND x = 25
  AND y = 10;
```

---

## Common Queries

### 1. Experiment with Config
```sql
SELECT
  id,
  model_name,
  model_config->>'temperature' as temp,
  model_config->>'num_ctx' as ctx,
  goal_found
FROM experiments
WHERE model_config IS NOT NULL
ORDER BY id DESC;
```

### 2. Action Statistics per Experiment
```sql
SELECT
  e.id,
  e.model_name,
  COUNT(*) as total_actions,
  COUNT(DISTINCT turn_number) as turns,
  SUM(CASE WHEN success = false THEN 1 ELSE 0 END) as wall_hits,
  COUNT(DISTINCT (to_x, to_y)) as unique_positions
FROM experiments e
JOIN agent_actions a ON e.id = a.experiment_id
WHERE e.id = 340
GROUP BY e.id, e.model_name;
```

### 3. Get Full Action Sequence
```sql
SELECT
  step_number,
  action_type,
  from_x, from_y,
  to_x, to_y,
  success,
  reasoning
FROM agent_actions
WHERE experiment_id = 340
ORDER BY step_number;
```

### 4. Recall Memory Aggregation
```sql
-- Get all tiles seen across all actions (what recall_all returns)
SELECT
  key as position,
  value as tile_type
FROM agent_actions,
     jsonb_each_text(tiles_seen)
WHERE experiment_id = 340
  AND step_number <= 2000  -- Last 2000 actions
GROUP BY key, value;
```

### 5. Compare Configs
```sql
-- A/B test: temperature impact
SELECT
  model_config->>'temperature' as temp,
  COUNT(*) as experiments,
  AVG(CASE WHEN goal_found THEN 1 ELSE 0 END) as success_rate
FROM experiments
WHERE model_config->>'temperature' IN ('0.2', '0.7')
GROUP BY model_config->>'temperature';
```

---

## Storage Estimates

### For 100 Experiments:

**experiments table**:
- 100 rows × ~500 bytes = **50 KB**
- `model_config` adds ~200 bytes each = **+20 KB**

**agent_actions table** (avg 2000 actions per experiment):
- 200,000 rows × ~1 KB (with tiles_seen) = **200 MB**

**mazes table**:
- 60×60 grid = 3,600 bytes per maze
- 10 mazes = **36 KB**

**Total**: ~**200 MB** for 100 experiments (mostly action logs)

---

## JSONB Index Performance

```sql
-- Fast query (uses GIN index)
EXPLAIN ANALYZE
SELECT COUNT(*)
FROM experiments
WHERE model_config->>'num_ctx' = '32768';

-- Result: Index Scan on idx_experiments_model_config
-- Execution time: 0.5ms (even with 10,000 rows)
```

**Why GIN Index?**
- Supports `->`, `->>`, `@>`, `?` operators
- Fast for "contains" queries
- Handles any JSON structure (future-proof)
