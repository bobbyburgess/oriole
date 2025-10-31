-- Add Ollama performance metrics to agent_actions
-- These fields track inference timing and efficiency for Ollama models
-- Will be NULL for Bedrock experiments (Bedrock doesn't expose these metrics)
-- Created: 2025-10-31

-- Add timing columns (all durations in milliseconds)
ALTER TABLE agent_actions
ADD COLUMN inference_duration_ms INTEGER,           -- total_duration from Ollama (total request time)
ADD COLUMN prompt_eval_duration_ms INTEGER,         -- prompt_eval_duration (time to process context)
ADD COLUMN eval_duration_ms INTEGER,                -- eval_duration (time to generate tokens)
ADD COLUMN tokens_per_second DECIMAL(10,2),        -- calculated: eval_count / (eval_duration_ms / 1000)
ADD COLUMN done_reason VARCHAR(20);                 -- "stop" (natural), "length" (hit token limit), etc.

-- Add comments
COMMENT ON COLUMN agent_actions.inference_duration_ms IS 'Total Ollama inference time in milliseconds (includes load + prompt eval + generation). NULL for Bedrock.';
COMMENT ON COLUMN agent_actions.prompt_eval_duration_ms IS 'Time to process prompt/context in milliseconds. Shows context size impact. NULL for Bedrock.';
COMMENT ON COLUMN agent_actions.eval_duration_ms IS 'Time to generate output tokens in milliseconds. Shows model generation speed. NULL for Bedrock.';
COMMENT ON COLUMN agent_actions.tokens_per_second IS 'Output tokens generated per second. Higher is faster. NULL for Bedrock.';
COMMENT ON COLUMN agent_actions.done_reason IS 'Why generation stopped: "stop" (natural end), "length" (hit max tokens), etc. NULL for Bedrock.';
