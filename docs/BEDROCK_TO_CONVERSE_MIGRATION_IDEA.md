# Bedrock Agents → Converse API Migration Idea

## Executive Summary

**Problem:** Bedrock Agents provide little value for our use case while limiting control over:
- Tool call limits per turn
- Rate limiting between tool calls
- Orchestration transparency
- Debugging visibility

**Solution:** Replace Bedrock Agents with direct Bedrock Converse API calls, giving us the same control we have with Ollama but for AWS-hosted models.

## What Is Bedrock Converse API?

Bedrock Converse is a **unified API** for calling any model on AWS Bedrock with a consistent interface. Think of it as AWS's version of OpenAI's Chat Completions API, but it works across multiple providers.

### Supported Models

**Anthropic:**
- Claude 3 Haiku
- Claude 3 Sonnet
- Claude 3.5 Sonnet
- Claude 3 Opus
- Claude 3.7 Sonnet (latest)

**Amazon Nova (NEW):**
- Nova Micro
- Nova Lite
- Nova Pro
- Nova Premier

**Meta:**
- Llama 3.1 (8B, 70B, 405B)
- Llama 3.2 (1B, 3B, 11B, 90B)
- Llama 3.3 (70B)

**Mistral AI:**
- Mistral 7B
- Mistral Large
- Mixtral 8x7B

**Cohere:**
- Command R
- Command R+

**AI21 Labs:**
- Jamba 1.5 Large
- Jamba 1.5 Mini

### What Converse Does NOT Support

❌ **OpenAI models** - Not available on Bedrock
- GPT-4, GPT-3.5, etc. are OpenAI-exclusive
- Would need separate OpenAI SDK integration

❌ **Google Gemini models** - Not available on Bedrock
- Gemini Pro, Gemini Flash are Google Cloud only
- Would need separate Google Vertex AI integration

❌ **Local Ollama models** - Not on AWS
- Already handled by our `invoke-agent-ollama.js`

## Current Architecture

```
┌─────────────────────────────────────────────────┐
│  Bedrock Path (Agents)                          │
├─────────────────────────────────────────────────┤
│  1. invoke-agent.js                             │
│     - InvokeAgentCommand                        │
│     - AWS controls orchestration (opaque)       │
│     - No control over tool call limits          │
│     - Hard to debug (trace events)              │
│     - Extra cost (agent fees on top of model)   │
│                                                  │
│  2. action-router.js (Lambda)                   │
│     - Called by Bedrock Agent                   │
│     - Executes tools                            │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│  Ollama Path (Direct)                           │
├─────────────────────────────────────────────────┤
│  1. invoke-agent-ollama.js                      │
│     - Manual orchestration loop                 │
│     - Full control (maxActionsPerTurn)          │
│     - Rate limiting between tools               │
│     - Clear logging                             │
│     - Direct model costs only                   │
│                                                  │
│  2. action-router.js (Lambda)                   │
│     - Called by our code                        │
│     - Executes tools                            │
└─────────────────────────────────────────────────┘
```

## Proposed Architecture

```
┌─────────────────────────────────────────────────┐
│  Bedrock Path (Converse API)                    │
├─────────────────────────────────────────────────┤
│  1. invoke-agent-converse.js (NEW)              │
│     - ConverseCommand                           │
│     - WE control orchestration (transparent)    │
│     - Control tool call limits                  │
│     - Easy to debug (direct responses)          │
│     - Model costs only (no agent fees)          │
│                                                  │
│  2. action-router.js (Lambda)                   │
│     - Called by our code                        │
│     - Executes tools                            │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│  Ollama Path (Direct)                           │
├─────────────────────────────────────────────────┤
│  (Unchanged - already optimal)                  │
└─────────────────────────────────────────────────┘
```

**Key Insight:** Both paths would now have identical orchestration logic, just different API clients.

## Feature Comparison

| Feature | Bedrock Agent | Converse API | Ollama (Current) |
|---------|---------------|--------------|------------------|
| **Orchestration Control** | ❌ AWS controls | ✅ You control | ✅ You control |
| **Tool Call Limits** | ❌ No control | ✅ maxActionsPerTurn | ✅ maxActionsPerTurn |
| **Per-Tool Rate Limiting** | ❌ Impossible | ✅ Add sleep() | ✅ Could add easily |
| **Debugging** | ⚠️ Trace events (complex) | ✅ Direct response | ✅ Direct response |
| **Cost** | 💰 Model + Agent fees | 💰 Model only | 💰 Model only |
| **Setup** | ⚠️ Console + IaC | ✅ Code only | ✅ Code only |
| **Infrastructure** | ✅ AWS managed | ✅ AWS managed | ❌ DIY |
| **Reliability** | ✅ AWS SLA | ✅ AWS SLA | ⚠️ Your hardware |
| **Available Models** | ⚠️ Agent-compatible only | ✅ All Bedrock models | ✅ Any Ollama model |
| **Token/Cost Tracking** | ⚠️ Via trace events | ✅ Direct in response | ✅ Direct in response |
| **Error Handling** | ⚠️ Opaque failures | ✅ Clear errors | ✅ Clear errors |
| **Reproducibility** | ⚠️ Hard (opaque decisions) | ✅ Easy (explicit) | ✅ Easy (explicit) |

## Code Comparison

### Current: Bedrock Agent (invoke-agent.js)

```javascript
// Opaque - AWS controls everything
const command = new InvokeAgentCommand({
  agentId,
  agentAliasId,
  sessionId,
  inputText: prompt,
  enableTrace: true
});

const response = await bedrockClient.send(command);

// Process complex streaming response with trace events
for await (const event of response.completion) {
  if (event.chunk?.bytes) {
    // Extract text from bytes
  }
  if (event.trace) {
    // Parse trace for token counts
  }
}
```

**Problems:**
- Can't control how many tools it calls
- Can't add delays between tools
- Trace parsing is complex
- Black box decision making

### Proposed: Converse API (invoke-agent-converse.js)

```javascript
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

async function invokeWithTools(modelId, systemPrompt, messages, tools, config) {
  const maxActions = config.maxActionsPerTurn || 50;
  let actionCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Add system message
  const conversationMessages = [{
    role: 'user',
    content: [{ text: systemPrompt }]
  }, ...messages];

  while (actionCount < maxActions) {
    const response = await bedrockRuntime.send(new ConverseCommand({
      modelId: "anthropic.claude-3-haiku-20240307-v1:0",
      messages: conversationMessages,
      toolConfig: { tools },
      inferenceConfig: {
        temperature: config.temperature,
        maxTokens: config.maxOutputTokens
      }
    }));

    // Track tokens
    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;

    // Check stop reason
    if (response.stopReason === 'end_turn') {
      break; // Agent is done
    }

    // Process tool calls
    const toolUses = response.output.message.content.filter(c => c.toolUse);
    if (toolUses.length === 0) break;

    conversationMessages.push({
      role: 'assistant',
      content: response.output.message.content
    });

    const toolResults = [];
    for (const toolUse of toolUses) {
      // Execute tool via Lambda (same as Ollama path)
      const result = await executeToolViaLambda(
        toolUse.toolUseId,
        toolUse.name,
        toolUse.input
      );

      toolResults.push({
        toolResult: {
          toolUseId: toolUse.toolUseId,
          content: [{ json: result }]
        }
      });

      actionCount++;

      // RATE LIMITING - can't do this with Agents!
      if (config.rateLimitMs) {
        await sleep(config.rateLimitMs);
      }

      // TOOL CALL LIMIT - can't do this with Agents!
      if (actionCount >= maxActions) {
        console.log(`Hit max actions (${maxActions}), stopping turn`);
        break;
      }
    }

    conversationMessages.push({
      role: 'user',
      content: toolResults
    });
  }

  return {
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    actionCount
  };
}
```

**Benefits:**
- ✅ Explicit control over tool call limits
- ✅ Can add rate limiting between tools
- ✅ Clear token tracking
- ✅ Transparent decision flow
- ✅ Same orchestration pattern as Ollama

### Current: Ollama (invoke-agent-ollama.js)

```javascript
// Already has good control!
while (actionCount < maxActions) {
  const response = await callOllamaChat(endpoint, modelName, messages, tools, options);

  if (!response.message.tool_calls) break;

  for (const toolCall of response.message.tool_calls) {
    const result = await executeAction(toolCall);
    messages.push({
      role: 'tool',
      content: JSON.stringify(result)
    });
    actionCount++;
  }
}
```

**Already Perfect:** This is the pattern we want everywhere.

## What About OpenAI and Google?

### OpenAI (Not on Bedrock)

**OpenAI has its own API:**
```javascript
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Nearly identical orchestration to Converse!
const response = await openai.chat.completions.create({
  model: "gpt-4-turbo",
  messages: [...],
  tools: [...],
  temperature: 0.2
});
```

**Integration Strategy:**
1. Create `invoke-agent-openai.js` with same orchestration pattern
2. Add OpenAI API key to Parameter Store
3. Update trigger scripts to detect OpenAI models
4. Use `llmProvider: 'openai'` in event routing

**Cost:** OpenAI charges per token (no agent fees), similar to Converse.

### Google Gemini (Not on Bedrock)

**Google has Vertex AI API:**
```javascript
const { VertexAI } = require('@google-cloud/vertexai');

const vertexAI = new VertexAI({
  project: 'your-project',
  location: 'us-central1'
});

const model = vertexAI.preview.getGenerativeModel({
  model: 'gemini-1.5-pro',
  tools: [...]
});

// Similar orchestration pattern
const response = await model.generateContent({
  contents: messages
});
```

**Integration Strategy:**
1. Create `invoke-agent-gemini.js` with same orchestration pattern
2. Set up Google Cloud credentials
3. Update trigger scripts to detect Gemini models
4. Use `llmProvider: 'gemini'` in event routing

**Cost:** Google charges per token (no agent fees).

## Unified Architecture Vision

```
┌─────────────────────────────────────────────────────────────────┐
│  Step Functions: Experiment Runner                              │
│  (Orchestrates turns, not tool calls within turn)               │
└─────────────────┬───────────────────────────────────────────────┘
                  │
    ┌─────────────▼──────────────┐
    │  AgentProviderRouter       │
    │  (Choice state based on    │
    │   llmProvider field)        │
    └─────────────┬──────────────┘
                  │
      ┌───────────┴────────────┬──────────────┬──────────────┬──────────────┐
      │                        │              │              │              │
┌─────▼─────┐          ┌──────▼──────┐ ┌────▼──────┐ ┌────▼──────┐ ┌────▼──────┐
│  Ollama   │          │  Converse   │ │  OpenAI   │ │  Gemini   │ │ (Future)  │
│  Lambda   │          │  Lambda     │ │  Lambda   │ │  Lambda   │ │  ...      │
│           │          │             │ │           │ │           │ │           │
│ Local     │          │ AWS Bedrock │ │ OpenAI    │ │ Google    │ │ Groq?     │
│ Models    │          │ Models      │ │ API       │ │ Vertex AI │ │ Together? │
└───────────┘          └─────────────┘ └───────────┘ └───────────┘ └───────────┘
     │                        │              │              │              │
     └────────────────────────┴──────────────┴──────────────┴──────────────┘
                              │
                      ┌───────▼────────┐
                      │  action-router │
                      │  (Tool executor)│
                      └────────────────┘
```

**All Lambda functions share:**
- Same orchestration pattern
- Same tool execution (action-router)
- Same config format (maxContextWindow, temperature, etc.)
- Same rate limiting approach
- Same token tracking

**Only difference:** API client (Ollama, Bedrock, OpenAI, Google)

## Migration Path

### Phase 1: Create Converse Lambda (Parallel)
1. Create `invoke-agent-converse.js`
2. Deploy alongside existing `invoke-agent.js`
3. Add new provider: `llmProvider: 'bedrock-converse'`
4. Test with one model (e.g., Haiku)

### Phase 2: Run A/B Comparison
1. Run same experiment with both:
   - Bedrock Agent (current)
   - Bedrock Converse (new)
2. Compare:
   - Token usage
   - Tool call patterns
   - Cost
   - Performance
   - Debugging ease

### Phase 3: Migrate Fully
1. Update trigger scripts to use `bedrock-converse` by default
2. Keep Agent path for backward compatibility
3. Eventually deprecate Agent path

### Phase 4: Add More Providers (Optional)
1. Add OpenAI support (`invoke-agent-openai.js`)
2. Add Gemini support (`invoke-agent-gemini.js`)
3. Add other providers as needed

## Implementation Estimate

**Converse Lambda:** ~150 lines of code
- Copy orchestration pattern from `invoke-agent-ollama.js`
- Replace Ollama API calls with Bedrock Converse
- Handle Bedrock-specific response format
- Add to Step Functions state machine

**Testing:** ~2 hours
- Run parallel experiments
- Verify tool execution
- Check token tracking
- Compare costs

**Total Effort:** ~1 day of work

## Benefits Summary

### Immediate Benefits (Converse)
- ✅ Control tool call limits per turn
- ✅ Add rate limiting between tools
- ✅ Simpler debugging (direct responses)
- ✅ Lower cost (no agent fees)
- ✅ Infrastructure as code (no console)
- ✅ Better reproducibility

### Future Benefits (Multi-Provider)
- ✅ Compare models across providers easily
- ✅ Use best model for each task
- ✅ Avoid vendor lock-in
- ✅ Leverage OpenAI/Anthropic/Google competition
- ✅ Access latest models quickly

### Research Benefits
- ✅ Fair A/B testing (same orchestration)
- ✅ Reproducible experiments
- ✅ Cost transparency
- ✅ Debugging transparency

## Risks & Considerations

### Potential Risks
1. **More code to maintain** - We own orchestration
   - *Mitigation:* Shared pattern across all providers

2. **AWS might improve Agents** - Better control in future
   - *Mitigation:* Keep Agent path, use Converse as primary

3. **Different response formats** - Each provider varies
   - *Mitigation:* Abstraction layer normalizes responses

### Non-Risks
- ❌ "Bedrock is more reliable" - Converse uses same infrastructure
- ❌ "Agents optimize better" - No evidence, likely identical
- ❌ "More expensive" - Actually cheaper (no agent fees)

## Recommendation

**YES - Migrate to Converse API**

Bedrock Agents provide minimal value for this research platform while limiting control needed for reproducible experiments. The migration is low-risk, low-effort, and high-reward.

**Next Steps:**
1. Review this document
2. Decide on timeline
3. Create `invoke-agent-converse.js`
4. Run parallel A/B test
5. Migrate fully

**Future Expansion:**
Once Converse works well, adding OpenAI/Gemini support becomes trivial since the orchestration pattern is identical.

## Additional Resources

- [AWS Bedrock Converse API Docs](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)
- [Anthropic Tool Use Guide](https://docs.anthropic.com/en/docs/tool-use)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [Google Vertex AI Function Calling](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/function-calling)
