-- Add assistant_message column to capture full LLM narrative responses
-- This is separate from 'reasoning' which only captures tool call arguments
--
-- assistant_message: The full message.content from the LLM (can be present with or without tool calls)
-- reasoning: The tool call's arguments.reasoning field (only present when tools are called)
--
-- Example:
--   assistant_message: "Based on my history, I see walls to the east. I'll explore north to find an open path."
--   reasoning: "avoiding known wall"

ALTER TABLE agent_actions ADD COLUMN assistant_message TEXT;
