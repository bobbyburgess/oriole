// Viewer Lambda - serves maze replay UI and experiment data

const { Client } = require('pg');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const ssmClient = new SSMClient();
let client = null;
let cachedDbPassword = null;

async function getDbPassword() {
  if (cachedDbPassword) {
    return cachedDbPassword;
  }

  const command = new GetParameterCommand({
    Name: '/oriole/db/password',
    WithDecryption: true
  });

  const response = await ssmClient.send(command);
  cachedDbPassword = response.Parameter.Value;
  return cachedDbPassword;
}

async function getColorConfig() {
  const colorParams = [
    { key: 'background', path: '/oriole/viewer/color/background', default: '#0a0a0a' },
    { key: 'wall', path: '/oriole/viewer/color/wall', default: '#555' },
    { key: 'goal', path: '/oriole/viewer/color/goal', default: '#FFD700' },
    { key: 'agent', path: '/oriole/viewer/color/agent', default: '#4CAF50' },
    { key: 'seen', path: '/oriole/viewer/color/seen', default: 'rgba(100, 150, 255, 0.2)' },
  ];

  const colors = {};

  for (const param of colorParams) {
    try {
      const command = new GetParameterCommand({
        Name: param.path,
        WithDecryption: false
      });
      const response = await ssmClient.send(command);
      colors[param.key] = response.Parameter.Value;
    } catch (error) {
      // Use default if parameter doesn't exist
      colors[param.key] = param.default;
    }
  }

  return colors;
}

async function getDbClient() {
  if (client) {
    return client;
  }

  const password = await getDbPassword();

  client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: password,
    ssl: {
      rejectUnauthorized: false
    }
  });

  await client.connect();
  return client;
}

exports.handler = async (event) => {
  try {
    const path = event.rawPath || event.path || '';

    // Redirect root path to /viewer
    if (path === '/' || path === '') {
      return {
        statusCode: 302,
        headers: {
          'Location': '/viewer'
        },
        body: ''
      };
    }

    // Serve the viewer UI
    if (path === '/viewer') {
      const colors = await getColorConfig();
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8'
        },
        body: getViewerHTML(colors)
      };
    }

    // Get list of all experiments
    if (path === '/experiments' && !path.includes('/experiments/')) {
      const db = await getDbClient();

      const result = await db.query(
        `SELECT id, model_name, goal_found, started_at,
                CASE
                  WHEN failure_reason IS NULL THEN NULL
                  WHEN failure_reason::text ~ '^\\s*\\{' THEN failure_reason::json->>'errorType'
                  ELSE failure_reason::text
                END as error_type
         FROM experiments
         WHERE completed_at IS NOT NULL
         ORDER BY id DESC
         LIMIT 100`
      );

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(result.rows)
      };
    }

    // Get experiment data
    if (path.startsWith('/experiments/')) {
      const experimentId = parseInt(path.split('/')[2]);

      if (!experimentId) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid experiment ID' })
        };
      }

      const db = await getDbClient();

      // Get experiment details
      // Use view to get calculated token/cost columns
      const expResult = await db.query(
        'SELECT * FROM v_experiments_with_costs WHERE id = $1',
        [experimentId]
      );

      if (expResult.rows.length === 0) {
        return {
          statusCode: 404,
          body: JSON.stringify({ error: 'Experiment not found' })
        };
      }

      const experiment = expResult.rows[0];

      // Get maze
      const mazeResult = await db.query(
        'SELECT * FROM mazes WHERE id = $1',
        [experiment.maze_id]
      );
      const maze = mazeResult.rows[0];

      // Get all actions
      const actionsResult = await db.query(
        `SELECT * FROM agent_actions
         WHERE experiment_id = $1
         ORDER BY step_number`,
        [experimentId]
      );

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          experiment,
          maze,
          actions: actionsResult.rows
        })
      };
    }

    return {
      statusCode: 404,
      body: JSON.stringify({ error: 'Not found' })
    };

  } catch (error) {
    console.error('Viewer error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};

function getViewerHTML(colors) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Oriole</title>
  <script src="https://cdn.jsdelivr.net/npm/amazon-cognito-identity-js@6.3.6/dist/amazon-cognito-identity.min.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: #1a1a1a;
      color: #e0e0e0;
      overflow: hidden;
    }
    #login-form {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      padding: 30px;
      background: #2a2a2a;
      border-radius: 8px;
      min-width: 400px;
    }
    #login-form h3 {
      margin-bottom: 20px;
      color: #e0e0e0;
    }
    #login-form input {
      width: 100%;
      margin: 10px 0;
      padding: 12px;
      background: #333;
      border: 1px solid #555;
      color: #e0e0e0;
      border-radius: 4px;
      font-size: 14px;
    }
    #viewer-content {
      display: none;
      height: 100vh;
      width: 100vw;
    }
    #canvas-container {
      position: fixed;
      top: 0;
      left: 0;
      border: none;
      cursor: crosshair;
    }
    canvas {
      display: block;
      background: ${colors.background};
    }
    #canvas-tooltip {
      position: fixed;
      background: rgba(0, 0, 0, 0.9);
      color: #e0e0e0;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-family: 'Courier New', monospace;
      pointer-events: none;
      display: none;
      z-index: 1000;
      border: 1px solid #555;
    }
    #controls {
      position: fixed;
      top: 0;
      left: 730px;
      width: 720px;
      height: 250px;
      padding: 20px;
      background: rgba(42, 42, 42, 0.95);
      font-family: 'Consolas', 'Monaco', monospace;
      overflow: hidden;
    }
    #info {
      position: fixed;
      top: 250px;
      left: 730px;
      width: 720px;
      height: 470px;
      padding: 20px;
      background: rgba(42, 42, 42, 0.95);
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 14px;
      line-height: 1.6;
      overflow-y: auto;
    }
    #user-info {
      margin-top: 15px;
      padding-top: 15px;
      border-top: 1px solid #444;
      font-size: 14px;
      color: #999;
    }
    #user-info a {
      color: #999;
      text-decoration: none;
      cursor: pointer;
    }
    #user-info a:hover {
      color: #ccc;
      text-decoration: underline;
    }
    #experiment-selector {
      margin-bottom: 15px;
    }
    #experiment-selector select {
      width: 100%;
      padding: 10px;
      background: #333;
      border: 1px solid #555;
      color: #e0e0e0;
      border-radius: 4px;
      font-size: 14px;
      cursor: pointer;
    }
    #playback-controls {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    button {
      padding: 10px 20px;
      background: #555;
      color: #e0e0e0;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
    }
    button:hover {
      background: #666;
    }
    button:disabled {
      background: #333;
      cursor: not-allowed;
    }
    #speed-control {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #speed-control label {
      font-size: 14px;
      white-space: nowrap;
    }
    #speed-control input {
      width: 70px;
      padding: 8px;
      background: #333;
      border: 1px solid #555;
      color: #e0e0e0;
      border-radius: 4px;
      font-size: 14px;
    }
    .stat {
      margin: 4px 0;
    }
    .stat strong {
      color: #999;
      min-width: 160px;
      display: inline-block;
    }
    .error {
      color: #ff6b6b;
      margin: 10px 0;
    }
    .success {
      color: #e0e0e0;
    }
    .failure {
      color: #ff6b6b;
    }
    .throttled {
      color: #ffb347;
    }
  </style>
</head>
<body>
  <div id="login-form">
    <h3>Sign In</h3>
    <input type="text" id="username" placeholder="Username" />
    <input type="password" id="password" placeholder="Password" />
    <button onclick="login()">Sign In</button>
    <div id="login-error" class="error"></div>
  </div>

  <div id="viewer-content">
    <div id="canvas-container">
      <canvas id="mazeCanvas"></canvas>
      <div id="canvas-tooltip"></div>
    </div>

    <div id="controls">
      <div id="experiment-selector">
        <select id="experimentDropdown" onchange="loadExperiment()">
          <option value="">Loading experiments...</option>
        </select>
      </div>

      <div id="playback-controls">
        <button onclick="restart()" id="restartBtn">⏮ Restart</button>
        <button onclick="toggleAutoplay()" id="playBtn">▶ Play</button>
        <div id="speed-control">
          <label for="speedDial">Speed:</label>
          <input type="number" id="speedDial" min="100" max="5000" step="100" value="500" />
          <span>ms</span>
        </div>
      </div>

      <div style="margin-top: 10px;">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 14px;">
          <input type="checkbox" id="showPath" onchange="render()" style="cursor: pointer;" />
          <span>Show Path History</span>
        </label>
      </div>

      <div style="font-size: 14px; color: #999; margin-top: 10px;">
        <span id="stepInfo">No experiment loaded</span>
      </div>

      <div id="user-info"></div>
    </div>

    <div id="info">
      <div id="experimentInfo">Select an experiment from the dropdown to begin</div>
    </div>
  </div>

  <script>
    /**
     * GRID EXPLORATION VIEWER - Frontend Application
     *
     * This application visualizes AI agent experiments navigating 60x60 grids.
     * It provides playback controls to step through each action the agent took,
     * showing what the agent could see and the reasoning behind each move.
     *
     * Architecture:
     * - Authentication: AWS Cognito User Pools (user/password auth)
     * - Data API: Authenticated API Gateway endpoints return experiment data
     * - Rendering: HTML5 Canvas for grid visualization
     * - State: All experiment state stored in global variables (experimentData, currentStep)
     */

    /**
     * COLOR CONFIGURATION
     * Colors fetched from AWS Parameter Store on page load.
     * Can be changed at runtime via Parameter Store without redeploying code.
     *
     * Available colors:
     * - background: Canvas background and empty cells
     * - wall: Wall cells (value = 1 in grid_data)
     * - goal: Goal position(s) the agent must reach
     * - agent: Current agent position
     * - seen: Transparent overlay for tiles the agent has observed
     */
    const COLORS = ${JSON.stringify(colors)};

    /**
     * COGNITO AUTHENTICATION CONFIGURATION
     * UserPoolId and ClientId are public client credentials.
     * These are safe to expose in frontend code - they identify the user pool
     * but don't grant any access without valid username/password.
     */
    const poolData = {
      UserPoolId: 'us-west-2_YyOSMp5U9',
      ClientId: '7o8esskkibq38qsf6nhisbm51b'
    };
    const userPool = new AmazonCognitoIdentity.CognitoUserPool(poolData);

    /**
     * APPLICATION STATE
     * Global variables storing current application state.
     *
     * jwtToken: JWT ID token from Cognito, sent as Authorization header to API
     * experimentData: Full experiment object including maze, actions, metadata
     * currentStep: Current playback position (0-indexed into actions array)
     * autoplayInterval: Interval ID for automatic playback, null when stopped
     */
    let jwtToken = null;
    let experimentData = null;
    let currentStep = 0;
    let autoplayInterval = null;

    /**
     * GRID RENDERING CONFIGURATION
     * CELL_SIZE determines the pixel size of each grid cell.
     * For 60x60 grid: 12px * 60 = 720px canvas size
     */
    const CELL_SIZE = 12;

    /**
     * EVENT HANDLER REFERENCES
     * Store references to canvas event handlers so they can be removed
     * when user logs out/logs in again, preventing memory leaks.
     */
    let canvasMouseMoveHandler = null;
    let canvasMouseLeaveHandler = null;

    /**
     * INITIALIZE APPLICATION ON PAGE LOAD
     * Check if user is already authenticated (session cookie exists).
     * If valid session found, skip login form and go directly to viewer.
     * This enables persistent login across page refreshes.
     */
    window.onload = function() {
      const cognitoUser = userPool.getCurrentUser();
      if (cognitoUser) {
        cognitoUser.getSession((err, session) => {
          if (!err && session.isValid()) {
            jwtToken = session.getIdToken().getJwtToken();
            showViewer(cognitoUser.getUsername());
          }
        });
      }
    };

    /**
     * AUTHENTICATE USER WITH COGNITO
     * Validates username/password against Cognito User Pool.
     *
     * On success:
     * - Stores JWT token for API authentication
     * - Shows viewer UI with username displayed
     *
     * On failure:
     * - Displays error message below login form
     * - Common errors: incorrect password, user not found, user not confirmed
     */
    function login() {
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;

      const authenticationData = {
        Username: username,
        Password: password
      };

      const authenticationDetails = new AmazonCognitoIdentity.AuthenticationDetails(authenticationData);
      const userData = {
        Username: username,
        Pool: userPool
      };

      const cognitoUser = new AmazonCognitoIdentity.CognitoUser(userData);

      cognitoUser.authenticateUser(authenticationDetails, {
        onSuccess: function(session) {
          jwtToken = session.getIdToken().getJwtToken();
          showViewer(username);
        },
        onFailure: function(err) {
          document.getElementById('login-error').textContent = err.message || JSON.stringify(err);
        }
      });
    }

    /**
     * LOG OUT CURRENT USER
     * Signs out from Cognito and clears local session state.
     * Returns user to login form.
     *
     * Note: This does not clear experimentData or currentStep.
     * If user logs back in, previous experiment may still be loaded.
     */
    function logout() {
      const cognitoUser = userPool.getCurrentUser();
      if (cognitoUser) {
        cognitoUser.signOut();
      }
      jwtToken = null;
      document.getElementById('login-form').style.display = 'block';
      document.getElementById('viewer-content').style.display = 'none';
    }

    /**
     * SHOW VIEWER INTERFACE
     * Switches from login form to main viewer UI.
     * Sets up canvas and loads list of available experiments.
     *
     * This function is called either after successful login or when
     * existing valid session is found on page load.
     *
     * @param {string} username - Username to display in UI
     */
    async function showViewer(username) {
      document.getElementById('login-form').style.display = 'none';
      document.getElementById('viewer-content').style.display = 'block';
      document.getElementById('user-info').innerHTML = \`\${username} (<a onclick="logout()">logout</a>)\`;

      // Set canvas dimensions based on grid size
      // 60x60 grid * 12px per cell = 720x720px canvas
      const canvas = document.getElementById('mazeCanvas');
      canvas.width = 60 * CELL_SIZE;
      canvas.height = 60 * CELL_SIZE;

      /**
       * CANVAS TOOLTIP SETUP
       * Shows (x, y) coordinates when hovering over grid cells.
       * Event handlers are stored in global variables so they can be removed
       * if user logs out and logs back in, preventing multiple handlers
       * from being attached to the same canvas.
       */
      const tooltip = document.getElementById('canvas-tooltip');

      if (canvasMouseMoveHandler) {
        canvas.removeEventListener('mousemove', canvasMouseMoveHandler);
      }
      if (canvasMouseLeaveHandler) {
        canvas.removeEventListener('mouseleave', canvasMouseLeaveHandler);
      }

      // Remove old listeners to prevent duplicate handlers
      canvasMouseMoveHandler = (event) => {
        const rect = canvas.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;

        // Convert pixel coordinates to grid cell coordinates
        // Math.floor handles fractional positions (e.g., 12.7px -> cell 1)
        const gridX = Math.floor(mouseX / CELL_SIZE);
        const gridY = Math.floor(mouseY / CELL_SIZE);

        // Only show tooltip when mouse is over a valid grid cell
        // This prevents tooltip from showing when mouse is outside canvas bounds
        if (gridX >= 0 && gridX < 60 && gridY >= 0 && gridY < 60) {
          tooltip.textContent = \`(\${gridX}, \${gridY})\`;
          // Offset tooltip 15px from cursor to avoid obscuring the cell
          tooltip.style.left = (event.clientX + 15) + 'px';
          tooltip.style.top = (event.clientY + 15) + 'px';
          tooltip.style.display = 'block';
        } else {
          tooltip.style.display = 'none';
        }
      };

      canvasMouseLeaveHandler = () => {
        tooltip.style.display = 'none';
      };

      // Attach event listeners to canvas
      canvas.addEventListener('mousemove', canvasMouseMoveHandler);
      canvas.addEventListener('mouseleave', canvasMouseLeaveHandler);

      // Fetch and populate dropdown with available experiments
      await loadExperimentsList();
    }

    /**
     * LOAD EXPERIMENTS LIST
     * Fetches all completed experiments from API and populates dropdown.
     *
     * The API returns experiments in descending order by ID (most recent first).
     * Each experiment is displayed with:
     * - ID number
     * - Model name (e.g., "claude-3.5-haiku", "nova-lite")
     * - Outcome indicator:
     *   ✓ = Successfully found goal
     *   ✗ = Completed but didn't find goal
     *   ⚠ ErrorType = Failed due to error (e.g., ThrottlingException)
     *
     * The dropdown is color-coded:
     * - Green text for successful experiments
     * - Red text for failures
     * - Orange text for errors/throttling
     */
    async function loadExperimentsList() {
      try {
        const response = await fetch('/experiments', {
          headers: {
            'Authorization': jwtToken
          }
        });

        if (!response.ok) {
          console.error('Failed to load experiments list');
          return;
        }

        const experiments = await response.json();
        console.log('Loaded experiments:', experiments);

        const dropdown = document.getElementById('experimentDropdown');
        dropdown.innerHTML = '<option value="">Select an experiment...</option>';

        experiments.forEach(exp => {
          const option = document.createElement('option');
          option.value = exp.id;

          // Determine display text and style based on experiment outcome
          let displayText, className;
          if (exp.error_type) {
            // Failed experiment (e.g., ThrottlingException)
            displayText = \`\${exp.id} - \${exp.model_name} ⚠ \${exp.error_type}\`;
            className = 'throttled';
          } else if (exp.goal_found) {
            // Successfully found the goal
            displayText = \`\${exp.id} - \${exp.model_name} ✓\`;
            className = 'success';
          } else {
            // Completed but didn't find goal
            displayText = \`\${exp.id} - \${exp.model_name} ✗\`;
            className = 'failure';
          }

          option.textContent = displayText;
          option.className = className;
          dropdown.appendChild(option);
        });

        console.log('Loaded', experiments.length, 'experiments');
      } catch (error) {
        console.error('Error loading experiments list:', error);
      }
    }

    /**
     * LOAD EXPERIMENT DATA
     * Fetches full experiment details when user selects from dropdown.
     * Called automatically via onchange handler on dropdown element.
     *
     * The API returns a complete experiment object containing:
     * - experiment: Metadata (model, prompt version, timestamps, costs)
     * - maze: Grid structure (width, height, grid_data, goal position)
     * - actions: Array of all agent actions in chronological order
     *
     * Each action includes:
     * - step_number: Sequential step ID
     * - action_type: e.g., "move_north", "recall_all", "observe"
     * - from_x, from_y: Starting position
     * - to_x, to_y: Ending position (null if action didn't involve movement)
     * - success: Whether action succeeded (false if hit wall)
     * - tiles_seen: Object mapping "x,y" coordinates to cell values
     * - reasoning: Agent's explanation for why it took this action
     * - input_tokens, output_tokens: Token usage for this step
     * - cost_usd: Cost of this API call
     *
     * After loading, resets playback to step 0 and renders first frame.
     */
    async function loadExperiment() {
      try {
        const experimentId = document.getElementById('experimentDropdown').value;

        // Validate experiment ID is present
        if (!experimentId) {
          return;
        }

        /**
         * SECURITY: Validate experiment ID format
         * Ensures ID is a positive integer to prevent injection attacks.
         * Checks that parsed value matches original string to catch edge cases like:
         * - "123abc" (parseInt would return 123)
         * - " 123 " (with whitespace)
         * - "0" or negative numbers
         */
        const parsedId = parseInt(experimentId, 10);
        if (isNaN(parsedId) || parsedId <= 0 || parsedId.toString() !== experimentId.trim()) {
          console.error('Invalid experiment ID:', experimentId);

          const errorSpan = document.createElement('span');
          errorSpan.className = 'error';
          errorSpan.textContent = 'Invalid experiment ID. Please select a valid experiment.';

          const infoDiv = document.getElementById('experimentInfo');
          infoDiv.innerHTML = '';
          infoDiv.appendChild(errorSpan);
          return;
        }

        console.log('Loading experiment:', experimentId);

        const response = await fetch(\`/experiments/\${experimentId}\`, {
          headers: {
            'Authorization': jwtToken
          }
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('API error:', response.status, errorText);

          // Safely create error element to prevent XSS
          const errorSpan = document.createElement('span');
          errorSpan.className = 'error';
          errorSpan.textContent = \`Error loading experiment: \${response.status} - \${errorText}\`;

          const infoDiv = document.getElementById('experimentInfo');
          infoDiv.innerHTML = '';
          infoDiv.appendChild(errorSpan);
          return;
        }

        experimentData = await response.json();
        console.log('Experiment data loaded:', experimentData);
        currentStep = 0;

        // Stop autoplay if running
        if (autoplayInterval) {
          toggleAutoplay();
        }

        render();
      } catch (error) {
        console.error('Error loading experiment:', error);

        // Safely create error element to prevent XSS
        const errorSpan = document.createElement('span');
        errorSpan.className = 'error';
        errorSpan.textContent = \`Error: \${error.message}\`;

        const infoDiv = document.getElementById('experimentInfo');
        infoDiv.innerHTML = '';
        infoDiv.appendChild(errorSpan);
      }
    }

    /**
     * RESTART PLAYBACK
     * Resets playback to the first action (step 0).
     * Stops autoplay if currently running.
     */
    function restart() {
      if (!experimentData) return;

      currentStep = 0;

      // Stop autoplay if running to prevent unexpected behavior
      if (autoplayInterval) {
        toggleAutoplay();
      }

      render();
    }

    /**
     * RENDER CANVAS
     * Draws the current state of the grid exploration experiment.
     *
     * Rendering happens in layers (bottom to top):
     * 1. Grid structure (walls, empty cells, goal)
     * 2. Seen tiles (transparent overlay showing agent's observations)
     * 3. Path history (optional: all positions agent has visited)
     * 4. Agent position (highlighted square at current location)
     *
     * This function is called:
     * - When experiment is first loaded
     * - When user steps forward/backward through playback
     * - When autoplay advances to next step
     * - When path history checkbox is toggled
     *
     * Performance note: Currently redraws entire grid every call.
     * For a 60x60 grid, this is 3,600 cell renders per step.
     * Could be optimized to only redraw changed regions.
     */
    function render() {
      if (!experimentData) return;

      const canvas = document.getElementById('mazeCanvas');
      const ctx = canvas.getContext('2d');
      const maze = experimentData.maze;
      const grid = maze.grid_data;  // 2D array: grid[y][x] where 0=empty, 1=wall

      // Dynamically size canvas based on maze dimensions
      // Supports variable-sized mazes (not just 60x60)
      canvas.width = maze.width * CELL_SIZE;
      canvas.height = maze.height * CELL_SIZE;

      // Clear entire canvas with background color
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      /**
       * LAYER 1: GRID STRUCTURE
       * Draw the static maze layout.
       *
       * grid_data is a 2D array where grid[y][x] contains:
       * - 0: Empty/walkable cell
       * - 1: Wall (impassable)
       *
       * Goal position is stored separately in maze.goal_x, maze.goal_y
       * (not encoded in the grid_data array)
       */
      for (let y = 0; y < grid.length; y++) {
        for (let x = 0; x < grid[y].length; x++) {
          const cell = grid[y][x];

          if (x === maze.goal_x && y === maze.goal_y) {
            // Goal cell: Where agent needs to reach
            ctx.fillStyle = COLORS.goal;
          } else if (cell === 1) {
            // Wall cell: Impassable obstacle
            ctx.fillStyle = COLORS.wall;
          } else {
            // Empty cell: Walkable space
            ctx.fillStyle = COLORS.background;
          }

          ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
      }

      /**
       * LAYER 2: SEEN TILES
       * Show which cells the agent can observe at current step.
       *
       * tiles_seen is an object mapping "x,y" coordinate strings to cell values.
       * The transparent overlay shows the agent's current "field of view."
       * This changes at each step as the agent moves and observes new areas.
       */
      if (currentStep < experimentData.actions.length) {
        const action = experimentData.actions[currentStep];
        if (action.tiles_seen) {
          ctx.fillStyle = COLORS.seen;  // Semi-transparent blue overlay
          for (const coord in action.tiles_seen) {
            const [x, y] = coord.split(',').map(Number);
            ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
          }
        }
      }

      /**
       * LAYER 3: PATH HISTORY (OPTIONAL)
       * Shows all cells the agent has visited up to current step.
       *
       * Uses a Set to track unique positions, preventing duplicate rendering
       * if agent visits same cell multiple times.
       *
       * Excludes current position (drawn as agent marker in next layer).
       */
      const showPath = document.getElementById('showPath')?.checked;
      if (showPath && currentStep >= 0) {
        const visitedPositions = new Set();

        // Build set of all visited positions from step 0 to currentStep
        for (let i = 0; i <= currentStep; i++) {
          const act = experimentData.actions[i];

          // Use "to" position if move succeeded, otherwise "from" position
          // (failed moves don't change agent position)
          const posX = act.to_x !== null ? act.to_x : act.from_x;
          const posY = act.to_y !== null ? act.to_y : act.from_y;

          // Exclude current position (i === currentStep) to avoid overlapping with agent marker
          if (i < currentStep) {
            visitedPositions.add(\`\${posX},\${posY}\`);
          }
        }

        // Draw path with subtle brown/tan overlay
        ctx.fillStyle = 'rgba(200, 150, 100, 0.3)';
        for (const pos of visitedPositions) {
          const [x, y] = pos.split(',').map(Number);
          ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
      }

      // Draw agent position
      if (currentStep < experimentData.actions.length) {
        const action = experimentData.actions[currentStep];
        const x = action.to_x !== null ? action.to_x : action.from_x;
        const y = action.to_y !== null ? action.to_y : action.from_y;

        ctx.fillStyle = COLORS.agent;
        ctx.fillRect(
          x * CELL_SIZE + 1,
          y * CELL_SIZE + 1,
          CELL_SIZE - 2,
          CELL_SIZE - 2
        );
      }

      // Update info display with comprehensive data
      const exp = experimentData.experiment;
      const mazeInfo = experimentData.maze;
      const action = currentStep < experimentData.actions.length ? experimentData.actions[currentStep] : null;

      let infoHTML = '';

      // Step-specific info first (if action exists)
      if (action) {
        if (action.timestamp) {
          infoHTML += \`<div class="stat"><strong>Timestamp:</strong> \${new Date(action.timestamp).toLocaleString()}</div>\`;
        }
      }

      // Grid info
      infoHTML += \`<div class="stat"><strong>Grid Name:</strong> \${mazeInfo.name}</div>\`;

      // Step details
      if (action) {
        infoHTML += \`<div class="stat"><strong>Step Number:</strong> \${action.step_number}</div>\`;
        infoHTML += \`<div class="stat"><strong>Action:</strong> \${action.action_type}</div>\`;
        infoHTML += \`<div class="stat"><strong>From:</strong> (\${action.from_x}, \${action.from_y})</div>\`;

        if (action.to_x !== null && action.to_y !== null) {
          infoHTML += \`<div class="stat"><strong>To:</strong> (\${action.to_x}, \${action.to_y})</div>\`;
        }

        infoHTML += \`<div class="stat"><strong>Action Success:</strong> \${action.success ? 'Yes' : 'No'}</div>\`;
      }

      // Experiment metadata
      infoHTML += \`<div class="stat"><strong>Bedrock Agent ID:</strong> \${exp.agent_id || 'N/A'}</div>\`;
      infoHTML += \`<div class="stat"><strong>Model:</strong> \${exp.model_name || 'N/A'}</div>\`;

      if (exp.prompt_version) {
        infoHTML += \`<div class="stat"><strong>Prompt Version:</strong> \${exp.prompt_version}</div>\`;
      }

      infoHTML += \`<div class="stat"><strong>Goal Found:</strong> <span class="\${exp.goal_found ? 'success' : 'failure'}">\${exp.goal_found ? 'Yes ✓' : 'No ✗'}</span></div>\`;

      // Total moves
      infoHTML += \`<div class="stat"><strong>Total Moves:</strong> \${experimentData.actions.length}</div>\`;

      // Token counts
      if (exp.total_input_tokens) {
        infoHTML += \`<div class="stat"><strong>Input Tokens:</strong> \${exp.total_input_tokens.toLocaleString()}</div>\`;
      }
      if (exp.total_output_tokens) {
        infoHTML += \`<div class="stat"><strong>Output Tokens:</strong> \${exp.total_output_tokens.toLocaleString()}</div>\`;
      }
      const totalTokens = (exp.total_input_tokens || 0) + (exp.total_output_tokens || 0);
      if (totalTokens > 0) {
        infoHTML += \`<div class="stat"><strong>Total Tokens:</strong> \${totalTokens.toLocaleString()}</div>\`;
      }

      // Cost
      if (exp.total_cost_usd) {
        infoHTML += \`<div class="stat"><strong>Total Cost:</strong> $\${Number(exp.total_cost_usd).toFixed(6)}</div>\`;
      }

      // Real-time duration
      if (exp.started_at && exp.completed_at) {
        const start = new Date(exp.started_at);
        const end = new Date(exp.completed_at);
        const durationMs = end - start;
        const minutes = Math.floor(durationMs / 60000);
        const seconds = Math.floor((durationMs % 60000) / 1000);
        const durationStr = \`\${minutes}m \${seconds}s\`;
        infoHTML += \`<div class="stat"><strong>Real-time Duration:</strong> \${durationStr} (\${start.toLocaleString()} - \${end.toLocaleString()})</div>\`;
      }

      // See through walls
      if (mazeInfo.see_through_walls !== undefined) {
        infoHTML += \`<div class="stat"><strong>See Through Walls:</strong> \${mazeInfo.see_through_walls ? 'Yes' : 'No'}</div>\`;
      }

      // Reasoning (last, as it can be long)
      if (action && action.reasoning) {
        infoHTML += \`<div class="stat"><strong>Reasoning:</strong> \${action.reasoning}</div>\`;
      }

      document.getElementById('experimentInfo').innerHTML = infoHTML;
      document.getElementById('stepInfo').textContent = experimentData ? \`Step \${currentStep + 1} / \${experimentData.actions.length}\` : 'No experiment loaded';
    }

    /**
     * STEP FORWARD
     * Advances playback by one action.
     * If already at last action, does nothing.
     *
     * Called by:
     * - Autoplay interval timer
     * - Could be called by keyboard navigation (not currently implemented)
     */
    function stepForward() {
      if (experimentData && currentStep < experimentData.actions.length - 1) {
        currentStep++;
        render();
      }
    }

    /**
     * TOGGLE AUTOPLAY
     * Starts or stops automatic advancement through actions.
     *
     * When starting autoplay:
     * - Reads speed from speedDial input (milliseconds per step)
     * - Creates interval that calls stepForward() repeatedly
     * - Updates button text to "⏸ Pause"
     * - Auto-stops when reaching final action
     *
     * When stopping autoplay:
     * - Clears interval timer
     * - Updates button text to "▶ Play"
     * - Preserves current position (does not reset to step 0)
     *
     * Speed dial range: 100ms (very fast) to 5000ms (slow)
     * Default: 500ms per step if speedDial value is invalid
     */
    function toggleAutoplay() {
      if (autoplayInterval) {
        // Stop autoplay
        clearInterval(autoplayInterval);
        autoplayInterval = null;
        document.getElementById('playBtn').textContent = '▶ Play';
      } else {
        // Start autoplay
        const speed = parseInt(document.getElementById('speedDial').value) || 500;
        autoplayInterval = setInterval(() => {
          stepForward();
          // Auto-stop when reaching end of actions
          if (currentStep === experimentData.actions.length - 1) {
            toggleAutoplay();
          }
        }, speed);
        document.getElementById('playBtn').textContent = '⏸ Pause';
      }
    }
  </script>
</body>
</html>`;
}
