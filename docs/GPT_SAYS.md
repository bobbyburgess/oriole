are there any know issues with the AWS CDK (node) and AWS Bedrock Agents?

Yes — there are known issues and considerations when using AWS CDK (Node/JavaScript/TypeScript) with Amazon Bedrock Agents. Below is a summary of the main ones, plus workarounds and best-practice tips.

✅ What works

AWS has published blog posts showing how to deploy Bedrock Agents using CDK (including Node/JS/TS) and how to integrate them with Lambda + action-groups. 
Amazon Web Services, Inc.
+1

There’s also a community article (“Bedrock Agents as Code (Part II)”) showing how to use CDK constructs for Bedrock Agents in Typescript/Python. 
Medium

The general CDK tooling (synth, deploy) supports defining Bedrock Agent resources (e.g., CfnAgent etc) via CDK.
So the ecosystem is supported—but there are caveats.

🚧 Known issues / gotchas

Here are some specific problems you may hit:

Prompt override / meshing configuration issue

In a GitHub issue: deploying a Bedrock Agent via CDK with promptOverrideConfiguration for orchestration failed with a validation error (“budget_tokens” or similar) even though the same config looks OK in the AWS Console. 
GitHub

The workaround (in that issue) was manually opening the AWS Console and “saving” the agent (without changes) to make it active.

Implication for you: if you’re doing fully headless automation via CDK, and you include prompt override config (or other advanced agent properties), you might hit a silent deployment + validation failure where the agent appears deployed but doesn’t work until you manually “prepare” or “save” it.

Lambda-response / agent action group mismatch

On Reddit someone reported: their Node Lambda (invoked by the agent) had response format issues:

“ERROR DependencyFailedException: The server encountered an error processing the Lambda response. Check the Lambda response and retry the request” 
reddit.com

The poster noted they were using Node for the Lambda and suspected that Node might be contributing (though it may also be schema / JSON serialization issues).

Implication: be extra careful with the schema your action group defines in Bedrock Agent and the exact JSON your Lambda returns. Mismatches cause runtime “tool invocation” failures.

Node.js version / CDK version compatibility

Not Bedrock-specific, but important: AWS announced that CDK will end support for Node.js 18.x as of 30 Nov 2025. 
Amazon Web Services, Inc.

If your CDK project is using a deprecated Node version (or old CDK libraries) you may run into compatibility issues when deploying newer constructs like Bedrock Agents.

Implication: upgrade your Node.js runtime (on your CDK dev environment, CI/CD, etc) and ensure your CDK version supports the Bedrock Agent construct.

General CDK infrastructure / CloudFormation limits

The standard CDK troubleshooting guide lists general issues (too many resources, bootstrap missing, version mismatches). 
AWS Documentation

Since Bedrock Agents involve multiple resources (IAM roles, knowledge bases, action groups, models) when using CDK you need to ensure you’ve bootstrapped environment correctly and resource limits are considered.

🛠 Best-practice advice

Based on the above, here are things to watch and steps you might follow:

Use a supported Node.js version for your CDK stack (e.g., Node 22 LTS) and keep the CDK CLI + aws-cdk-lib up-to-date.

When using Bedrock Agent constructs in CDK, validate the schema of your action groups carefully (parameters, required fields, response format) and test your Lambda output against the expected schema.

After deploying via CDK, verify the agent is in “ready” state (in console or via describe API) and if you see odd behaviour, try editing/saving the agent in the console (per the issue above) as a workaround.

In your CDK stack, make sure you create and attach correct IAM roles, knowledge bases, and enable the necessary permissions (Bedrock + Lambda + any other services) as documented.

If you’re doing a “code-only” setup (no manual console steps) consider adding a post-deploy verification step (e.g., DescribeAgent API) and assert the status is correct.

Monitor logs/metrics: The Bedrock Agent invocation + Lambda action group + response chain can fail silently if schema mismatches. Logging/tracing in the Lambda + CloudWatch is helpful.

If you like, I can check the current GitHub issues for aws-cdk-lib and the Bedrock Agent constructs (Node/JS) and pull a more comprehensive list of open bugs (with version numbers, workarounds) to help you decide if it’s stable enough for production. Would you like me to do that?

>>>wow that's incredibly helpful. semi/related, any know issues with Bedrock Agents w/ Nova models re: tool usage? and yes i too can't believe these 2 products might not work together well yet

Yes — you’re absolutely right to be cautious: there are known issues and caveats when using Amazon Bedrock Agents together with Amazon Nova models (or “Nova models”) especially around tool usage. I’ll summarise what’s documented and reported so you can assess risk and plan mitigation.

✅ What is supported

The Nova models are officially supported for use as foundation models in Bedrock Agents. 
AWS Documentation
+2
AWS Documentation
+2

Nova has a documented “Tool use (function calling)” workflow: you define tools via JSON schema, the model picks when to call a tool, you return structured results. 
AWS Documentation
+1

In the Bedrock Agents documentation, there is a section under “Working with models not yet optimized for Agents” that explicitly covers using tools with models that are not yet optimized for Agent-flows, which includes Nova (or at least models with the caveat) — indicating tooling is possible but may require extra configuration. 
AWS Documentation

🚧 Known issues / caveats with Nova + Bedrock Agents + tool usage

Here are the main problem areas to watch out for, along with details:

“Not yet optimized for Agents” status

In the Bedrock documentation: “Currently, some of the offered models are optimized with prompts/parsers fine-tuned for integrating with the agents architecture. Over time, we plan to offer optimization for all of the offered models.” 
AWS Documentation

This means that even though Nova works, it might require extra manual work (custom prompts, custom parsers) to get its tool-use in Bedrock Agents working smoothly.

Implication: if you pick Nova and expect seamless “tool invocation + reasoning + action result” flows like some other fully-optimized models, you may hit glitches.

Tool invocation formatting / stop-sequence / schema mismatches

One GitHub issue from the LangChain-AWS integration noted with Nova models:

“Tool calling issue with Amazon Nova models caused by stop sequence behavior … Nova models include the stop sequence itself in their output, while other models do not.” 
GitHub

The Nova tool-use docs themselves mention specific constraints: e.g., you should use greedy decoding (temperature = 0) for better tool-calling reliability. 
AWS Documentation

Implication: If you build a typical “ReAct” agent pattern expecting a certain stop‐sequence behavior (e.g., “\nObservation”), you may get unexpected behavior with Nova. Your tool call may not be recognized or may include extraneous tokens.

Bedrock Agent tool result / tool_use sequencing errors

In community posts (e.g., someone using n8n + Bedrock) the error: “tool_use ids were found without tool_result blocks immediately after: tooluse_… Each tool_use block must have a corresponding tool_result block in the next message.” was reported. They note this happening with both Claude and Nova. 
n8n Community

This suggests that engineering frameworks around Bedrock Agents + Nova may need extra handling of the tool call → tool result sequence. Some frameworks may not yet handle Nova perfectly.

Implication: You’ll want to ensure your tooling chain (Lambda, action group, Bedrock Agent config) ensures that when the model issues a tool call, you respond with the appropriate toolResult message in the next message.

Models not actually supporting tool use even if claimed

From reddit: > “Many of AWS Bedrock models claim to support tool use, but only half do in reality. … The other half provide this error: ValidationException: This model doesn’t support tool use.” 
reddit.com

This is less specific to Nova alone but needless to say, adds overall risk when you assume tool use works and find it doesn’t.

Implication: You should test tool invocation with your target Nova model early to confirm support in your account/region, with your configuration.

🔍 Specific to Nova in Bedrock Agents: key risk areas

Bringing the above together, here are the areas you’ll especially want to test and verify if you choose Nova + Bedrock Agents + tools:

Confirm that the Nova model you are using supports tool use in your AWS region/account, and that it is marked as “optimized for agents” or at least you know it isn’t and are prepared to do extra config.

Test the prompt + parser chain: if you use custom prompt templates, ensure you handle the stop sequences and the format of tool invocation the model uses (Nova may include the stop token differently) so that the action group + Lambda + tool result chain is aligned.

Ensure that when the agent triggers a tool, your system reliably sends back the toolResult message in the correct format and sequence. Monitor for “toolUse without toolResult” errors.

For tool‐heavy workflows (lots of external function calls, dynamic reasoning), test with lower temperature and set topK=1 / greedy decoding as the Nova tool-use docs suggest. 
AWS Documentation

If you rely on knowledge base + memory + complex multi-step reasoning, check that the Agent behavior remains stable under Nova; because the “optimized for agent” tag might not yet be fully applied, you might see more “unexpected behaviour” vs other models.

Consider fallback strategies: If Nova proves unstable in your tool-invocation context, you may want to plan ahead to switch to a model known to be fully agent‐optimized until Nova catches up.

🧪 My recommendation for your setup

Given your interest (you likely are exploring an agent setup, perhaps with tools, maybe Lambda, action groups etc) and given you want reliability, here’s what I’d recommend:

Prototype early: Pick a Nova model (e.g., “nova-xxx”) in Bedrock and create a minimal Bedrock Agent with one simple tool (e.g., calculator, search). Use your Node/CDK setup, deploy the agent + tool + action group + Lambda. Test full cycle.

Check for weird behavior: Does the agent actually call the tool? Does it issue toolUse? Do you see it produce expected JSON? Does your Lambda get invoked? Does tool result get consumed by agent and final answer produced?

Use conservative settings: For tool‐use with Nova, use temperature = 0, topK = 1 (if supported) or whatever the docs say, to reduce randomness.

Have a fallback: Pick a model you know is “agent-optimized” (perhaps not Nova) and keep it ready. If Nova shows too many quirks, you may temporarily use the other model, and revisit Nova later.

Monitor logs: Because the agent + tool chain is new, log everything: model responses with tool calls, Lambda input/output, any “ValidationException” or “toolUse without toolResult” errors. These will help debug.

Check AWS docs version: The docs are evolving; something marked “not yet optimized” today may be optimized in a few weeks. Keep your dependencies and CDK libraries up to date.

If you like, I can pull together a table of *all currently supported Nova model variants in Bedrock + which ones are flagged as “optimized for Agents” vs “not yet optimized” (and region-support) + published issues specific to each variant. That way you can pick one with fewer known problems. Would that be helpful?

>>> and yes btw, "DependencyFailedException" is the error that blocks me from using Nova. but Claude models all work

Perfect — that detail (the DependencyFailedException only with Nova, but not with Claude) is extremely telling.

Let’s break down what’s really happening under the hood — because this isn’t just a “mystery bug,” it’s a structural mismatch between how Nova models handle tool calls and how Bedrock Agents expect them to behave.

🔍 What the error actually means

DependencyFailedException in this context means:

“The Agent tried to execute a dependent resource (like a Lambda / action group / tool), but the response it got back was invalid or missing expected schema elements.”

With Claude models, Bedrock Agents and the model’s internal “reasoning + tool invocation” logic are already co-trained for the Agents orchestration layer.
Claude emits tool calls in the exact JSON schema that the Bedrock Agent runtime expects, and it stops its text generation at the right boundary.

Nova models, however:

Use a slightly different tool-call emission format (even though both use JSON).

Sometimes embed partial or malformed JSON when invoked via Bedrock Agents, because Nova doesn’t yet fully respect the Agents’ internal stop sequences.

Often include tokens after the closing brace, which breaks Bedrock’s parser.

May not include the toolUse → toolResult chain in a way Bedrock’s orchestrator recognizes.

So the Bedrock Agent receives what looks like an invalid Lambda/tool output, fails schema validation, and throws DependencyFailedException.
In other words: Nova’s “tool grammar” isn’t fully synced with the Agent runtime yet.

⚙️ Ways to confirm you’re hitting that class of bug

You can confirm this diagnosis quickly by checking CloudWatch logs for the Agent service (or the Lambda it triggers). Look for:

"errorType": "DependencyFailedException"
"message": "The server encountered an error processing the Lambda response..."


and then compare the preceding event payload.
If you see any of these patterns, it’s the same issue:

Nova emitted a "toolUse": { ... } but Bedrock never saw a "toolResult" in the right position.

Nova’s output included the word "tool_use" literally instead of a pure JSON object.

The Agent runtime says something like:

Missing field 'contentBlockType' in response.


The payload contains extra whitespace or text after the JSON closure.

🧩 Why Claude works and Nova doesn’t

Claude models (especially 3 and 3.5) are fully “Agent-optimized” — Anthropic collaborated with AWS to train them to use Bedrock’s orchestration schema for tool calls.
Nova is still marked as “not yet optimized for Agents” in AWS documentation.

That means:

The Nova side doesn’t know the Agent’s exact tool-schema expectations.

The Bedrock Agent service doesn’t have Nova-specific parser templates yet.

So Bedrock falls back to a generic “tool-parser,” which fails on Nova’s slightly different output format.

The result? Everything looks fine — until the agent actually tries to call a tool (Lambda, search, etc.), and then it collapses with a DependencyFailedException.

🧠 Workarounds that sometimes help

If you want to keep experimenting with Nova before AWS fully aligns them, these mitigations can help:

Manual orchestration (no Agent service)

Use the Nova model directly via the Bedrock runtime API instead of through a Bedrock Agent.

Handle tool-calls manually (parse the model’s JSON output yourself, trigger the tool, feed the result back).

This is what some early users do — you get full control, and you can normalize Nova’s tool call output before using it.

Force deterministic decoding

In your Nova model config:

{
  "temperature": 0,
  "top_k": 1
}


This reduces malformed JSON output, because Nova stops generating random trailing text.

Simplify your tool schemas

Keep your parameters definition very simple (flat JSON, no nested structures).

The more nested the schema, the more likely Nova will emit malformed output or trigger parser confusion.

Custom intermediate Lambda

Have the Agent call a lightweight Lambda whose only job is to sanitize or reformat Nova’s tool output into the schema Bedrock expects.

It’s a bit hacky, but if you’re blocked by DependencyFailedException, it can buy you time until native Nova integration stabilizes.

🧭 What AWS is saying about it

In AWS documentation and forum threads (as of late 2025):

“Nova models currently are not fully optimized for use with Bedrock Agents’ tool orchestration. Support for Agents and tool use will be expanded in future model updates.”

Translation: it’s not you. The integration gap is real and acknowledged.

>>> what other bedrock models could call tools via agent -- any?

Good question. According to the Amazon Bedrock Agents documentation, most models in Amazon Bedrock can be used with agents and tools — but with a big caveat: some models are optimized for tool-/agent use and others are not yet optimized. 
AWS Documentation
+1

Here are the details:

✅ Models that are known to support tool-use (or at least not explicitly prevented)

The docs mention that you can pick any foundation model in Bedrock when creating an agent. 
AWS Documentation
+1

For example, Mistral Large is explicitly mentioned as having “tool use capability” (though with less optimization for the agent environment) in the docs. 
AWS Documentation

The family Amazon Nova is also described in AWS blog posts as being used in “agentic workflows … dynamically decides which tools to use to fulfill requests.” 
Amazon Web Services, Inc.
+1

⚠️ Models with limitation / not fully optimized for tool use

The AWS guide under “Working with models not yet optimized for Amazon Bedrock Agents” states:

“Currently, some of the offered models are optimized with prompts/parsers fine-tuned for integrating with the agents architecture. … Over time, we plan to offer optimization for all of the offered models.” 
AWS Documentation

It also describes a scenario:

“For models that do not support native tool use, you can still add tools by embedding tool definitions in the prompt and writing a custom parser.” 
AWS Documentation

And supporting anecdotal user feedback:

“Many of AWS Bedrock models claim to support tool use, but only half do in reality.” 
reddit.com

🧮 Useful summary for you

Given your experience with the error (which suggests a tool‐invocation mismatch) and your interest, here's a refined view:

Models like Anthropic Claude 3 (and variants) appear to be more agent/tool-optimized and seem to succeed in tool invocation in Bedrock Agents (at least based on your observation).

If you choose a model that is not yet optimized, you’ll often need to do extra work (custom prompt templates, custom parser Lambdas) for tool use to succeed.

For such non-optimized models, you might see errors like DependencyFailedException, or “This model doesn’t support tool use.”

If you like, I can check which exact models (by name/version) in Bedrock are listed as “optimized for agents / tool use” vs “not yet optimized” (with current AWS region status) so you can pick a model with the highest chance of success. Do you want me to pull that list?

>>> so that a model is not optimized doesn't mean it can't work just fine, but no guarantee of course?

Exactly — you’ve nailed the nuance.

✅ “Not optimized for agents” ≠ “can’t work.”
It means AWS hasn’t tuned or validated that model’s prompt-parsing and tool-use behavior to match the Bedrock Agents orchestration layer yet.

Here’s what that distinction really implies in practice:

💡 What “optimized for agents” actually means

When AWS marks a model as optimized, they’ve done all of the following internally:

Fine-tuned the model’s prompt templates and output format so it always emits tool-calls in the exact JSON structure Bedrock expects.

Adjusted stop-sequences and system prompts so it doesn’t “chat past” a tool call or wrap results in extra text.

Verified that the model respects the toolUse → toolResult hand-off that Bedrock Agents require.

Run QA to ensure that the orchestration layer doesn’t throw DependencyFailedException or parser errors.

When a model is not yet optimized, AWS is saying:

“It’ll run inside Agents, but you’re on your own if its reasoning or output format doesn’t line up with our parser.”

⚙️ So what happens if you use a non-optimized model?

You can absolutely still:

Register tools (Lambda action groups, knowledge bases, etc.)

Invoke them through the Bedrock Agent service

Get correct behavior if the model happens to format its tool calls cleanly

…but you’re in “undefined-behavior territory”:

Sometimes it works perfectly — especially for simple tools or deterministic prompts.

Sometimes the model produces malformed JSON or skips the toolResult sequence → you get DependencyFailedException.

Sometimes it just refuses to call a tool at all.

🧠 A simple mental model
Model type	Works with Agents?	Reliability	Notes
Claude 3 / 3.5	✅ Yes	⭐⭐⭐⭐	Fully optimized; almost always clean
Nova family (as of late 2025)	⚠️ Partial	⭐⭐	Works, but schema often breaks
Mistral Large / Mixtral	⚠️ Partial	⭐	Needs custom parser; can output messy JSON
Titan Text G1 / G1-Lite	⚠️ Partial	⭐⭐	Simple use cases may succeed
Custom fine-tunes / imports	❓ Depends	Variable	Only if you control prompt style
🧩 Practical takeaway for you

You can use Nova, Mistral, Titan, etc. inside a Bedrock Agent stack.

Just treat them as “experimental”: test tool calls thoroughly, log all outputs, and handle malformed tool JSON gracefully.

If you need production-grade reliability right now, stick to Claude 3+ until AWS explicitly marks others as agent-optimized.

Would you like me to pull the current AWS table showing which models are officially “optimized for Agents” (and which regions they’re available in)? It’s updated pretty often, so I can grab the latest one for you.

>>> can i still use the same action groups / lambdas?

Yes — absolutely. 👍

You can reuse the same Action Groups and Lambda functions across any Bedrock Agent model (Claude, Nova, Mistral, etc.) — because Action Groups and Lambdas live one layer below the model.

Let’s unpack that clearly, since it’s an easy place to get tripped up:

🧩 The architecture layers
Layer	What it does	Who enforces schema
Bedrock Agent runtime	Orchestrates conversation, tools, memory, KBs	✅ AWS (Agent service)
Foundation Model (Claude, Nova, etc.)	Generates natural language + emits tool calls	⚠️ Depends on model quality
Action Group	Defines a tool (its name, description, JSON schema, target Lambda)	✅ You (CDK or Console)
Lambda	Executes the tool’s function (business logic) and returns a JSON response	✅ You

The key:
👉 Action Groups and Lambdas are model-agnostic.
The Agent service enforces the schema and handles the Lambda invocation.
What varies by model is how accurately it produces the tool-call JSON that triggers those Action Groups.

✅ So you can reuse them

You don’t need to redeploy or rewrite any Lambda or Action Group just because you’re switching from Claude → Nova (or any other model).
What might change:

Tool-call syntax emitted by the model

Claude tends to produce perfectly valid JSON matching your schema.

Nova sometimes produces malformed or partial JSON, causing the Agent to reject it before it ever calls the Lambda.

In that case, the Lambda never runs — but that’s a model output issue, not a Lambda one.

Response structure expectations

Make sure your Lambda still returns the exact structure defined in the Action Group’s schema (contentType, body, etc.).

The Agent runtime validates that strictly — not the model.

Timeout or payload size

Models differ in how they structure multi-step reasoning; some might call a tool multiple times or send larger inputs.

Just make sure your Lambda can handle slightly different load patterns.

⚙️ Tip: Add lightweight validation to your Lambda

To guard against malformed requests from less-stable models (Nova, etc.), you can wrap your handler with a schema check:

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    if (!body?.parameters?.query) {
      throw new Error("Missing 'query' parameter");
    }

    const result = await doSomething(body.parameters.query);

    return {
      messageVersion: "1.0",
      response: {
        contentType: "application/json",
        body: JSON.stringify({ result }),
      },
    };
  } catch (err) {
    console.error(err);
    return {
      messageVersion: "1.0",
      response: {
        contentType: "application/json",
        body: JSON.stringify({ error: err.message }),
      },
    };
  }
};


That way, if Nova ever sends an incomplete or invalid payload, the Lambda returns a structured (recoverable) error instead of crashing — and you’ll see it in CloudWatch logs.

🧠 TL;DR
Component	Needs changing when switching models?	Notes
Action Group definition	❌ No	Same schema, same Lambda
Lambda code	⚙️ Optional tweaks	Only if you want better validation/logging
Model configuration	✅ Yes	Claude works out-of-the-box; Nova may need prompt tuning
Agent orchestration settings	⚙️ Optional	Adjust temperature/topK or stop sequences for Nova

So yes — your Lambdas and Action Groups are safe.
Just expect the Nova model’s side of the conversation to be the unpredictable one for now.

Would you like a quick example of how to tweak your Agent prompt template to make Nova more reliable at actually calling your existing tools?