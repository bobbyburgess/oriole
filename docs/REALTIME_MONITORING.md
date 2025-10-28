# Real-Time Experiment Monitoring Architecture

## Option 1: PostgreSQL LISTEN/NOTIFY (Recommended)

### How It Works

```
PostgreSQL Trigger → NOTIFY → Node.js Listener → WebSocket → Browser
     (on INSERT)                  (pg library)     (ws/socket.io)
```

### Implementation Steps

#### 1. PostgreSQL Setup (Create Trigger)

```sql
-- Create notification function
CREATE OR REPLACE FUNCTION notify_agent_action()
RETURNS trigger AS $$
BEGIN
  -- Send notification with experiment_id and action data
  PERFORM pg_notify(
    'agent_action_update',
    json_build_object(
      'experiment_id', NEW.experiment_id,
      'step_number', NEW.step_number,
      'action_type', NEW.action_type,
      'from_x', NEW.from_x,
      'from_y', NEW.from_y,
      'to_x', NEW.to_x,
      'to_y', NEW.to_y,
      'success', NEW.success,
      'timestamp', NEW.timestamp
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach trigger to agent_actions table
CREATE TRIGGER agent_action_notify_trigger
AFTER INSERT ON agent_actions
FOR EACH ROW
EXECUTE FUNCTION notify_agent_action();

-- Optional: Notify on experiment completion
CREATE OR REPLACE FUNCTION notify_experiment_complete()
RETURNS trigger AS $$
BEGIN
  IF NEW.completed_at IS NOT NULL AND OLD.completed_at IS NULL THEN
    PERFORM pg_notify(
      'experiment_complete',
      json_build_object(
        'experiment_id', NEW.id,
        'model_name', NEW.model_name,
        'goal_found', NEW.goal_found
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER experiment_complete_notify_trigger
AFTER UPDATE ON experiments
FOR EACH ROW
EXECUTE FUNCTION notify_experiment_complete();
```

#### 2. Node.js WebSocket Server

```javascript
// lambda/viewer/realtime-server.js (or standalone Express app)
const express = require('express');
const { Server } = require('socket.io');
const { Client } = require('pg');

const app = express();
const server = require('http').createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// PostgreSQL connection
const pgClient = new Client({
  host: process.env.DB_HOST,
  port: 5432,
  database: 'oriole',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

pgClient.connect();

// Listen for PostgreSQL notifications
pgClient.query('LISTEN agent_action_update');
pgClient.query('LISTEN experiment_complete');

pgClient.on('notification', (msg) => {
  const data = JSON.parse(msg.payload);

  // Broadcast to all connected WebSocket clients
  io.emit(msg.channel, data);

  console.log(`[${msg.channel}]`, data);
});

// WebSocket connection handler
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Client can subscribe to specific experiments
  socket.on('subscribe', (experimentId) => {
    socket.join(`experiment_${experimentId}`);
    console.log(`Client ${socket.id} subscribed to experiment ${experimentId}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

server.listen(3000, () => {
  console.log('Real-time server listening on port 3000');
});
```

#### 3. Frontend (React/Vue/Vanilla JS)

```html
<!DOCTYPE html>
<html>
<head>
  <title>Oriole Live Monitor</title>
  <script src="https://cdn.socket.io/4.5.4/socket.io.min.js"></script>
  <style>
    .maze-grid { display: grid; grid-template-columns: repeat(60, 10px); }
    .cell { width: 10px; height: 10px; border: 1px solid #eee; }
    .agent { background: blue; }
    .wall { background: black; }
    .visited { background: lightblue; }
    .goal { background: gold; }
  </style>
</head>
<body>
  <h1>Live Experiment Monitor</h1>
  <div id="status">Connecting...</div>
  <div id="maze-grid" class="maze-grid"></div>
  <div id="action-log"></div>

  <script>
    const socket = io('http://localhost:3000');
    const experimentId = 20; // From URL params

    socket.on('connect', () => {
      document.getElementById('status').textContent = '🟢 Connected';
      socket.emit('subscribe', experimentId);
    });

    // Listen for real-time action updates
    socket.on('agent_action_update', (data) => {
      if (data.experiment_id === experimentId) {
        console.log('New action:', data);

        // Update maze visualization
        updateMazeCell(data.to_x, data.to_y, 'visited');
        updateAgentPosition(data.to_x, data.to_y);

        // Add to action log
        const log = document.getElementById('action-log');
        log.innerHTML = `<div>Step ${data.step_number}: ${data.action_type} → (${data.to_x}, ${data.to_y}) ${data.success ? '✅' : '❌'}</div>` + log.innerHTML;
      }
    });

    socket.on('experiment_complete', (data) => {
      if (data.experiment_id === experimentId) {
        alert(`Experiment complete! Goal found: ${data.goal_found}`);
      }
    });

    function updateMazeCell(x, y, className) {
      // Update grid visualization
      const cell = document.querySelector(`[data-x="${x}"][data-y="${y}"]`);
      if (cell) cell.className = `cell ${className}`;
    }

    function updateAgentPosition(x, y) {
      // Remove old agent position
      document.querySelectorAll('.agent').forEach(el => el.classList.remove('agent'));
      // Add new position
      updateMazeCell(x, y, 'agent');
    }
  </script>
</body>
</html>
```

---

## Option 2: AWS AppSync (GraphQL Subscriptions)

**Pros:**
- Managed service (no server to run)
- Built-in WebSocket handling
- Integrates with Lambda/DynamoDB

**Cons:**
- More complex setup
- Additional AWS service cost
- Would need DynamoDB streams or Lambda polling

**Architecture:**
```
PostgreSQL → Lambda (polling) → AppSync → GraphQL Subscription → Browser
```

---

## Option 3: Server-Sent Events (SSE)

Simpler than WebSocket for one-way updates:

```javascript
// Express endpoint
app.get('/stream/:experimentId', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const pgClient = new Client(/* config */);
  await pgClient.connect();
  await pgClient.query('LISTEN agent_action_update');

  pgClient.on('notification', (msg) => {
    const data = JSON.parse(msg.payload);
    if (data.experiment_id == req.params.experimentId) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  });

  req.on('close', () => pgClient.end());
});
```

```javascript
// Frontend
const eventSource = new EventSource('/stream/20');
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  updateVisualization(data);
};
```

---

## Performance Considerations

### LISTEN/NOTIFY Limits
- ✅ Payload max: 8000 bytes (plenty for action data)
- ✅ Handles 1000s of notifications/sec
- ✅ Low latency (~10ms)
- ❌ Not persistent (if listener disconnects, misses notifications)

### Scalability
**Small scale (1-10 concurrent viewers):**
- Single Node.js server with pg LISTEN ✅

**Medium scale (10-100 viewers):**
- Redis pub/sub as intermediary
- Multiple WebSocket servers behind load balancer

**Large scale (100+ viewers):**
- Consider AWS AppSync or dedicated real-time service

---

## Deployment Options

### Option A: Lambda + API Gateway WebSocket
**Pros:** Serverless, scales automatically
**Cons:** Complex setup, cold starts

### Option B: Standalone Node.js on EC2/ECS
**Pros:** Simple, full control
**Cons:** Server management, fixed capacity

### Option C: Add to existing viewer Lambda
**Pros:** Reuse infrastructure
**Cons:** Lambda not ideal for long-lived connections

**Recommendation:** Start with standalone Node.js server (simplest)

---

## Quick POC (10 minutes)

1. **Create triggers:**
```bash
psql -h your-db -U oriole_user -d oriole -f create-triggers.sql
```

2. **Run test listener:**
```javascript
// test-listener.js
const { Client } = require('pg');
const client = new Client({/* your config */});

client.connect();
client.query('LISTEN agent_action_update');

client.on('notification', (msg) => {
  console.log('🔔', msg.channel, JSON.parse(msg.payload));
});

console.log('Listening for updates...');
```

3. **Test it:**
```bash
node test-listener.js
# In another terminal, trigger experiment
# Watch notifications appear in real-time!
```

---

## Alternative: Polling (Simpler but Less Efficient)

If you want to avoid triggers/LISTEN:

```javascript
// Poll every 2 seconds
setInterval(async () => {
  const result = await db.query(`
    SELECT * FROM agent_actions
    WHERE experiment_id = $1
      AND step_number > $2
    ORDER BY step_number
  `, [experimentId, lastSeenStep]);

  result.rows.forEach(action => {
    io.emit('agent_action', action);
    lastSeenStep = action.step_number;
  });
}, 2000);
```

**Pros:** No triggers needed, simple
**Cons:** Higher DB load, 2s latency

---

## Cost Analysis

**PostgreSQL LISTEN/NOTIFY:**
- Cost: $0 (included in RDS)
- Latency: ~10ms
- Resource: Minimal

**WebSocket Server (t3.small EC2):**
- Cost: ~$15/month
- Can handle 100+ concurrent viewers

**AppSync:**
- Cost: ~$4/million messages
- For 1000 actions/experiment × 100 experiments/day = $0.40/day

**Recommendation:** LISTEN/NOTIFY + Node.js server is most cost-effective

---

## Next Steps

Want me to:
1. ✅ Create the PostgreSQL triggers?
2. ✅ Build a simple Node.js WebSocket server?
3. ✅ Create a basic HTML viewer page?
4. ✅ Add to your existing viewer app?
