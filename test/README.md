# Oriole Tests

Testing strategy for maze navigation experiments.

## Test Structure

```
test/
├── integration/          # Real AWS experiments testing system invariants
│   └── claude-haiku.test.js
├── unit/                # Pure logic tests (future)
└── helpers/             # Shared test utilities
    ├── db.js           # Database query helpers
    └── experiment.js   # Experiment triggering helpers
```

## Running Tests

### Prerequisites

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Environment setup:**
   Ensure `.env` file has required variables:
   ```bash
   PGHOST=your-db-host
   PGPORT=5432
   PGDATABASE=oriole
   PGUSER=oriole_user
   PGPASSWORD=your-password
   AWS_PROFILE=bobby
   AWS_REGION=us-west-2
   CLAUDE_HAIKU_AGENT_ID=26U4QFQUJT
   CLAUDE_HAIKU_ALIAS_ID=54HMIQZHQ9
   ```

3. **Deployed stack:**
   ```bash
   npm run deploy
   ```

### Run Tests

```bash
# Run all tests
npm test

# Run only integration tests
npm run test:integration

# Run a specific test file
npx jest test/integration/claude-haiku.test.js
```

## Integration Tests

Integration tests trigger real experiments and verify **system invariants** that must hold for all models:

### What They Test

✅ **Position Continuity** - No race conditions, every step starts where previous ended
✅ **Turn Number Tracking** - All turns have valid turn_number > 0
✅ **Basic Functionality** - Experiments complete, actions are logged
✅ **Recall Usage** - Agent uses recall_all at least once

### What They DON'T Test

❌ Model intelligence (how well it solves mazes)
❌ Exact number of moves (non-deterministic)
❌ Specific paths taken (varies by run)
❌ Failure rate thresholds (model-dependent quality)

### Test Output

```
🚀 Triggering Haiku experiment on maze 1...
📊 Experiment ID: 42
⏳ Waiting for completion (max 5 minutes)...
✅ Experiment completed!
🔍 Checking invariants...
  ✓ Position continuity: 0 violations
  ✓ Turn tracking: 16 turns recorded
  ✓ Activity: 105 total steps, 104 moves
  ✓ Recall usage: 1 calls

📈 Quality Metrics:
  - Successful moves: 87
  - Failed moves: 17
  - Failure rate: 16.3%
  - Average steps per turn: 6.6
```

## Adding Tests for New Models

To test a new model (e.g., Nova Pro), copy the Haiku test and update the config:

```javascript
const NOVA_PRO_CONFIG = {
  agentId: process.env.NOVA_PRO_AGENT_ID,
  agentAliasId: process.env.NOVA_PRO_ALIAS_ID,
  modelName: 'nova-pro'
};
```

Same invariants apply - if position continuity fails, it's a system bug not a model issue.

## Test Helpers

### `test/helpers/db.js`

- `checkPositionContinuity(experimentId)` - Returns list of violations (empty = good)
- `getTurnData(experimentId)` - Returns per-turn statistics
- `getExperimentStats(experimentId)` - Returns overall experiment metrics
- `waitForExperimentCompletion(experimentId, options)` - Polls until done

### `test/helpers/experiment.js`

- `triggerExperiment(config)` - Starts experiment via EventBridge, returns experiment ID

## Troubleshooting

**Test times out:**
- Check Step Functions console for execution status
- Check CloudWatch logs for Lambda errors
- Verify agent is properly configured

**"Experiment not found" error:**
- Ensure database credentials are correct
- Check that experiment actually started (look in experiments table)

**Position continuity violations:**
- This indicates a critical bug - race condition in position tracking
- Check if `reservedConcurrentExecutions: 1` is set on action router Lambda
- Review CloudWatch logs for concurrent execution evidence
