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
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'text/html'
        },
        body: getViewerHTML()
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

function getViewerHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Oriole Maze Viewer</title>
  <script src="https://cdn.jsdelivr.net/npm/amazon-cognito-identity-js@6.3.6/dist/amazon-cognito-identity.min.js"></script>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 20px;
      background: #1a1a1a;
      color: #e0e0e0;
    }
    h1 {
      color: #4CAF50;
    }
    #login-form {
      margin: 20px 0;
      padding: 20px;
      background: #2a2a2a;
      border-radius: 8px;
      max-width: 400px;
    }
    #login-form input {
      width: 100%;
      margin: 10px 0;
      padding: 10px;
      background: #333;
      border: 1px solid #555;
      color: #e0e0e0;
      border-radius: 4px;
      box-sizing: border-box;
    }
    #viewer-content {
      display: none;
    }
    #controls {
      margin: 20px 0;
      padding: 15px;
      background: #2a2a2a;
      border-radius: 8px;
    }
    button {
      padding: 10px 20px;
      margin: 5px;
      background: #4CAF50;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }
    button:hover {
      background: #45a049;
    }
    button:disabled {
      background: #555;
      cursor: not-allowed;
    }
    #canvas-container {
      margin: 20px 0;
      border: 2px solid #444;
      border-radius: 8px;
      overflow: hidden;
    }
    canvas {
      display: block;
      background: #0a0a0a;
    }
    #info {
      margin: 20px 0;
      padding: 15px;
      background: #2a2a2a;
      border-radius: 8px;
      font-family: 'Courier New', monospace;
      font-size: 13px;
    }
    .stat {
      margin: 5px 0;
    }
    input {
      padding: 8px;
      margin: 5px;
      background: #333;
      border: 1px solid #555;
      color: #e0e0e0;
      border-radius: 4px;
    }
    .error {
      color: #ff6b6b;
      margin: 10px 0;
    }
  </style>
</head>
<body>
  <h1>🐦 Oriole Maze Viewer</h1>

  <div id="login-form">
    <h3>Sign In</h3>
    <input type="text" id="username" placeholder="Username" />
    <input type="password" id="password" placeholder="Password" />
    <button onclick="login()">Sign In</button>
    <div id="login-error" class="error"></div>
  </div>

  <div id="viewer-content">
    <div style="margin-bottom: 10px;">
      <span id="user-info"></span>
      <button onclick="logout()">Logout</button>
    </div>

    <div id="controls">
      <input type="number" id="experimentId" placeholder="Experiment ID" value="1" />
      <button onclick="loadExperiment()">Load Experiment</button>
      <br>
      <button onclick="stepBackward()" id="prevBtn">◀ Previous</button>
      <button onclick="stepForward()" id="nextBtn">Next ▶</button>
      <button onclick="toggleAutoplay()" id="playBtn">▶ Play</button>
      <span id="stepInfo"></span>
    </div>

    <div id="canvas-container">
      <canvas id="mazeCanvas" width="600" height="600"></canvas>
    </div>

    <div id="info">
      <div class="stat" id="experimentInfo">No experiment loaded</div>
      <div class="stat" id="currentAction"></div>
    </div>
  </div>

  <script>
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
    const CELL_SIZE = 10;

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

    function showViewer(username) {
      document.getElementById('login-form').style.display = 'none';
      document.getElementById('viewer-content').style.display = 'block';
      document.getElementById('user-info').textContent = \`Logged in as: \${username}\`;
    }

    async function loadExperiment() {
      try {
        const experimentId = document.getElementById('experimentId').value;
        console.log('Loading experiment:', experimentId);
        console.log('Using JWT token:', jwtToken ? 'present' : 'missing');

        const response = await fetch(\`/experiments/\${experimentId}\`, {
          headers: {
            'Authorization': jwtToken
          }
        });

        console.log('Response status:', response.status);

        if (!response.ok) {
          const errorText = await response.text();
          console.error('API error:', response.status, errorText);
          document.getElementById('experimentInfo').innerHTML = \`<span style="color: #ff6b6b;">Error loading experiment: \${response.status} - \${errorText}</span>\`;
          return;
        }

        experimentData = await response.json();
        console.log('Experiment data loaded:', experimentData);
        currentStep = 0;
        render();
      } catch (error) {
        console.error('Error loading experiment:', error);
        document.getElementById('experimentInfo').innerHTML = \`<span style="color: #ff6b6b;">Error: \${error.message}</span>\`;
      }
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
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw grid
      for (let y = 0; y < grid.length; y++) {
        for (let x = 0; x < grid[y].length; x++) {
          const cell = grid[y][x];

          if (cell === 1) {
            // Wall
            ctx.fillStyle = '#555';
          } else if (cell === 2) {
            // Goal
            ctx.fillStyle = '#FFD700';
          } else {
            // Empty - check if seen
            ctx.fillStyle = '#0a0a0a';
          }

          ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
      }

      // Draw seen tiles
      if (currentStep < experimentData.actions.length) {
        const action = experimentData.actions[currentStep];
        if (action.tiles_seen) {
          ctx.fillStyle = 'rgba(100, 150, 255, 0.2)';
          for (const coord in action.tiles_seen) {
            const [x, y] = coord.split(',').map(Number);
            ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
          }
        }
      }

      // Draw agent position
      if (currentStep < experimentData.actions.length) {
        const action = experimentData.actions[currentStep];
        const x = action.to_x || action.from_x;
        const y = action.to_y || action.from_y;

        ctx.fillStyle = '#4CAF50';
        ctx.fillRect(
          x * CELL_SIZE + 1,
          y * CELL_SIZE + 1,
          CELL_SIZE - 2,
          CELL_SIZE - 2
        );
      }

      // Update info
      document.getElementById('experimentInfo').innerHTML = \`
        <strong>Model:</strong> \${experimentData.experiment.model_name}<br>
        <strong>Maze:</strong> \${experimentData.maze.name}<br>
        <strong>Total Moves:</strong> \${experimentData.actions.length}<br>
        <strong>Success:</strong> \${experimentData.experiment.success ? 'Yes' : 'No'}
      \`;

      if (currentStep < experimentData.actions.length) {
        const action = experimentData.actions[currentStep];
        document.getElementById('currentAction').innerHTML = \`
          <strong>Step \${action.step_number}:</strong> \${action.action_type}<br>
          <strong>Position:</strong> (\${action.to_x || action.from_x}, \${action.to_y || action.from_y})<br>
          <strong>Reasoning:</strong> \${action.reasoning || 'N/A'}
        \`;
      }

      document.getElementById('stepInfo').textContent = \`Step \${currentStep + 1} / \${experimentData.actions.length}\`;
    }

    function stepForward() {
      if (experimentData && currentStep < experimentData.actions.length - 1) {
        currentStep++;
        render();
      }
    }

    function stepBackward() {
      if (experimentData && currentStep > 0) {
        currentStep--;
        render();
      }
    }

    function toggleAutoplay() {
      if (autoplayInterval) {
        clearInterval(autoplayInterval);
        autoplayInterval = null;
        document.getElementById('playBtn').textContent = '▶ Play';
      } else {
        autoplayInterval = setInterval(() => {
          stepForward();
          if (currentStep === experimentData.actions.length - 1) {
            toggleAutoplay();
          }
        }, 500);
        document.getElementById('playBtn').textContent = '⏸ Pause';
      }
    }
  </script>
</body>
</html>`;
}
