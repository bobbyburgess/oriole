-- Remove denormalized total_moves column
-- Created: 2025-10-23
--
-- The total_moves column was a denormalized cache that only got updated
-- at experiment completion. Since the viewer already fetches all actions,
-- it can simply use actions.length instead. This removes unnecessary
-- complexity and confusion.

ALTER TABLE experiments DROP COLUMN total_moves;
