# Prompt Versioning Guide

How to manage and version prompts for maze navigation experiments.

## Philosophy

**Problem:** Storing full prompt text in the database creates massive duplication (same prompt stored 1000x for 1000 experiments).

**Solution:** Store prompts once in Parameter Store, reference by version name in experiments table.

## Naming Convention

**Format:** `YYYYMMDD_vNNN`

**Examples:**
- `20251027_v001` - First version on October 27, 2025
- `20251027_v002` - Second version same day (after fixing typo)
- `20251028_v001` - First version on October 28, 2025

**Benefits:**
- Self-documenting (timestamp shows when created)
- Chronological ordering (sorts naturally)
- No ambiguity (unlike "v1", "v2" which don't tell you when they were created)
- Easy to find: `aws ssm get-parameters-by-path --path /oriole/prompts/`

## Quick Start

### List all available prompts

```bash
./scripts/manage-prompts.sh list
```

### View a specific prompt

```bash
./scripts/manage-prompts.sh view 20251027_v001
```

### Create a new prompt from file

```bash
# 1. Write your prompt to a file
cat > /tmp/my-new-prompt.txt <<'EOF'
You are a maze navigation agent. Your goal is to find the goal marker.

Use the following tools to navigate:
- move_north: Move one step north
- move_south: Move one step south
- move_east: Move one step east
- move_west: Move one step west

After each move, you will receive vision feedback showing what you can see.
EOF

# 2. Create the prompt version (auto-generates version name)
./scripts/manage-prompts.sh create /tmp/my-new-prompt.txt

# Output: Created prompt version: 20251027_v001
```

### Copy existing prompt to new version

Useful when making small edits:

```bash
# 1. Copy existing version
./scripts/manage-prompts.sh copy 20251027_v001 20251028_v001

# 2. Edit the new version in Parameter Store console
# OR use AWS CLI:
aws ssm put-parameter \
  --name /oriole/prompts/20251028_v001 \
  --value "$(cat /tmp/updated-prompt.txt)" \
  --type String \
  --overwrite \
  --profile bobby
```

### Find latest prompt version

```bash
./scripts/manage-prompts.sh latest
```

## Using Prompts in Experiments

### Single experiment

```bash
./scripts/trigger-experiment.sh \
  OLLAMA \
  NOTUSED \
  qwen2.5:7b \
  1 \
  20251027_v001
```

### Parameter sweep with specific prompt

Edit `scripts/run-parameter-sweep.sh` and change:

```bash
PROMPT_VERSION="v1"  # Old way
```

To:

```bash
PROMPT_VERSION="20251027_v001"  # New way
```

## Database Storage

The `experiments` table stores only the **version name**, not the full text:

```sql
SELECT id, prompt_version, model_name
FROM experiments
ORDER BY id DESC
LIMIT 5;
```

```
 id | prompt_version | model_name
----+----------------+------------
 17 | 20251027_v001  | qwen2.5:7b
 16 | 20251027_v001  | qwen2.5:7b
 15 | v1             | qwen2.5:7b  -- Old naming
```

## Querying Experiments by Prompt

Find all experiments using a specific prompt:

```sql
SELECT
  id,
  prompt_version,
  model_name,
  goal_found,
  (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id) as total_actions
FROM experiments e
WHERE prompt_version = '20251027_v001'
ORDER BY id DESC;
```

There's an index on `prompt_version` for fast filtering:

```sql
\d experiments
-- Shows: "idx_experiments_prompt_version" btree (prompt_version)
```

## Best Practices

### 1. Never Modify Existing Prompts

**Don't:**
```bash
# This breaks reproducibility!
aws ssm put-parameter \
  --name /oriole/prompts/20251027_v001 \
  --value "Updated text..." \
  --overwrite
```

**Do:**
```bash
# Create new version instead
./scripts/manage-prompts.sh copy 20251027_v001 20251028_v001
# Then edit the new version
```

### 2. Use Descriptive Names for Major Changes

For small iteration:
- `20251027_v001` → `20251027_v002` (same day, minor tweak)

For major rewrites:
- `20251027_v001` → `20251028_v001` (new day, signals major change)

### 3. Keep a Changelog

Create a simple text file tracking what changed:

```bash
# docs/prompt-changelog.md
## 20251028_v001
- Added explicit instruction to avoid revisiting positions
- Clarified that walls block movement
- Changed from 2nd person to 1st person voice

## 20251027_v002
- Fixed typo: "noth" → "north"

## 20251027_v001
- Initial version (migrated from Parameter Store "v1")
```

### 4. Migrate Old Prompts

If you have old prompts with simple names like "v1", migrate them:

```bash
# 1. View old prompt
aws ssm get-parameter --name /oriole/prompts/v1 --query 'Parameter.Value' --output text

# 2. Copy to new naming convention
./scripts/manage-prompts.sh copy v1 20251027_v001

# 3. Update trigger scripts to use new name
```

## Troubleshooting

### "Parameter not found" error

```bash
# Check if version exists
./scripts/manage-prompts.sh list

# View all Parameter Store paths
aws ssm get-parameters-by-path --path /oriole/prompts/ --profile bobby
```

### Experiments using wrong prompt

Check what was actually stored:

```sql
SELECT id, prompt_version, started_at
FROM experiments
WHERE id = 123;
```

Then view that prompt version:

```bash
./scripts/manage-prompts.sh view 20251027_v001
```

### Need to see what prompt was used historically

The `prompt_version` column tells you which version was used. Fetch from Parameter Store:

```bash
# If prompt still exists in Parameter Store
./scripts/manage-prompts.sh view 20251027_v001

# If you deleted it (don't do this!), you need backups
```

## AWS Parameter Store Direct Commands

For advanced users:

```bash
# List all prompts
aws ssm get-parameters-by-path \
  --path /oriole/prompts/ \
  --profile bobby \
  --region us-west-2

# Get specific prompt
aws ssm get-parameter \
  --name /oriole/prompts/20251027_v001 \
  --profile bobby \
  --region us-west-2 \
  --query 'Parameter.Value' \
  --output text

# Create prompt manually
aws ssm put-parameter \
  --name /oriole/prompts/20251028_v001 \
  --value "$(cat prompts/my-prompt.txt)" \
  --type String \
  --description "Added loop prevention instructions" \
  --profile bobby \
  --region us-west-2

# Delete prompt (CAREFUL!)
aws ssm delete-parameter \
  --name /oriole/prompts/20251027_v001 \
  --profile bobby \
  --region us-west-2
```

## Integration with QuickSight

Query experiments by prompt version in QuickSight:

```sql
SELECT
  e.prompt_version,
  COUNT(*) as experiment_count,
  AVG((SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id)) as avg_actions,
  SUM(CASE WHEN goal_found THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as success_rate
FROM experiments e
WHERE e.model_name = 'qwen2.5:7b'
  AND e.completed_at IS NOT NULL
GROUP BY e.prompt_version
ORDER BY e.prompt_version DESC;
```

This lets you compare effectiveness across different prompt versions.

## Related Documentation

- [OLLAMA_INTEGRATION.md](./OLLAMA_INTEGRATION.md) - How Ollama uses prompts
- [README.md](../README.md) - Overall system architecture
- [QUICKSIGHT_SETUP.md](./QUICKSIGHT_SETUP.md) - Analyzing prompt effectiveness
