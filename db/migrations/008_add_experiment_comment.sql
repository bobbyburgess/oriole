-- Add comment field to experiments table for easy batch labeling
-- Created: 2025-10-29

ALTER TABLE experiments
  ADD COLUMN comment TEXT;

-- Add index for searching comments
CREATE INDEX idx_experiments_comment ON experiments USING gin(to_tsvector('english', comment));

-- Add comment to describe the purpose
COMMENT ON COLUMN experiments.comment IS 'Free-text field for labeling experiment batches (e.g., "A/B test: 14b vs 7b temp=0", "v9 prompt testing")';
