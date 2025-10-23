#!/bin/bash

# Script to store Cognito User Pool configuration in Parameter Store
# Usage: ./setup-cognito-params.sh <user-pool-id> <user-pool-client-id>

USER_POOL_ID=$1
USER_POOL_CLIENT_ID=$2

if [ -z "$USER_POOL_ID" ] || [ -z "$USER_POOL_CLIENT_ID" ]; then
  echo "Usage: $0 <user-pool-id> <user-pool-client-id>"
  echo ""
  echo "Example:"
  echo "  $0 us-west-2_ABC123 1a2b3c4d5e6f7g8h9i0j"
  exit 1
fi

echo "Setting Cognito parameters in Parameter Store..."
echo ""

# Set User Pool ID
aws ssm put-parameter \
  --name /oriole/cognito/user-pool-id \
  --value "$USER_POOL_ID" \
  --type String \
  --overwrite

echo "✅ Set /oriole/cognito/user-pool-id = $USER_POOL_ID"

# Set User Pool Client ID
aws ssm put-parameter \
  --name /oriole/cognito/user-pool-client-id \
  --value "$USER_POOL_CLIENT_ID" \
  --type String \
  --overwrite

echo "✅ Set /oriole/cognito/user-pool-client-id = $USER_POOL_CLIENT_ID"
echo ""
echo "Done! You can now deploy the CDK stack without parameters."
