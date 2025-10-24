# Migration to CDK Inline Action Groups

**Date:** 2025-10-24
**CDK Version:** 2.220.0+

## What Changed

Bedrock Agent action groups are now fully managed by CDK, eliminating all manual configuration steps.

## Before (Manual Configuration)

```bash
# Deploy CDK stack
npm run deploy

# THEN manually configure action groups via CLI
./scripts/setup-agent-actions.sh <agent-id> <lambda-arn>

# THEN manually create versions and update aliases
aws bedrock-agent create-agent-alias --agent-id ... --agent-alias-name temp
aws bedrock-agent update-agent-alias --agent-id ... --routing-configuration agentVersion=2
```

**Problems:**
- ❌ Multi-step deployment process
- ❌ Configuration drift between CDK and runtime state
- ❌ Manual steps error-prone and undocumented
- ❌ Action groups not in version control

## After (CDK Inline Action Groups)

```bash
# Single command deploys everything
npm run deploy
```

**Benefits:**
- ✅ One-command deployment
- ✅ Zero manual steps
- ✅ Action groups in version control (`lib/action-group-schema.js`)
- ✅ No configuration drift
- ✅ Repeatable and auditable

## Technical Implementation

### 1. Action Group Schema Extracted

**New file:** `lib/action-group-schema.js`

Contains the OpenAPI 3.0 schema defining all agent tools:
- move_north, move_south, move_east, move_west
- recall_all

### 2. Inline Action Groups in CDK

**Updated:** `lib/bedrock-agent-construct.js`

```javascript
const agent = new bedrock.CfnAgent(this, 'Agent', {
  // ... other props
  actionGroups: [
    {
      actionGroupName: 'oriole-maze-navigation',
      actionGroupExecutor: {
        lambda: actionLambda.functionArn
      },
      apiSchema: {
        payload: JSON.stringify(MAZE_NAVIGATION_SCHEMA)
      },
      actionGroupState: 'ENABLED'
    }
  ]
});
```

### 3. Lambda Resource Policy Permissions

**Critical addition:**

```javascript
// BOTH permissions required:

// 1. IAM role permission (allows agent role to invoke Lambda)
actionLambda.grantInvoke(agentRole);

// 2. Lambda resource policy (allows Bedrock service to invoke Lambda)
actionLambda.addPermission(`AllowBedrockAgent-${id}`, {
  principal: new iam.ServicePrincipal('bedrock.amazonaws.com'),
  action: 'lambda:InvokeFunction',
  sourceArn: `arn:aws:bedrock:${region}:${account}:agent/${agent.attrAgentId}`
});
```

**Why both?**
- `grantInvoke()` adds IAM permission to the agent's execution role
- `addPermission()` adds a resource-based policy to the Lambda function itself
- Bedrock requires the resource policy to invoke the Lambda

## Deprecated Files

- `scripts/setup-agent-actions.sh` → `scripts/DEPRECATED_setup-agent-actions.sh`
- Manual versioning workarounds in BEDROCK_AGENT_LEARNINGS.md marked as "Legacy Approach"

## Updated Documentation

- `README.md` - Removed Step 5 (manual action group setup)
- `docs/BEDROCK_AGENT_LEARNINGS.md` - Added CDK inline action groups section
- `docs/TROUBLESHOOTING.md` - Already emphasized Step Functions over database

## Verification

Experiment 96 successfully:
- ✅ Called recall_all (verified in ActionRouter logs)
- ✅ Made 20 movements (verified in database)
- ✅ Navigated maze from (2,2) to multiple positions
- ✅ No manual CLI steps required

## Migration Steps for Other Projects

If you have an existing Bedrock Agent project using manual action group setup:

1. **Extract OpenAPI schema to a file:**
   ```javascript
   // lib/action-group-schema.js
   module.exports = { MY_SCHEMA: { /* OpenAPI 3.0 */ } };
   ```

2. **Add actionGroups to CfnAgent:**
   ```javascript
   const agent = new bedrock.CfnAgent(this, 'Agent', {
     // ... existing props
     actionGroups: [{ /* inline config */ }]
   });
   ```

3. **Add Lambda resource policy:**
   ```javascript
   actionLambda.addPermission('AllowBedrockAgent', {
     principal: new iam.ServicePrincipal('bedrock.amazonaws.com'),
     action: 'lambda:InvokeFunction',
     sourceArn: `arn:aws:bedrock:${region}:${account}:agent/${agent.attrAgentId}`
   });
   ```

4. **Deploy and verify:**
   ```bash
   npm run deploy
   # Check CloudWatch logs for tool invocations
   ```

5. **Remove manual scripts and update docs**

## References

- CDK CfnAgent docs: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_bedrock.CfnAgent.html
- Bedrock Agents Lambda permissions: https://docs.aws.amazon.com/bedrock/latest/userguide/agents-permissions.html
