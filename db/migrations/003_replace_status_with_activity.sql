-- Migration: Replace status column with last_activity timestamp
-- Rationale: Status becomes stale/misleading when Step Functions are manually stopped
--            or fail unexpectedly. A timestamp of last activity is more useful for monitoring.

-- Add last_activity column (set to started_at for existing rows, or completed_at if finished)
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS last_activity TIMESTAMP;

-- Backfill last_activity for existing experiments
UPDATE experiments
SET last_activity = COALESCE(completed_at, started_at)
WHERE last_activity IS NULL;

-- Drop the status column
ALTER TABLE experiments DROP COLUMN IF EXISTS status;

-- Add comment explaining how to determine experiment state
COMMENT ON TABLE experiments IS 'Experiment state is inferred from columns:
  - Active: last_activity recent and completed_at IS NULL
  - Completed: completed_at IS NOT NULL and success IS NOT NULL
  - Stalled: last_activity old and completed_at IS NULL
  - Aborted: completed_at IS NOT NULL and success IS NULL';
