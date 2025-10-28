# Ollama Load Balancing Across Multiple Machines

## The Question

Can we load balance inference across 2 local machines (as long as they have the same config and transactions are kept in order)?

## The Key Constraint

**Turn-level consistency is required.** Within a single turn, the agent can make up to 8 Ollama calls (configured by `maxActionsPerTurn`). These calls build up a stateful `messages` array that must remain consistent:

```javascript
// lambda/orchestration/invoke-agent-ollama.js:266-358
const messages = [
  { role: 'user', content: systemMessage }
];

while (actionCount < maxActions) {
  const response = await callOllamaChat(endpoint, modelName, messages, ...);
  messages.push(assistantMessage);  // Stateful array
  messages.push({ role: 'tool', content: JSON.stringify(result) });
}
```

This means **all calls within a single turn MUST go to the same Ollama instance** (the one that has the conversation context in memory).

## Load Balancing Approaches

However, **different experiments can go to different Ollama instances** since each experiment maintains its own independent conversation state.

### Experiment-Level Routing (Recommended)

Route entire experiments to specific machines using a simple hash:

```javascript
// In invoke-agent-ollama.js
const OLLAMA_ENDPOINTS = [
  'http://192.168.1.100:11434',  // Machine 1
  'http://192.168.1.101:11434'   // Machine 2
];

// Hash experimentId to determine which machine handles this experiment
const endpoint = OLLAMA_ENDPOINTS[experimentId % OLLAMA_ENDPOINTS.length];
```

### Benefits

- **Simple implementation**: One-line hash for routing
- **No turn-level complexity**: Each experiment stays on its assigned machine
- **2x throughput**: Parameter sweep goes from 3.75 hours → ~2 hours
- **No state synchronization needed**: Experiments are independent

### For Parameter Sweep

With 12 experiments and 2 machines:
- Machine 1: experiments 1, 3, 5, 7, 9, 11 (6 experiments)
- Machine 2: experiments 2, 4, 6, 8, 10, 12 (6 experiments)

Instead of running sequentially with 180s delays:
- Sequential: 12 × 16min + 11 × 3min = 225 minutes (~3.75 hours)
- Parallel with 2 machines: 6 × 16min + 5 × 3min = 111 minutes (~1.85 hours)

## Implementation

1. **Update Lambda environment**: Add comma-separated list of Ollama endpoints
2. **Modify invoke-agent-ollama.js**: Parse endpoints and use hash-based routing
3. **Parameter Store stays the same**: Both machines read same configs (which is correct for parallel experiments)
4. **Remove shell script delays**: No longer need 180s isolation delays since experiments run in parallel

## Alternative: Shell Script Parallelization

Even simpler approach - just launch experiments in parallel from the shell script:

```bash
# Launch 6 experiments on machine 1 in background
for exp in A1 A3 B1 B3 B5 C2; do
  run_experiment "$exp" ... &
done

# Launch 6 experiments on machine 2 in background
for exp in A2 B2 B4 B6 C1 C3; do
  run_experiment "$exp" ... &
done

wait  # Wait for all background jobs to complete
```

This doesn't require any Lambda changes - just triggers experiments in parallel and lets Step Functions handle the queueing.
