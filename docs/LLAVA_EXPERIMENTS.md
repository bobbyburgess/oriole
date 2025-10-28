# LLaVA Vision-Based Maze Navigation Experiments

## Overview

**LLaVA (Large Language and Vision Assistant)** is an open-source multimodal model that combines vision, language understanding, and tool use. This document explores using vision-based navigation as an alternative to text-based coordinate navigation.

## Core Hypothesis

**"Vision-based navigation will be more efficient than coordinate-based navigation because spatial reasoning is easier with visual input."**

Rationale: Vision models are pre-trained on millions of images with spatial relationships. A vision model's "spatial cortex" already understands concepts like corridors, junctions, and paths from visual training data, whereas text-only models must learn spatial geometry abstractly from coordinate descriptions.

---

## Current vs Vision-Based Approach

### Current Approach (Text-Based)

**What the agent receives:**
```
You are at (15, 23). You can see:
- North (15,22): empty
- South (15,24): wall
- East (16,23): empty
- West (14,23): empty
- Goal at (45, 45)
```

**Agent must:**
1. Parse text coordinates
2. Build mental spatial model from numbers
3. Reason about geometry abstractly
4. Choose action based on text understanding

### Vision-Based Approach (LLaVA)

**What the agent receives:**
- Image showing maze from agent's perspective
- Red square = agent position
- White tiles = empty paths
- Black tiles = walls
- Green tile = goal (if visible)

**Agent can:**
1. **See** spatial relationships directly
2. Use visual pattern matching (corridors, dead-ends, junctions)
3. Leverage pre-trained visual spatial reasoning
4. Choose action based on visual understanding

---

## Why This Could Outperform Text

### Advantages of Visual Input

1. **Spatial Pattern Recognition**
   - Text: Parse 20 coordinate pairs to understand "long corridor"
   - Vision: Instantly recognize corridor shape

2. **Goal Visibility**
   - Text: "Goal at (45,45), you're at (15,23)" requires mental calculation
   - Vision: Green marker visible in direction, immediate understanding of relative position

3. **Topology Understanding**
   - Text: "North: empty, East: empty, South: wall, West: empty..."
   - Vision: Immediately see "T-junction" as a shape

4. **Stuck Detection**
   - Text: Compare coordinate history to detect loops
   - Vision: Visual memory shows "I keep seeing this same corner"

5. **Path Tracing**
   - Text: Abstract path planning from coordinates
   - Vision: Visual cortex excels at "trace a route from A to B"

### Example: T-Junction Recognition

**Text representation:**
```
Position: (10, 10)
North (10,9): empty
South (10,11): wall
East (11,10): empty
West (9,10): empty
NE (11,9): wall
NW (9,9): wall
SE (11,11): wall
SW (9,11): wall
```
→ Agent must parse 8 coordinate pairs to infer "T-junction"

**Visual representation:**
```
┌─────┬─────┬─────┐
│ ███ │     │ ███ │
├─────┼─────┼─────┤
│     │  🔴 │     │
├─────┼─────┼─────┤
│ ███ │ ███ │ ███ │
└─────┴─────┴─────┘
```
→ Agent instantly recognizes T-junction shape

---

## Available Vision Models

### Installing Models

```bash
# LLaVA models (recommended starting point)
ollama pull llava:7b       # ~4.7GB - Smaller, faster
ollama pull llava:13b      # ~8.0GB - Better quality
ollama pull llava:34b      # ~20GB - Best quality (requires significant RAM)

# LLaVA based on Llama 3
ollama pull llava-llama3   # ~4.7GB - Llama 3 backbone

# Mistral's vision model (newer)
ollama pull pixtral        # ~7.0GB - Potentially better performance

# BakLLaVA (optimized variant)
ollama pull bakllava       # ~4.7GB - Alternative implementation

# Check what's installed
ollama list

# Test a model locally
ollama run llava:13b
```

**Note**: `ollama pull <model>` downloads and installs the model. First run will take time depending on your internet connection.

### Model Comparison

| Model | Size | Best For | Tool Support |
|-------|------|----------|--------------|
| llava:7b | ~5GB | Quick experiments, limited hardware | ✅ Yes |
| llava:13b | ~8GB | **Recommended balance** of quality and speed | ✅ Yes |
| llava:34b | ~20GB | Best quality, needs powerful hardware | ✅ Yes |
| llava-llama3 | ~5GB | Llama 3 base, good instruction following | ✅ Yes |
| pixtral | ~7GB | Newer, potentially better spatial reasoning | ✅ Yes |

**Recommendation**: Start with `llava:13b` for best balance.

---

## Architecture Design

### System Components

```
┌─────────────────────────────────────────────────────────┐
│                   Step Functions                        │
│                  (Orchestration)                        │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│              Start Experiment Lambda                    │
│  - Create experiment record                             │
│  - Load maze data                                       │
│  - Initialize agent at start position                   │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│          Invoke Agent Lambda (Modified)                 │
│                                                          │
│  Per Turn:                                              │
│    1. Get current position (x, y)                       │
│    2. Calculate vision (visible tiles)                  │
│    3. **NEW: Call Rendering Service**                   │
│    4. Encode image as base64                            │
│    5. Call LLaVA with image + tools                     │
│    6. Execute tool calls (move_north, etc.)             │
│    7. Record actions to database                        │
│    8. Check if goal reached                             │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│          **NEW: Maze Rendering Service**                │
│                                                          │
│  Input:  maze grid, agent position, vision range        │
│  Output: PNG image (base64 encoded)                     │
│                                                          │
│  Rendering options:                                     │
│    - Top-down view (bird's eye)                         │
│    - First-person view (what's ahead)                   │
│    - With/without visit history                         │
│    - With/without path trail                            │
└─────────────────────────────────────────────────────────┘
```

### New Component: Maze Rendering Service

**Option A: Lambda Function**
```
lambda/vision/render-maze.js
- Uses node-canvas to generate images
- Fast, serverless, scales automatically
- Cold start overhead
```

**Option B: Local Service** (Recommended for development)
```
services/maze-renderer/
- Runs locally alongside Ollama
- No cold starts
- Easier debugging
- Can save images to disk for analysis
```

**Option C: Lambda Layer with Canvas**
```
- Package node-canvas as Lambda layer
- Call from invoke-agent-ollama Lambda
- No additional service needed
- Slightly slower (inline rendering)
```

---

## Implementation Details

### Maze Rendering Code

```javascript
// lambda/vision/render-maze.js or services/maze-renderer/index.js
const { createCanvas } = require('canvas');

const TILE_SIZE = 40; // pixels per tile
const COLORS = {
  WALL: '#1a1a1a',      // Dark gray/black
  EMPTY: '#ffffff',     // White
  GOAL: '#00ff00',      // Bright green
  AGENT: '#ff0000',     // Red
  VISITED: '#e0e0e0',   // Light gray (for history)
  FOG: '#808080'        // Gray (for unseen tiles)
};

/**
 * Render maze from agent's perspective
 *
 * @param {Array} grid - Full maze grid (grid[y][x])
 * @param {Object} visible - Visible tiles from calculateVision()
 * @param {number} agentX - Agent's x position
 * @param {number} agentY - Agent's y position
 * @param {Object} options - Rendering options
 * @returns {Buffer} PNG image buffer
 */
function renderMazeView(grid, visible, agentX, agentY, options = {}) {
  const {
    visionRange = 3,
    showHistory = false,
    visitCounts = {},
    showTrail = false,
    lastMoves = []
  } = options;

  // Calculate canvas size
  const viewSize = (visionRange * 2 + 1);
  const canvasSize = viewSize * TILE_SIZE;
  const canvas = createCanvas(canvasSize, canvasSize);
  const ctx = canvas.getContext('2d');

  // Fill background with fog
  ctx.fillStyle = COLORS.FOG;
  ctx.fillRect(0, 0, canvasSize, canvasSize);

  // Draw visible tiles
  for (let dy = -visionRange; dy <= visionRange; dy++) {
    for (let dx = -visionRange; dx <= visionRange; dx++) {
      const tileX = agentX + dx;
      const tileY = agentY + dy;
      const key = `${tileX},${tileY}`;

      if (visible[key] !== undefined) {
        // Calculate canvas position (center agent in view)
        const canvasX = (dx + visionRange) * TILE_SIZE;
        const canvasY = (dy + visionRange) * TILE_SIZE;

        // Determine tile color
        let color;
        const tileType = visible[key];

        if (tileType === 1) { // WALL
          color = COLORS.WALL;
        } else if (tileType === 2) { // GOAL
          color = COLORS.GOAL;
        } else { // EMPTY
          // Show visit history if enabled
          if (showHistory && visitCounts[key]) {
            const intensity = Math.min(visitCounts[key] / 10, 1);
            const gray = Math.floor(255 - (intensity * 80));
            color = `rgb(${gray}, ${gray}, ${gray})`;
          } else {
            color = COLORS.EMPTY;
          }
        }

        // Draw tile
        ctx.fillStyle = color;
        ctx.fillRect(canvasX, canvasY, TILE_SIZE, TILE_SIZE);

        // Draw grid lines
        ctx.strokeStyle = '#cccccc';
        ctx.lineWidth = 1;
        ctx.strokeRect(canvasX, canvasY, TILE_SIZE, TILE_SIZE);
      }
    }
  }

  // Draw recent path trail if enabled
  if (showTrail && lastMoves.length > 0) {
    ctx.strokeStyle = 'rgba(255, 0, 0, 0.3)';
    ctx.lineWidth = 3;
    ctx.beginPath();

    lastMoves.forEach((move, i) => {
      const dx = move.x - agentX + visionRange;
      const dy = move.y - agentY + visionRange;
      const x = dx * TILE_SIZE + TILE_SIZE / 2;
      const y = dy * TILE_SIZE + TILE_SIZE / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    ctx.stroke();
  }

  // Draw agent position (always centered)
  const centerX = visionRange * TILE_SIZE;
  const centerY = visionRange * TILE_SIZE;

  ctx.fillStyle = COLORS.AGENT;
  ctx.fillRect(
    centerX + TILE_SIZE * 0.2,
    centerY + TILE_SIZE * 0.2,
    TILE_SIZE * 0.6,
    TILE_SIZE * 0.6
  );

  // Add direction indicator (arrow pointing north)
  ctx.fillStyle = '#ffffff';
  ctx.font = `${TILE_SIZE * 0.4}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('▲', centerX + TILE_SIZE / 2, centerY + TILE_SIZE / 2);

  return canvas.toBuffer('image/png');
}

/**
 * Render alternative: First-person perspective
 * Shows only what's ahead in the direction of movement
 */
function renderFirstPersonView(grid, visible, agentX, agentY, lastDirection) {
  // Implementation for corridor-style view
  // Shows depth perception (tiles get smaller with distance)
  // More immersive but potentially harder for pathfinding
}

/**
 * Render alternative: Mini-map style
 * Shows entire explored area with fog of war
 */
function renderMiniMap(grid, exploredTiles, agentX, agentY) {
  // Shows all tiles ever visited
  // Current position highlighted
  // Unexplored areas in fog
}

module.exports = {
  renderMazeView,
  renderFirstPersonView,
  renderMiniMap
};
```

### Modified Invoke Agent Lambda

```javascript
// lambda/orchestration/invoke-agent-ollama.js (modifications)

const { renderMazeView } = require('../vision/render-maze');

async function invokeLLaVAAgent(experimentId, modelName, /* ... */) {
  // ... existing setup ...

  // Get maze and calculate vision
  const maze = await getMaze(mazeId);
  const visible = await calculateVision(maze.grid, currentX, currentY, false);

  // **NEW: Render maze view**
  const imageBuffer = renderMazeView(
    maze.grid,
    visible,
    currentX,
    currentY,
    {
      visionRange: VISION_RANGE,
      showHistory: true,
      visitCounts: await getVisitCounts(experimentId),
      showTrail: true,
      lastMoves: await getLastNMoves(experimentId, 5)
    }
  );

  const base64Image = imageBuffer.toString('base64');

  // **NEW: Prepare vision-based message**
  const systemMessage = `You are navigating a maze.

You see an image showing:
- Red square with ▲ = your position (arrow points north)
- White tiles = empty paths you can walk on
- Black tiles = walls (impassable)
- Green tile = goal (reach this to win)
- Lighter gray tiles = places you've visited before

You have these tools available:
- move_north: Move up one tile
- move_south: Move down one tile
- move_east: Move right one tile
- move_west: Move left one tile

Look at the image and decide your next move. Try to reach the green goal tile efficiently.`;

  // Call LLaVA with image
  const messages = [
    {
      role: 'user',
      content: systemMessage,
      images: [base64Image] // LLaVA accepts images here
    }
  ];

  const response = await callOllamaChat(
    endpoint,
    modelName, // e.g., 'llava:13b'
    messages,
    tools,
    /* ... */
  );

  // Rest of logic remains same (execute tools, record actions, etc.)
}
```

### Ollama API Call with Vision

```javascript
// lambda/shared/ollama.js (add vision support)

async function callOllamaChat(endpoint, model, messages, tools, options = {}) {
  const payload = {
    model,
    messages, // Can include images in message content
    tools,
    stream: false,
    options: {
      temperature: options.temperature || 0.2,
      num_ctx: options.num_ctx || 32768,
      // ... other options
    }
  };

  const response = await fetch(`${endpoint}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  return await response.json();
}

// Messages format with images:
// [
//   {
//     role: 'user',
//     content: 'What do you see?',
//     images: ['base64EncodedImageString']
//   }
// ]
```

---

## Experimental Design

### Phase 1: Proof of Concept

**Goal**: Verify LLaVA can navigate simple mazes with vision

**Steps**:
1. Install LLaVA: `ollama pull llava:13b`
2. Create local test script (test-llava-maze.js)
3. Render simple 5x5 maze
4. Test single turn navigation
5. Verify tool calling works with images

**Success Criteria**: LLaVA calls correct tool based on visual input

**Estimated Time**: 2-4 hours

### Phase 2: Single Experiment Comparison

**Goal**: Compare one text-based run vs one vision-based run

**Configuration**:
- Same maze (maze 1)
- Same model size (7B class)
- Text: qwen2.5:7b (current)
- Vision: llava:13b

**Metrics to Compare**:
- Success (reached goal?)
- Steps to completion
- Wall hit rate
- Inference time per turn
- Token usage
- Unique tiles explored

**Estimated Time**: 1 day (including debugging)

### Phase 3: Systematic Evaluation

**Goal**: Determine if vision approach is statistically better

**Experimental Matrix**:

| Series | Agent Type | Model | Maze | Runs |
|--------|-----------|-------|------|------|
| A1 | Text | qwen2.5:7b | 1 | 5 |
| A2 | Vision | llava:13b | 1 | 5 |
| B1 | Text | qwen2.5:7b | 2 | 5 |
| B2 | Vision | llava:13b | 2 | 5 |

**Statistical Analysis**:
- t-test: text vs vision on each maze
- Effect size: How much better is vision?
- Variance: Is vision more consistent?

**Success Criteria**: p < 0.05 with meaningful effect size (Cohen's d > 0.5)

**Estimated Time**: 1 week (5-10 hours of runs + analysis)

### Phase 4: Rendering Optimization

**Goal**: Find best visual representation

**Test Different Rendering Styles**:
1. **Top-down (current proposal)**
2. **First-person perspective** (corridor view)
3. **Mini-map style** (entire explored area)
4. **With/without visit history**
5. **With/without path trail**
6. **Different color schemes**

**Question**: Which rendering helps navigation most?

### Phase 5: Hybrid Approach

**Goal**: Combine strengths of both modalities

**Experiment**:
- Provide both image AND text coordinates
- "Here's what you see [IMAGE], and you're at exactly (15,23)"

**Hypothesis**: Multimodal > vision-only > text-only

---

## Research Questions

### Primary Questions

1. **Does vision improve navigation efficiency?**
   - Metric: Steps to goal (vision vs text)
   - Hypothesis: Vision requires fewer steps due to better spatial reasoning

2. **Does vision improve success rate?**
   - Metric: % of runs that reach goal
   - Hypothesis: Vision agents get stuck less often

3. **Does vision reduce wall hits?**
   - Metric: Failed move attempts
   - Hypothesis: Visual obstacle recognition is clearer

### Secondary Questions

4. **What's the token usage trade-off?**
   - Image encoding costs tokens
   - But might need fewer turns overall
   - Net token usage: vision vs text?

5. **What's the inference time trade-off?**
   - Images take longer to process
   - But might need fewer turns
   - Net time to completion?

6. **Which rendering style is optimal?**
   - Top-down vs first-person vs mini-map
   - With/without history
   - Color scheme impact

7. **Does visual memory help?**
   - Showing visited tiles in different shade
   - Can agents recognize "I've been here before" visually?

8. **Do larger vision models help more?**
   - llava:7b vs llava:13b vs llava:34b
   - Diminishing returns at what size?

---

## Database Schema Additions

### New Table: Rendered Images (Optional)

```sql
CREATE TABLE agent_vision_frames (
  id SERIAL PRIMARY KEY,
  experiment_id INTEGER REFERENCES experiments(id),
  turn_number INTEGER NOT NULL,
  agent_x INTEGER NOT NULL,
  agent_y INTEGER NOT NULL,
  image_data BYTEA, -- PNG image data
  image_s3_key TEXT, -- Or store in S3
  rendering_style TEXT, -- 'top-down', 'first-person', etc.
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_vision_frames_exp ON agent_vision_frames(experiment_id);
```

**Use Cases**:
- Debugging: See what agent saw at each turn
- Analysis: Create videos of navigation
- Training: Build dataset for future fine-tuning

### Extend Experiments Table

```sql
ALTER TABLE experiments
ADD COLUMN agent_type TEXT, -- 'text', 'vision', 'hybrid'
ADD COLUMN rendering_style TEXT, -- null for text agents
ADD COLUMN vision_model TEXT; -- 'llava:13b', etc.
```

---

## Code Example: Quick Local Test

```javascript
// test/local/test-llava-simple.js
const { createCanvas } = require('canvas');
const Ollama = require('ollama').Ollama;

async function testLLaVASimpleMaze() {
  console.log('Creating simple maze visualization...');

  // Create 5x5 maze
  const canvas = createCanvas(200, 200);
  const ctx = canvas.getContext('2d');

  // Background (black walls)
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 200, 200);

  // Vertical corridor (white)
  ctx.fillStyle = '#fff';
  ctx.fillRect(40, 40, 40, 120);

  // Horizontal corridor (white)
  ctx.fillRect(40, 40, 120, 40);

  // Goal (green)
  ctx.fillStyle = '#0f0';
  ctx.fillRect(160, 40, 40, 40);

  // Agent (red)
  ctx.fillStyle = '#f00';
  ctx.fillRect(40, 160, 40, 40);

  // Add north arrow on agent
  ctx.fillStyle = '#fff';
  ctx.font = '20px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('▲', 60, 175);

  const imageBuffer = canvas.toBuffer('image/png');
  const base64Image = imageBuffer.toString('base64');

  console.log('Calling LLaVA...');

  const ollama = new Ollama({ host: 'http://localhost:11434' });

  const tools = [
    {
      type: 'function',
      function: {
        name: 'move_north',
        description: 'Move up one tile (in the direction of the arrow)',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'move_south',
        description: 'Move down one tile',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'move_east',
        description: 'Move right one tile',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'move_west',
        description: 'Move left one tile',
        parameters: { type: 'object', properties: {} }
      }
    }
  ];

  const response = await ollama.chat({
    model: 'llava:13b',
    messages: [{
      role: 'user',
      content: `You are the red square with the ▲ arrow (which points north/up).

Navigate to the green square.

Legend:
- Red square (you) = current position
- White = empty paths
- Black = walls (can't pass)
- Green = goal (win by reaching this)
- ▲ arrow points north

You can move in 4 directions. Look at the maze and decide which direction to move.`,
      images: [base64Image]
    }],
    tools
  });

  console.log('\nLLaVA Response:');
  console.log(JSON.stringify(response.message, null, 2));

  if (response.message.tool_calls) {
    console.log('\n✅ Tool called:', response.message.tool_calls[0].function.name);
  } else {
    console.log('\n❌ No tool call - got text response instead');
  }
}

testLLaVASimpleMaze().catch(console.error);
```

**Run it**:
```bash
# Install dependencies
npm install canvas ollama

# Make sure LLaVA is installed
ollama pull llava:13b

# Run test
node test/local/test-llava-simple.js
```

---

## Performance Considerations

### Token Usage

**Image encoding in LLaVA**:
- Each image ≈ 256-768 tokens (depends on resolution and model)
- Our 7x7 tile view (280x280px) ≈ ~400 tokens
- Compare to text description: ~100-200 tokens

**Trade-off**:
- Vision uses 2-4x more tokens per turn
- But might complete in fewer turns
- Net usage depends on efficiency gain

### Inference Time

**Benchmarks** (approximate on M1/M2 Mac):
- Text-only (qwen2.5:7b): ~2-5 seconds per turn
- Vision (llava:13b): ~5-15 seconds per turn
- Larger images = longer processing

**Optimization strategies**:
- Lower image resolution (5x5 view vs 7x7)
- Smaller models (llava:7b)
- Batch multiple frames if possible

### Storage Considerations

**Storing rendered images**:
- Per turn: ~10-50 KB (PNG)
- Per experiment (100 turns): ~1-5 MB
- For 1000 experiments: ~1-5 GB

**Options**:
- Don't store images (regenerate for debugging)
- Store in S3 with lifecycle policy (delete after 30 days)
- Store only for failed/interesting runs

---

## Success Metrics

### How to Measure Success

**Primary Metrics** (same as text agents):
- Success rate (% reach goal)
- Steps to completion (mean, median)
- Wall hit rate
- Exploration efficiency

**Vision-Specific Metrics**:
- Inference time per turn (vision overhead)
- Token usage per turn (image encoding cost)
- Memory usage (larger models)

**Qualitative Analysis**:
- Watch rendered videos of navigation
- Identify patterns in visual reasoning
- Compare failure modes (vision vs text)

### Statistical Significance

**Sample Size**:
- Minimum 5 runs per condition
- 10 runs preferred for robust statistics
- Use power analysis (from learning resources)

**Comparison Tests**:
- t-test for continuous metrics (steps, time)
- Chi-square for success rate
- Effect size (Cohen's d) for practical significance

**Acceptance Criteria**:
- p < 0.05 (statistically significant)
- Cohen's d > 0.5 (medium effect size)
- Improvement > 20% (practically meaningful)

---

## Future Extensions

### Advanced Visual Features

1. **Attention Heatmaps**
   - Show which parts of image model "looks at"
   - Understand decision-making process

2. **Memory Visualization**
   - Build persistent visual map over time
   - Show "mental model" of explored maze

3. **Multiple View Angles**
   - Combine top-down + first-person
   - Give agent richer spatial context

4. **Animated Transitions**
   - Short video clip showing movement
   - Better temporal understanding

### Multi-Agent Vision

- Multiple agents see same maze
- Share visual observations
- Collaborative navigation

### Real-World Applications

1. **Robot Navigation**
   - Replace maze with camera feed
   - Navigate real physical spaces

2. **Game Playing**
   - Screen capture as input
   - Play maze-based video games

3. **UI Automation**
   - Screenshot-based web navigation
   - Visual element detection + interaction

---

## Implementation Roadmap

### Milestone 1: Local Prototype (Weekend)

**Goals**:
- ✅ Install llava:13b
- ✅ Create rendering function
- ✅ Test single-turn vision navigation
- ✅ Verify tool calling works

**Deliverables**:
- `test/local/test-llava-simple.js` working
- `lambda/vision/render-maze.js` implemented

### Milestone 2: AWS Integration (1 Week)

**Goals**:
- ✅ Deploy rendering service (Lambda or local)
- ✅ Modify invoke-agent-ollama.js for vision
- ✅ Run one full experiment with vision
- ✅ Compare to text baseline

**Deliverables**:
- Vision-based experiment completes successfully
- Database stores vision experiment data
- Basic metrics comparison

### Milestone 3: Systematic Evaluation (2 Weeks)

**Goals**:
- ✅ Run parameter sweep: text vs vision
- ✅ Statistical analysis of results
- ✅ Identify optimal rendering style
- ✅ Document findings

**Deliverables**:
- 20+ experiments (10 text, 10 vision)
- Statistical report (p-values, effect sizes)
- Visualizations (charts, sample images)

### Milestone 4: Publication (Optional)

**Goals**:
- ✅ Write research paper
- ✅ Create demo videos
- ✅ Open-source vision rendering code
- ✅ Share on arXiv / blog

**Deliverables**:
- Paper: "Comparative Analysis: Text vs Vision for LLM Maze Navigation"
- GitHub repo with code + data
- Blog post with visualizations

---

## Open Questions

1. **Does visual reasoning transfer to other spatial tasks?**
   - If vision helps in mazes, does it help in:
     - Warehouse navigation
     - Game level solving
     - Route planning

2. **Can we fine-tune vision models for spatial navigation?**
   - Collect dataset of (maze image, optimal action) pairs
   - Fine-tune LLaVA specifically for navigation
   - How much better can it get?

3. **What's the minimal visual representation?**
   - Do we need color?
   - Do we need grid lines?
   - Could simple ASCII art work?

4. **Can agents build persistent visual memory?**
   - Show cumulative explored map each turn
   - Does this improve long-term planning?

5. **Do vision models "think" differently?**
   - Analyze reasoning patterns
   - Visual metaphors vs coordinate-based logic

---

## Resources

### Documentation
- **Ollama Vision Guide**: https://github.com/ollama/ollama/blob/main/docs/api.md#chat-with-images
- **LLaVA Paper**: https://arxiv.org/abs/2304.08485
- **Node Canvas Docs**: https://github.com/Automattic/node-canvas

### Inspiration
- **WebArena**: Vision-based web navigation (Chen et al., 2024)
- **MineDojo**: Vision-based Minecraft agents (Fan et al., 2022)
- **RT-2**: Robotics with vision-language models (Google, 2023)

### Related Work
- Vision-language models for embodied AI
- Spatial reasoning in multimodal LLMs
- Visual grounding for tool use

---

## Conclusion

Vision-based navigation with LLaVA represents a genuinely novel research direction for your Oriole project. The hypothesis that visual spatial reasoning outperforms text-based coordinate navigation is testable, and the results could be publishable.

**Next Steps**:
1. Run the quick local test to verify feasibility
2. Implement maze rendering service
3. Run one comparison experiment (text vs vision)
4. Decide whether to pursue full evaluation

This could evolve from "parameter sweep project" into "comparative study of modalities for LLM navigation" - a much more interesting research contribution.

**Estimated Total Effort**: 2-4 weeks for complete evaluation and analysis.
