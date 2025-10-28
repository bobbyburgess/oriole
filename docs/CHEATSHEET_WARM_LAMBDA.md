# Oriole Development Cheatsheet

## Force Lambda to Pick Up IAM Policy Changes

When you update IAM policies via CDK deploy, Lambda warm containers may still use cached credentials for ~15 minutes.

**Problem**: IAM policy updated but Lambda still gets AccessDenied errors
**Solution**: Force Lambda to restart and refresh credentials

```bash
# Generic pattern - update function description to force restart
aws lambda update-function-configuration \
  --profile bobby \
  --region us-west-2 \
  --function-name <FUNCTION_NAME> \
  --description "Force container restart - $(date +%s)"

# Example: Restart ViewerFunction
aws lambda update-function-configuration \
  --profile bobby \
  --region us-west-2 \
  --function-name OrioleStack-ViewerFunction46CA1E16-YqCj98izKXCH \
  --description "Force container restart - $(date +%s)"
```

**Why this works**: Updating function configuration forces AWS to create new Lambda containers with fresh IAM credentials that include the updated policy.

**When to use**: After deploying IAM policy changes that affect Lambda permissions (SSM, S3, Bedrock, etc.)

## Database Access

### Direct PostgreSQL Connection
```bash
PGPASSWORD='oR8tK3mP9vL2qN7xW4bZ6jH5yT1nM3s' psql \
  -h continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com \
  -U oriole_user \
  -p 5432 \
  -d oriole
```

### Check Batch Experiment Results
```bash
# Default: shows experiments 200+
./scripts/check-batch-results.sh

# Specify starting experiment ID
./scripts/check-batch-results.sh 150

# Watch mode (refresh every 5 seconds)
watch -n 5 ./scripts/check-batch-results.sh 200
```

## Parameter Store Operations

### View All Oriole Parameters
```bash
aws ssm get-parameters-by-path \
  --profile bobby \
  --region us-west-2 \
  --path /oriole \
  --recursive \
  --query 'Parameters[*].[Name,Value]' \
  --output table
```

### Update a Parameter
```bash
aws ssm put-parameter \
  --profile bobby \
  --region us-west-2 \
  --name '/oriole/viewer/color/wall' \
  --value '#cccccc' \
  --type 'String' \
  --overwrite
```

### Get a Single Parameter
```bash
aws ssm get-parameter \
  --profile bobby \
  --region us-west-2 \
  --name '/oriole/viewer/color/wall'
```

## Deployment

### Standard Deploy
```bash
AWS_PROFILE=bobby npx cdk deploy --require-approval never
```

### Deploy with Git Commit
```bash
git add . && \
git commit -m "Your commit message" && \
git push && \
AWS_PROFILE=bobby npx cdk deploy --require-approval never
```

## Experiment Management

### Trigger New Experiment
```bash
./scripts/trigger-experiment.sh
```

### Check IAM Roles and Policies
```bash
# List roles
aws iam list-roles --profile bobby --region us-west-2 --query "Roles[?contains(RoleName, 'Oriole')]"

# List inline policies on a role
aws iam list-role-policies --profile bobby --region us-west-2 --role-name <ROLE_NAME>

# Get specific inline policy
aws iam get-role-policy \
  --profile bobby \
  --region us-west-2 \
  --role-name <ROLE_NAME> \
  --policy-name <POLICY_NAME>
```

## Debugging

### Check Lambda Logs
```bash
# Using AWS CLI
aws logs tail \
  --profile bobby \
  --region us-west-2 \
  /aws/lambda/OrioleStack-ViewerFunction46CA1E16-YqCj98izKXCH \
  --follow

# Or use CloudWatch Logs Insights in AWS Console
```

### Test Viewer Endpoint
```bash
# Check if viewer is serving correct colors
curl -s https://zzdpv8qk90.execute-api.us-west-2.amazonaws.com/viewer | grep "const COLORS"

# Test with authentication (after getting JWT token)
curl -H "Authorization: Bearer <JWT_TOKEN>" \
  https://zzdpv8qk90.execute-api.us-west-2.amazonaws.com/experiments
```

## Common Issues

### Colors Not Updating in Viewer
1. Check Parameter Store has correct values
2. Verify IAM policy includes `/oriole/viewer/*`
3. Force Lambda restart (see top of cheatsheet)
4. Hard refresh browser (Cmd+Shift+R / Ctrl+Shift+R)

### AccessDenied on SSM Parameters
1. Check IAM policy on Lambda role includes parameter path
2. Deploy CDK changes
3. Force Lambda restart to pick up new credentials
4. Verify parameter exists in Parameter Store

### Experiments Stuck/Not Progressing
1. Check Step Functions execution in AWS Console
2. Review Lambda logs for errors
3. Check database for experiment status
4. Verify cooldown settings in Parameter Store
