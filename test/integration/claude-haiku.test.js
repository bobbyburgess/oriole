/**
 * Integration test for Claude 3.5 Haiku
 *
 * Tests system invariants that must hold regardless of model behavior:
 * - Position continuity (no race conditions)
 * - Turn number tracking
 * - Basic experiment completion
 *
 * Run with: npm test
 *
 * Prerequisites:
 * - .env file with database credentials
 * - Deployed Oriole stack in AWS
 * - Claude Haiku agent configured
 */

const { triggerExperiment } = require('../helpers/experiment');
const {
  checkPositionContinuity,
  getTurnData,
  getExperimentStats,
  waitForExperimentCompletion
} = require('../helpers/db');

// Load environment variables
require('dotenv').config();

describe('Claude 3.5 Haiku Integration', () => {
  // Increase timeout for real experiment runs
  // With 3 RPM rate limiting: 100 turns × 20s = 2000s (~33 min) + overhead
  jest.setTimeout(2700000); // 45 minutes

  const HAIKU_CONFIG = {
    agentId: process.env.CLAUDE_HAIKU_AGENT_ID || '26U4QFQUJT',
    agentAliasId: process.env.CLAUDE_HAIKU_ALIAS_ID || '54HMIQZHQ9',
    modelName: 'claude-3-5-haiku'
  };

  test('completes maze 1 with valid system invariants', async () => {
    console.log('🚀 Triggering Haiku experiment on maze 1...');

    const experimentId = await triggerExperiment({
      ...HAIKU_CONFIG,
      mazeId: 1, // Simple one-path maze
      promptVersion: 'v2'
    });

    console.log(`📊 Experiment ID: ${experimentId}`);
    console.log('⏳ Waiting for completion (max 45 minutes)...');

    await waitForExperimentCompletion(experimentId, {
      timeoutMs: 2700000,
      pollIntervalMs: 5000
    });

    console.log('✅ Experiment completed!');
    console.log('🔍 Checking invariants...');

    // INVARIANT 1: Position continuity must be perfect
    const violations = await checkPositionContinuity(experimentId);
    expect(violations).toEqual([]);
    console.log('  ✓ Position continuity: 0 violations');

    // INVARIANT 2: All turns must have valid turn numbers
    const turnData = await getTurnData(experimentId);
    expect(turnData.length).toBeGreaterThan(0);
    expect(turnData.every(t => t.turn_number > 0)).toBe(true);
    expect(turnData.every(t => t.steps_in_turn > 0)).toBe(true);
    console.log(`  ✓ Turn tracking: ${turnData.length} turns recorded`);

    // INVARIANT 3: Experiment must have some activity
    const stats = await getExperimentStats(experimentId);
    expect(stats.total_steps).toBeGreaterThan(0);
    expect(stats.move_attempts).toBeGreaterThan(0);
    expect(stats.max_turn).toBeGreaterThan(0);
    console.log(`  ✓ Activity: ${stats.total_steps} total steps, ${stats.move_attempts} moves`);

    // INVARIANT 4: Recall must be used at least once (should call at start)
    expect(stats.recall_count).toBeGreaterThanOrEqual(1);
    console.log(`  ✓ Recall usage: ${stats.recall_count} calls`);

    // QUALITY METRIC (not a hard requirement, just informative)
    console.log(`\n📈 Quality Metrics:`);
    console.log(`  - Successful moves: ${stats.successful_moves}`);
    console.log(`  - Failed moves: ${stats.failed_moves}`);
    console.log(`  - Failure rate: ${(stats.failure_rate * 100).toFixed(1)}%`);
    console.log(`  - Average steps per turn: ${(stats.total_steps / stats.max_turn).toFixed(1)}`);
  });
});
