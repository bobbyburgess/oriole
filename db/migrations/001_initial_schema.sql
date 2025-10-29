-- Initial schema for Oriole maze navigation experiments
-- Created: 2025-10-22

-- Maze definitions
-- Grid tile encoding (stored in grid_data as 2D array of integers):
--   0 = EMPTY (passable floor)
--   1 = WALL (impassable, blocks movement and vision)
--   2 = GOAL (target location, passable)
CREATE TABLE mazes (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  width INT NOT NULL,
  height INT NOT NULL,
  grid_data JSONB NOT NULL,        -- 2D array [y][x] of tile type integers (0=empty, 1=wall, 2=goal)
  see_through_walls BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Top-level experiment runs
CREATE TABLE experiments (
  id SERIAL PRIMARY KEY,
  agent_id VARCHAR(255),
  model_name VARCHAR(255) NOT NULL,
  prompt_version VARCHAR(100),
  prompt_text TEXT,
  maze_id INT REFERENCES mazes(id),
  goal_description TEXT,
  start_x INT NOT NULL,
  start_y INT NOT NULL,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  status VARCHAR(50),              -- 'running', 'success', 'failed', 'timeout'
  total_moves INT DEFAULT 0,
  total_tokens INT DEFAULT 0,
  success BOOLEAN
);

-- Each agent action/step
CREATE TABLE agent_actions (
  id SERIAL PRIMARY KEY,
  experiment_id INT REFERENCES experiments(id) ON DELETE CASCADE,
  step_number INT NOT NULL,
  action_type VARCHAR(50) NOT NULL,  -- 'move_north', 'move_south', 'move_east', 'move_west', 'recall_all'
  reasoning TEXT,                     -- Agent's thought before action
  from_x INT,
  from_y INT,
  to_x INT,                          -- null if recall_all
  to_y INT,
  success BOOLEAN DEFAULT true,      -- did the action succeed (hit wall = false)
  tiles_seen JSONB,                  -- Vision data as object {"x,y": tileType} where tileType is 0/1/2
  tokens_used INT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common queries
CREATE INDEX idx_experiments_model_name ON experiments(model_name);
CREATE INDEX idx_experiments_maze_id ON experiments(maze_id);
CREATE INDEX idx_experiments_prompt_version ON experiments(prompt_version);
CREATE INDEX idx_agent_actions_experiment_id ON agent_actions(experiment_id);
CREATE INDEX idx_agent_actions_step_number ON agent_actions(experiment_id, step_number);
