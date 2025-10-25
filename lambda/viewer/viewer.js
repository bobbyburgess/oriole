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

    // Serve the viewer UI
    if (path === '/viewer') {
      const colors = await getColorConfig();
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'text/html'
        },
        body: getViewerHTML(colors)
      };
    }

    // Get list of all experiments
    if (path === '/experiments' && !path.includes('/experiments/')) {
      const db = await getDbClient();

      const result = await db.query(
        `SELECT id, model_name, goal_found, started_at
         FROM experiments
         WHERE completed_at IS NOT NULL
           AND failure_reason IS NULL
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
      const expResult = await db.query(
        'SELECT * FROM experiments WHERE id = $1',
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
      color: #4CAF50;
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
    #user-bar {
      position: fixed;
      top: 0;
      right: 0;
      padding: 10px 20px;
      background: #2a2a2a;
      border-bottom-left-radius: 8px;
      font-size: 16px;
      z-index: 100;
    }
    #user-bar a {
      color: #4CAF50;
      text-decoration: none;
      cursor: pointer;
    }
    #user-bar a:hover {
      text-decoration: underline;
    }
    #canvas-container {
      position: fixed;
      top: 0;
      left: 0;
      border: none;
    }
    canvas {
      display: block;
      background: ${colors.background};
    }
    #controls {
      position: fixed;
      bottom: 20px;
      left: 20px;
      padding: 20px;
      background: rgba(42, 42, 42, 0.95);
      border-radius: 8px;
      min-width: 350px;
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
      background: #4CAF50;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
    }
    button:hover {
      background: #45a049;
    }
    button:disabled {
      background: #555;
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
    #info {
      position: fixed;
      bottom: 20px;
      left: 410px;
      right: 20px;
      padding: 20px;
      background: rgba(42, 42, 42, 0.95);
      border-radius: 8px;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 16px;
      line-height: 1.8;
      max-height: calc(100vh - 40px);
      overflow-y: auto;
    }
    .stat {
      margin: 8px 0;
    }
    .stat strong {
      color: #4CAF50;
      min-width: 180px;
      display: inline-block;
    }
    .section-title {
      color: #FFD700;
      font-size: 18px;
      margin-top: 20px;
      margin-bottom: 10px;
      border-bottom: 1px solid #444;
      padding-bottom: 5px;
    }
    .section-title:first-child {
      margin-top: 0;
    }
    .error {
      color: #ff6b6b;
      margin: 10px 0;
    }
    .success {
      color: #4CAF50;
    }
    .failure {
      color: #ff6b6b;
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
    <div id="user-bar">
      <span id="user-info"></span>
    </div>

    <div id="canvas-container">
      <canvas id="mazeCanvas"></canvas>
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

      <div style="font-size: 14px; color: #999; margin-top: 10px;">
        <span id="stepInfo">No experiment loaded</span>
      </div>
    </div>

    <div id="info">
      <div id="experimentInfo">Select an experiment from the dropdown to begin</div>
    </div>
  </div>

  <script>
    // Color configuration from Parameter Store
    const COLORS = ${JSON.stringify(colors)};

    // Cognito configuration
    const poolData = {
      UserPoolId: 'us-west-2_YyOSMp5U9',
      ClientId: '7o8esskkibq38qsf6nhisbm51b'
    };
    const userPool = new AmazonCognitoIdentity.CognitoUserPool(poolData);
    let jwtToken = null;
    let experimentData = null;
    let currentStep = 0;
    let autoplayInterval = null;
    const CELL_SIZE = 12;  // 12px per cell = 720x720 for 60x60 grid

    // Check if already logged in
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

    function logout() {
      const cognitoUser = userPool.getCurrentUser();
      if (cognitoUser) {
        cognitoUser.signOut();
      }
      jwtToken = null;
      document.getElementById('login-form').style.display = 'block';
      document.getElementById('viewer-content').style.display = 'none';
    }

    async function showViewer(username) {
      document.getElementById('login-form').style.display = 'none';
      document.getElementById('viewer-content').style.display = 'block';
      document.getElementById('user-info').innerHTML = \`\${username} (<a onclick="logout()">logout</a>)\`;

      // Set initial canvas size (for 60x60 grid)
      const canvas = document.getElementById('mazeCanvas');
      canvas.width = 60 * CELL_SIZE;
      canvas.height = 60 * CELL_SIZE;

      // Load experiments list
      await loadExperimentsList();
    }

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

          const successIcon = exp.goal_found ? '✓' : '✗';
          const successClass = exp.goal_found ? 'success' : 'failure';
          const successText = exp.goal_found ? 'Success' : 'Failure';

          option.textContent = \`\${exp.id} - \${exp.model_name} - \${successIcon} \${successText}\`;
          option.className = successClass;
          dropdown.appendChild(option);
        });

        console.log('Loaded', experiments.length, 'experiments');
      } catch (error) {
        console.error('Error loading experiments list:', error);
      }
    }

    async function loadExperiment() {
      try {
        const experimentId = document.getElementById('experimentDropdown').value;

        if (!experimentId) {
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
          document.getElementById('experimentInfo').innerHTML = \`<span class="error">Error loading experiment: \${response.status} - \${errorText}</span>\`;
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
        document.getElementById('experimentInfo').innerHTML = \`<span class="error">Error: \${error.message}</span>\`;
      }
    }

    function restart() {
      if (!experimentData) return;

      currentStep = 0;

      // Stop autoplay if running
      if (autoplayInterval) {
        toggleAutoplay();
      }

      render();
    }

    function render() {
      if (!experimentData) return;

      const canvas = document.getElementById('mazeCanvas');
      const ctx = canvas.getContext('2d');
      const maze = experimentData.maze;
      const grid = maze.grid_data;

      // Set canvas size
      canvas.width = maze.width * CELL_SIZE;
      canvas.height = maze.height * CELL_SIZE;

      // Clear canvas
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw grid
      for (let y = 0; y < grid.length; y++) {
        for (let x = 0; x < grid[y].length; x++) {
          const cell = grid[y][x];

          if (cell === 1) {
            // Wall
            ctx.fillStyle = COLORS.wall;
          } else if (cell === 2) {
            // Goal
            ctx.fillStyle = COLORS.goal;
          } else {
            // Empty
            ctx.fillStyle = COLORS.background;
          }

          ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
      }

      // Draw seen tiles
      if (currentStep < experimentData.actions.length) {
        const action = experimentData.actions[currentStep];
        if (action.tiles_seen) {
          ctx.fillStyle = COLORS.seen;
          for (const coord in action.tiles_seen) {
            const [x, y] = coord.split(',').map(Number);
            ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
          }
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

      let infoHTML = '<div class="section-title">Experiment Info</div>';
      infoHTML += \`<div class="stat"><strong>Experiment ID:</strong> \${exp.id}</div>\`;
      infoHTML += \`<div class="stat"><strong>Agent ID:</strong> \${exp.agent_id || 'N/A'}</div>\`;
      infoHTML += \`<div class="stat"><strong>Model:</strong> \${exp.model_name || 'N/A'}</div>\`;

      if (exp.prompt_version) {
        infoHTML += \`<div class="stat"><strong>Prompt Version:</strong> \${exp.prompt_version}</div>\`;
      }

      infoHTML += \`<div class="stat"><strong>Goal Found:</strong> <span class="\${exp.goal_found ? 'success' : 'failure'}">\${exp.goal_found ? 'Yes ✓' : 'No ✗'}</span></div>\`;

      if (exp.failure_reason) {
        infoHTML += \`<div class="stat"><strong>Failure Reason:</strong> \${exp.failure_reason}</div>\`;
      }

      infoHTML += \`<div class="stat"><strong>Total Moves:</strong> \${experimentData.actions.length}</div>\`;

      if (exp.total_input_tokens || exp.total_output_tokens) {
        infoHTML += '<div class="section-title">Token Usage</div>';
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
      }

      if (exp.total_cost_usd) {
        infoHTML += '<div class="section-title">Cost</div>';
        infoHTML += \`<div class="stat"><strong>Total Cost:</strong> $\${exp.total_cost_usd.toFixed(6)}</div>\`;
      }

      if (exp.started_at) {
        infoHTML += \`<div class="stat"><strong>Started:</strong> \${new Date(exp.started_at).toLocaleString()}</div>\`;
      }
      if (exp.completed_at) {
        infoHTML += \`<div class="stat"><strong>Completed:</strong> \${new Date(exp.completed_at).toLocaleString()}</div>\`;
      }

      infoHTML += '<div class="section-title">Grid Info</div>';
      infoHTML += \`<div class="stat"><strong>Grid Name:</strong> \${mazeInfo.name}</div>\`;
      infoHTML += \`<div class="stat"><strong>Dimensions:</strong> \${mazeInfo.width} × \${mazeInfo.height}</div>\`;

      if (mazeInfo.see_through_walls !== undefined) {
        infoHTML += \`<div class="stat"><strong>See Through Walls:</strong> \${mazeInfo.see_through_walls ? 'Yes' : 'No'}</div>\`;
      }

      if (exp.goal_description) {
        infoHTML += \`<div class="stat"><strong>Goal:</strong> \${exp.goal_description}</div>\`;
      }

      infoHTML += \`<div class="stat"><strong>Start Position:</strong> (\${exp.start_x}, \${exp.start_y})</div>\`;

      if (action) {
        infoHTML += '<div class="section-title">Current Step</div>';
        infoHTML += \`<div class="stat"><strong>Step Number:</strong> \${action.step_number}</div>\`;
        infoHTML += \`<div class="stat"><strong>Action:</strong> \${action.action_type}</div>\`;
        infoHTML += \`<div class="stat"><strong>From:</strong> (\${action.from_x}, \${action.from_y})</div>\`;

        if (action.to_x !== null && action.to_y !== null) {
          infoHTML += \`<div class="stat"><strong>To:</strong> (\${action.to_x}, \${action.to_y})</div>\`;
        }

        infoHTML += \`<div class="stat"><strong>Action Success:</strong> \${action.success ? 'Yes' : 'No (hit wall)'}</div>\`;

        if (action.input_tokens || action.output_tokens) {
          const stepTokens = (action.input_tokens || 0) + (action.output_tokens || 0);
          infoHTML += \`<div class="stat"><strong>Step Tokens:</strong> \${action.input_tokens || 0} in / \${action.output_tokens || 0} out (\${stepTokens} total)</div>\`;
        }

        if (action.cost_usd) {
          infoHTML += \`<div class="stat"><strong>Step Cost:</strong> $\${action.cost_usd.toFixed(6)}</div>\`;
        }

        if (action.timestamp) {
          infoHTML += \`<div class="stat"><strong>Timestamp:</strong> \${new Date(action.timestamp).toLocaleString()}</div>\`;
        }

        if (action.reasoning) {
          infoHTML += \`<div class="stat"><strong>Reasoning:</strong> \${action.reasoning}</div>\`;
        }
      }

      document.getElementById('experimentInfo').innerHTML = infoHTML;
      document.getElementById('stepInfo').textContent = experimentData ? \`Step \${currentStep + 1} / \${experimentData.actions.length}\` : 'No experiment loaded';
    }

    function stepForward() {
      if (experimentData && currentStep < experimentData.actions.length - 1) {
        currentStep++;
        render();
      }
    }

    function toggleAutoplay() {
      if (autoplayInterval) {
        clearInterval(autoplayInterval);
        autoplayInterval = null;
        document.getElementById('playBtn').textContent = '▶ Play';
      } else {
        const speed = parseInt(document.getElementById('speedDial').value) || 500;
        autoplayInterval = setInterval(() => {
          stepForward();
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
