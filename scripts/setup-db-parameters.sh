#!/bin/bash
# Setup Database Configuration Parameters
# Creates SSM parameters for database connection settings

REGION=${1:-us-west-2}
PROFILE="bobby"

echo "🔧 Setting up database configuration parameters in Parameter Store ($REGION)"
echo "============================================================================="

# Database host
aws ssm put-parameter \
  --profile $PROFILE \
  --region $REGION \
  --name '/oriole/db/host' \
  --value 'continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com' \
  --type 'String' \
  --description 'PostgreSQL database host' \
  --overwrite

echo "✅ Created /oriole/db/host"

# Database port
aws ssm put-parameter \
  --profile $PROFILE \
  --region $REGION \
  --name '/oriole/db/port' \
  --value '5432' \
  --type 'String' \
  --description 'PostgreSQL database port' \
  --overwrite

echo "✅ Created /oriole/db/port"

# Database name
aws ssm put-parameter \
  --profile $PROFILE \
  --region $REGION \
  --name '/oriole/db/name' \
  --value 'oriole' \
  --type 'String' \
  --description 'PostgreSQL database name' \
  --overwrite

echo "✅ Created /oriole/db/name"

# Database user
aws ssm put-parameter \
  --profile $PROFILE \
  --region $REGION \
  --name '/oriole/db/user' \
  --value 'oriole_user' \
  --type 'String' \
  --description 'PostgreSQL database user' \
  --overwrite

echo "✅ Created /oriole/db/user"

echo ""
echo "✨ Database parameters configured successfully!"
echo ""
echo "To verify, run:"
echo "  aws ssm get-parameters-by-path --path /oriole/db --region $REGION --profile $PROFILE"
