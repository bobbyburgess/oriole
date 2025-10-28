# Experiment Batch History

Record of major experiment batches run in the Oriole maze navigation system.

## Batch 4: Llama Models with Reduced Action Limit (Oct 28, 2025 - 12:30 AM)

**Objective:** Test Llama models with 250-step limit (half of previous 500)

### Motivation

Batch 1-3 results showed:
- **Zero successes** at 500-step limit
- All experiments hit max actions without finding goal
- Need to test if models can succeed with tighter constraints
- Hypothesis: Shorter limit may force more efficient exploration

### Configuration Changes

- **max_moves**: 500 → **250** (50% reduction)
- All other params unchanged from Batch 3 optimal config

### Models Tested

| Exp # | Model | Prompt | Config |
|-------|-------|--------|--------|
| 32 | llama3.2:3b | v1 | ctx=32K, temp=0.1, rep_pen=1.4 |
| 33 | llama3.2:3b | v5 | ctx=32K, temp=0.1, rep_pen=1.4 |
| 34 | llama3.1:8b | v1 | ctx=32K, temp=0.1, rep_pen=1.4 |
| 35 | llama3.1:8b | v5 | ctx=32K, temp=0.1, rep_pen=1.4 |

**Total:** 4 experiments

### Hypotheses

1. **Lower limit forces efficiency:** Models may navigate more purposefully
2. **Small models suffer:** 3b model lacks capacity for strategic planning
3. **Prompt matters more:** With less room for error, v5's detail helps
4. **Still too hard:** Even 250 steps insufficient for blind 60×60 exploration

### Expected Outcomes

**Pessimistic:** All 4 fail to find goal (limit still too low)
**Realistic:** 0-1 successes (lucky initial direction)
**Optimistic:** 2+ successes (models adapt strategy under constraint)

---

## Batch 3: Multi-Model Comparison (Oct 27, 2025 - 11:08 PM)

**Objective:** Compare 6 different LLM architectures across 2 prompt styles

### Models Tested

| Model | Size | Family | Notes |
|-------|------|--------|-------|
| qwen2.5:7b | 7B | Qwen | Baseline from previous sweep |
| qwen2.5:14b | 14B | Qwen | Larger Qwen variant |
| llama3.2:3b | 3B | Llama | Smallest, fastest |
| llama3.1:8b | 8B | Llama | Similar size to qwen2.5:7b |
| deepseek-r1:7b | 7B | DeepSeek | Reasoning specialist |
| gpt-oss:20b | 20B | GPT-OSS | Largest model tested |

### Prompt Versions

**v1 (Simple):**
```
You are navigating a 2D maze on a 60x60 grid. Your goal is to find the target object.
You can see 3 blocks in each cardinal direction (line-of-sight: walls block vision).
Use move_north, move_south, move_east, move_west to navigate.
Use recall_last_25, recall_last_50, recall_last_100, or recall_last_200 to review
tiles you have seen (choose based on how much context you want to use).
```

**v5 (Detailed):**
```
You are navigating a static 60x60 grid (X: 0-59, Y: 0-59). Explore this space efficiently
until you find the stationary GOAL marker. Choose your movements based on your own
judgement and strategy.

YOUR VISION: You see your current tile plus 3 tiles in each cardinal direction
(walls block vision beyond them).

YOUR MOVEMENT: You move one tile at a time using move_north, move_south, move_east, move_west.
- North = Y-1 (decreasing)
- South = Y+1 (increasing)
- East = X+1 (increasing)
- West = X-1 (decreasing)
- Failed moves (hitting walls/boundaries) keep you at the same position.
- If a move fails once, it will always fail - walls and boundaries never change.

YOUR MEMORY: Rely on your own memory as much as feasible, but you can also use recall_all
to retrieve all previously seen tiles. This returns every tile you've observed with its
type (empty, wall, or GOAL).
```

### Configuration

**Fixed Parameters (optimal from Batch 2):**
- `num_ctx`: 32768
- `temperature`: 0.1
- `repeat_penalty`: 1.4
- `max_actions_per_turn`: 50
- `vision_range`: 3
- `maze_id`: 1 (60x60 sparse maze)

### Experiment Matrix

| Exp # | Model | Prompt | Expected Behavior |
|-------|-------|--------|-------------------|
| 13 | qwen2.5:7b | v1 | Baseline (already completed) |
| 20 | qwen2.5:7b | v5 | Test if detailed prompt helps |
| 21 | qwen2.5:14b | v1 | Does size improve performance? |
| 22 | qwen2.5:14b | v5 | 14B + detailed prompt |
| 23 | llama3.2:3b | v1 | How does small model perform? |
| 24 | llama3.2:3b | v5 | Can detailed prompt compensate for size? |
| 25 | llama3.1:8b | v1 | Llama vs Qwen at similar size |
| 26 | llama3.1:8b | v5 | Llama with detailed instructions |
| 27 | deepseek-r1:7b | v1 | Reasoning specialist baseline |
| 28 | deepseek-r1:7b | v5 | Does reasoning model benefit from detail? |
| 29 | gpt-oss:20b | v1 | Large model baseline |
| 30 | gpt-oss:20b | v5 | Large model + detailed prompt |

**Total:** 12 experiments (11 new + 1 existing)

### Hypotheses to Test

1. **Model Size:** Does 20B outperform 7B outperform 3B?
2. **Model Family:** Qwen vs Llama vs DeepSeek vs GPT-OSS architecture differences
3. **Prompt Detail:** Does v5's explicit mechanics help or hurt?
4. **Reasoning Specialization:** Does deepseek-r1 excel at spatial reasoning?
5. **Size vs Prompt:** Can detailed prompt (v5) compensate for smaller model size?

### Expected Results

**If size matters most:**
- gpt-oss:20b > qwen2.5:14b > qwen2.5:7b/llama3.1:8b > llama3.2:3b

**If prompt engineering matters:**
- All v5 > corresponding v1

**If architecture matters:**
- deepseek-r1 performs disproportionately well for spatial tasks

### Analysis Queries

After completion, use these QuickSight/SQL queries:

```sql
-- Model comparison (same prompt)
SELECT
  model_name,
  prompt_version,
  AVG((SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id)) as avg_actions,
  AVG((SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = e.id)) as avg_turns
FROM experiments e
WHERE id >= 20
  AND prompt_version = 'v1'
GROUP BY model_name, prompt_version
ORDER BY avg_actions;

-- Prompt impact (same model)
SELECT
  model_name,
  prompt_version,
  AVG((SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id)) as avg_actions
FROM experiments e
WHERE id >= 20
GROUP BY model_name, prompt_version
ORDER BY model_name, prompt_version;
```

---

## Batch 2: Parameter Sweep (Oct 27, 2025 - 10:00 PM)

**Objective:** Find optimal hyperparameters for qwen2.5:7b

### Configuration Space

- `num_ctx`: [2048, 8192, 32768]
- `temperature`: [0.0, 0.1, 0.2, 0.5, 0.7, 1.0]
- `repeat_penalty`: [1.0, 1.2, 1.4, 1.6]

**Total:** 12 experiments

### Results

**Winner:**
- context=32K, temperature=0.1, repeat_penalty=1.4
- 5.1 actions/turn (best planning efficiency)
- 99 turns total
- 15.7 minutes duration

**Key Findings:**
- 2K context causes fragmentation (3.8 actions/turn)
- Temperature 0.1 balances determinism and exploration
- 32K context enables longer multi-step plans

---

## Batch 1: Initial Baseline (Oct 27-28, 2025)

**Objective:** Establish baseline performance for qwen2.5:7b

- Experiment IDs: 9-16
- Mixed configurations (before systematic sweep)
- Identified need for structured parameter sweep

---

## Future Batches

### Planned: Maze Complexity Comparison

Test winning model/prompt across different maze types:
- Sparse (current)
- Dense
- Open field
- Spiral
- Rooms & corridors

### Planned: Bedrock Agent Comparison

Compare Ollama models against AWS Bedrock:
- Claude 3.5 Haiku
- Claude 3.5 Sonnet
- Amazon Nova models

Cost vs performance tradeoff analysis.
