-- Remove unused goal_x and goal_y columns from mazes table
-- Goal position is defined by value 2 in grid_data, making these columns redundant

ALTER TABLE mazes
DROP COLUMN goal_x,
DROP COLUMN goal_y;
