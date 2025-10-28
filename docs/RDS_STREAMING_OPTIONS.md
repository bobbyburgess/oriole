# RDS Streaming Options Comparison

## Option 1: RDS Enhanced Monitoring (CloudWatch Logs)

**What it streams:**
- ❌ NOT application data (your experiments/actions)
- ✅ Database metrics (CPU, memory, I/O, connections)
- ✅ OS-level metrics from RDS instance

**Example metrics:**
```json
{
  "engine": "PostgreSQL",
  "instanceID": "continuum-prod1",
  "cpuUtilization": {"total": 23.5},
  "diskIO": {"readLatency": 0.5}
}
```

**Use case:** Infrastructure monitoring, NOT data changes

**Verdict:** ❌ Not suitable for tracking experiment updates

---

## Option 2: PostgreSQL Audit/General Logs → CloudWatch

**What it logs:**
- SQL queries executed
- Connection events
- Error messages

**Example log:**
```
2025-10-27 23:00:00 UTC::@:[3306]:LOG: statement: INSERT INTO agent_actions...
```

**Problems:**
- ❌ Just text logs (need to parse)
- ❌ High volume (every query)
- ❌ Delayed (~1-2 minutes to CloudWatch)
- ❌ Expensive to parse/filter
- ❌ Not designed for application logic

**Verdict:** ❌ Wrong tool for the job

---

## Option 3: DMS (Database Migration Service) Change Data Capture

**What it does:**
- ✅ Captures INSERT/UPDATE/DELETE events
- ✅ Streams to Kinesis/S3/Redshift
- ✅ Real-time (few seconds delay)

**Architecture:**
```
PostgreSQL → DMS Replication Instance → Kinesis Stream → Lambda → WebSocket
```

**Pros:**
- ✅ Captures actual data changes
- ✅ Near real-time
- ✅ Managed service

**Cons:**
- ❌ Expensive (~$100/month for replication instance)
- ❌ Complex setup (DMS endpoint, tasks, mappings)
- ❌ Overkill for single database
- ❌ Requires public endpoint or VPC peering

**Verdict:** 💰 Works but expensive for this use case

---

## Option 4: PostgreSQL LISTEN/NOTIFY (Recommended)

**What it does:**
- ✅ Built-in PostgreSQL pub/sub
- ✅ Triggered by database events
- ✅ Instant (< 10ms)
- ✅ Free

**Architecture:**
```
PostgreSQL Trigger → NOTIFY → Node.js pg.Client → WebSocket → Browser
                    (instant)  (listens)          (broadcasts)
```

**Cost:** $0 (included in RDS)

**Code complexity:** Low

**Verdict:** ✅ Best option

---

## Option 5: Aurora PostgreSQL + Data API

**What it does:**
- Aurora-specific HTTP API for queries
- Can poll for changes via HTTP

**Pros:**
- ✅ Serverless-friendly
- ✅ No persistent connection needed

**Cons:**
- ❌ You're using RDS, not Aurora
- ❌ Still polling (not push-based)
- ❌ More expensive than RDS

**Verdict:** ❌ Not applicable (wrong DB)

---

## Option 6: CDC via Logical Replication (PostgreSQL native)

**What it does:**
- PostgreSQL built-in change data capture
- Creates replication slots
- Streams write-ahead log (WAL) changes

**Architecture:**
```
PostgreSQL WAL → Logical Replication Slot → Consumer App → WebSocket
```

**Setup:**
```sql
-- Enable logical replication
ALTER SYSTEM SET wal_level = logical;

-- Create replication slot
SELECT * FROM pg_create_logical_replication_slot('oriole_slot', 'pgoutput');

-- Consume changes (in Node.js)
const {LogicalReplicationService} = require('pg-logical-replication');
```

**Pros:**
- ✅ Native PostgreSQL feature
- ✅ Captures all changes
- ✅ Very low latency

**Cons:**
- ❌ Complex to set up
- ❌ Requires logical replication enabled (RDS parameter group change + reboot)
- ❌ Need to parse WAL format
- ❌ Replication slot can fill disk if consumer lags

**Verdict:** 🔧 Powerful but complex

---

## Comparison Table

| Method | Latency | Cost | Complexity | RDS Native |
|--------|---------|------|------------|------------|
| Enhanced Monitoring | N/A | Included | Low | ✅ Yes |
| Audit Logs | 1-2 min | Included | High | ✅ Yes |
| DMS CDC | 2-5 sec | ~$100/mo | Medium | ❌ No |
| LISTEN/NOTIFY | < 10ms | $0 | Low | ✅ Yes |
| Logical Replication | < 10ms | $0 | High | ✅ Yes |
| Polling | 2+ sec | $0 | Low | ✅ Yes |

---

## Recommended Solution for Oriole

### Best: PostgreSQL LISTEN/NOTIFY

**Why:**
- Native RDS PostgreSQL feature (no extra services)
- Instant notifications
- Simple to implement
- Zero cost
- Perfect for your use case (monitor experiment progress)

**Implementation:**
1. Create trigger on `agent_actions` table (5 minutes)
2. Node.js server with `pg` library (30 minutes)
3. WebSocket or SSE to browser (30 minutes)

**Total:** 1 hour to working prototype

### If LISTEN/NOTIFY doesn't work for you:

**Fallback: Simple Polling**
- Query every 2 seconds for new actions
- Much simpler than any "log stream" approach
- Good enough for non-critical real-time needs

```javascript
// Poll for updates
setInterval(async () => {
  const newActions = await db.query(`
    SELECT * FROM agent_actions
    WHERE experiment_id = $1 AND step_number > $2
    ORDER BY step_number
  `, [experimentId, lastStepSeen]);
  
  newActions.rows.forEach(action => {
    broadcast(action);
  });
}, 2000);
```

---

## Why NOT RDS Log Streams?

**RDS CloudWatch Logs are for:**
- Debugging SQL queries (slow query log)
- Auditing connections (who accessed DB)
- Troubleshooting errors (PostgreSQL error log)

**NOT for:**
- Application data changes
- Real-time event streaming
- Triggering application logic

**Analogy:**
- RDS logs = Security camera footage (for review/debugging)
- LISTEN/NOTIFY = Doorbell (instant notification of events)

You want the doorbell, not the camera footage!

---

## Quick Decision Tree

```
Do you need instant updates (< 100ms)?
├─ YES → Use LISTEN/NOTIFY
└─ NO → Is 2-5 second delay OK?
    ├─ YES → Use polling (simplest)
    └─ NO → Need subsecond but not instant?
        └─ Use DMS CDC (expensive) or Logical Replication (complex)
```

For your maze experiments:
- **< 1 second delay** is plenty fast
- **LISTEN/NOTIFY** is perfect ✅

---

## Next Steps

Want me to create:
1. ✅ PostgreSQL LISTEN/NOTIFY triggers
2. ✅ Node.js listener proof-of-concept
3. ✅ Simple polling alternative (if you want simpler)
