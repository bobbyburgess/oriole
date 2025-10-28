# QuickSight Setup for Oriole Analytics

Complete guide to setting up AWS QuickSight for analyzing Oriole maze navigation experiments.

## Prerequisites

✅ QuickSight Enterprise Edition account
✅ RDS PostgreSQL database with experiment data
✅ AWS CLI configured with appropriate permissions

## Step 1: Create Data Source (COMPLETED ✅)

The data source has been created and is accessible:

```bash
# Data source details
Name: Oriole PostgreSQL Database (Public)
Type: PostgreSQL
Connection: Public internet (SSL enabled)
Status: CREATION_SUCCESSFUL
```

**Connection Details:**
- Host: `continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com`
- Port: `5432`
- Database: `oriole`
- SSL: Enabled
- VPC Connection: Not used (public internet access)

**Note:** We initially attempted VPC connection but encountered routing issues. Since RDS is already secured with password auth and SSL encryption, public internet access is acceptable for now.

## Step 2: Create Your First Dataset

### Option A: Via AWS CLI

Create a custom SQL dataset for parameter sweep analysis:

```bash
# Create parameter sweep summary dataset
aws quicksight create-data-set \
  --aws-account-id 864899863517 \
  --data-set-id "parameter-sweep-summary" \
  --name "Parameter Sweep Summary" \
  --physical-table-map '{
    "ParameterSweep": {
      "CustomSql": {
        "DataSourceArn": "arn:aws:quicksight:us-west-2:864899863517:datasource/oriole-postgres",
        "Name": "ParameterSweepQuery",
        "SqlQuery": "SELECT \n  (e.model_config->>'\''num_ctx'\'')::integer as context_window,\n  (e.model_config->>'\''temperature'\'')::float as temperature,\n  (e.model_config->>'\''repeat_penalty'\'')::float as repeat_penalty,\n  COUNT(*) as experiment_count,\n  AVG((SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id)) as avg_actions,\n  AVG((SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = e.id)) as avg_turns,\n  ROUND(AVG((SELECT COUNT(*)::numeric / NULLIF(MAX(turn_number), 0) FROM agent_actions WHERE experiment_id = e.id)), 2) as avg_actions_per_turn,\n  SUM(CASE WHEN goal_found THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as success_rate_pct,\n  AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60.0) as avg_duration_minutes\nFROM experiments e\nWHERE e.model_name = '\''qwen2.5:7b'\''\n  AND e.completed_at IS NOT NULL\nGROUP BY \n  (e.model_config->>'\''num_ctx'\'')::integer,\n  (e.model_config->>'\''temperature'\'')::float,\n  (e.model_config->>'\''repeat_penalty'\'')::float\nORDER BY context_window, temperature, repeat_penalty;",
        "Columns": [
          {"Name": "context_window", "Type": "INTEGER"},
          {"Name": "temperature", "Type": "DECIMAL"},
          {"Name": "repeat_penalty", "Type": "DECIMAL"},
          {"Name": "experiment_count", "Type": "INTEGER"},
          {"Name": "avg_actions", "Type": "DECIMAL"},
          {"Name": "avg_turns", "Type": "DECIMAL"},
          {"Name": "avg_actions_per_turn", "Type": "DECIMAL"},
          {"Name": "success_rate_pct", "Type": "DECIMAL"},
          {"Name": "avg_duration_minutes", "Type": "DECIMAL"}
        ]
      }
    }
  }' \
  --import-mode "SPICE" \
  --permissions '[{
    "Principal": "arn:aws:quicksight:us-west-2:864899863517:user/default/bobbyburgess",
    "Actions": [
      "quicksight:DescribeDataSet",
      "quicksight:DescribeDataSetPermissions",
      "quicksight:PassDataSet",
      "quicksight:DescribeIngestion",
      "quicksight:ListIngestions",
      "quicksight:UpdateDataSet",
      "quicksight:DeleteDataSet",
      "quicksight:CreateIngestion",
      "quicksight:CancelIngestion",
      "quicksight:UpdateDataSetPermissions"
    ]
  }]' \
  --profile bobby \
  --region us-west-2
```

### Option B: Via QuickSight Console (Recommended for First Time)

1. **Go to QuickSight Console:**
   ```
   https://us-west-2.quicksight.aws.amazon.com/
   ```

2. **Create New Dataset:**
   - Click "Datasets" → "New dataset"
   - Select data source: "Oriole PostgreSQL Database (Public)"
   - Choose "Use custom SQL"

3. **Paste This SQL:**
   ```sql
   SELECT
     (e.model_config->>'num_ctx')::integer as context_window,
     (e.model_config->>'temperature')::float as temperature,
     (e.model_config->>'repeat_penalty')::float as repeat_penalty,
     COUNT(*) as experiment_count,
     AVG((SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id)) as avg_actions,
     AVG((SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = e.id)) as avg_turns,
     ROUND(AVG((SELECT COUNT(*)::numeric / NULLIF(MAX(turn_number), 0) FROM agent_actions WHERE experiment_id = e.id)), 2) as avg_actions_per_turn,
     SUM(CASE WHEN goal_found THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as success_rate_pct,
     AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60.0) as avg_duration_minutes
   FROM experiments e
   WHERE e.model_name = 'qwen2.5:7b'
     AND e.completed_at IS NOT NULL
   GROUP BY
     (e.model_config->>'num_ctx')::integer,
     (e.model_config->>'temperature')::float,
     (e.model_config->>'repeat_penalty')::float
   ORDER BY context_window, temperature, repeat_penalty;
   ```

4. **Name it:** "Parameter Sweep Summary"

5. **Import to SPICE** (for faster queries)

## Step 3: Create Your First Visualization

Once you have the dataset, create these visualizations:

### Visualization 1: Context Window Impact (Line Chart)

**What it shows:** Does larger context window improve efficiency?

- **Visual type:** Line chart
- **X-axis:** `context_window` (2048, 8192, 32768)
- **Y-axis:** `avg_actions_per_turn`
- **Filter:** `temperature = 0.2` (to isolate context impact)
- **Title:** "Context Window Impact on Planning Efficiency"

**Interpretation:**
- Higher values = more efficient (more actions per turn)
- Shows if model makes better multi-step plans with more context

### Visualization 2: Temperature vs Exploration (Scatter)

**What it shows:** Does randomness help or hurt?

- **Visual type:** Scatter plot
- **X-axis:** `temperature`
- **Y-axis:** `avg_actions`
- **Size:** `avg_turns`
- **Color:** `context_window`
- **Title:** "Temperature Impact on Exploration"

### Visualization 3: Config Comparison Table

**What it shows:** All parameter combinations at a glance

- **Visual type:** Pivot table
- **Rows:** `context_window`, `temperature`, `repeat_penalty`
- **Values:** `avg_actions`, `avg_turns`, `success_rate_pct`
- **Title:** "Parameter Sweep Results"

## Additional Datasets to Create

### Dataset 2: Experiments Detail

**Purpose:** Deep dive into individual experiments

```sql
SELECT
  e.id as experiment_id,
  e.model_name,
  e.prompt_version,
  e.maze_id,
  e.started_at,
  e.completed_at,
  e.goal_found,
  (e.model_config->>'num_ctx')::integer as context_window,
  (e.model_config->>'temperature')::float as temperature,
  (e.model_config->>'repeat_penalty')::float as repeat_penalty,
  EXTRACT(EPOCH FROM (e.completed_at - e.started_at)) / 60.0 as duration_minutes,
  (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id) as total_actions,
  (SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = e.id) as total_turns,
  (SELECT COUNT(DISTINCT (to_x, to_y)) FROM agent_actions WHERE experiment_id = e.id AND to_x IS NOT NULL) as unique_positions
FROM experiments e
WHERE e.started_at IS NOT NULL
ORDER BY e.id DESC;
```

### Dataset 3: Action Timeline

**Purpose:** Turn-by-turn analysis of specific experiments

```sql
SELECT
  a.experiment_id,
  a.turn_number,
  a.step_number,
  a.action_type,
  a.success,
  a.from_x,
  a.from_y,
  a.to_x,
  a.to_y,
  LEFT(a.reasoning, 100) as reasoning_preview,
  -- Distance from goal
  ABS(a.to_x - e.goal_x) + ABS(a.to_y - e.goal_y) as distance_from_goal,
  -- Join experiment context
  e.model_name,
  (e.model_config->>'num_ctx')::integer as context_window,
  (e.model_config->>'temperature')::float as temperature
FROM agent_actions a
JOIN experiments e ON a.experiment_id = e.id
WHERE a.experiment_id >= 9  -- Your parameter sweep experiments
ORDER BY a.experiment_id, a.step_number;
```

## Troubleshooting

### Data Source Connection Failed

If you see "connection attempt failed":

1. **Check security group:** Ensure port 5432 allows QuickSight IP ranges
2. **Verify credentials:** Test with psql from your machine
3. **Try public connection:** Remove VPC connection property
4. **Enable SSL:** Set `DisableSsl: false`

### Dataset Refresh Fails

If dataset won't refresh:

1. **Check query syntax:** Test SQL in psql first
2. **Verify SPICE capacity:** Enterprise has 500GB, might be full
3. **Check permissions:** oriole_user needs SELECT on all referenced tables

### Visualizations Show No Data

If charts are empty:

1. **Check filters:** Remove all filters temporarily
2. **Verify data exists:** Run query in SQL client
3. **Refresh dataset:** Manually trigger SPICE refresh
4. **Check field types:** Ensure QuickSight detected correct data types

## Next Steps

1. ✅ Create "Parameter Sweep Summary" dataset
2. ✅ Build first visualization (Context Window Impact)
3. ✅ Add more visualizations to dashboard
4. Create additional datasets for deeper analysis
5. Set up automated refresh schedule
6. Share dashboard with team

## References

- QuickSight Console: https://us-west-2.quicksight.aws.amazon.com/
- Data Source ID: `oriole-postgres`
- Database: `oriole` on `continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com`
