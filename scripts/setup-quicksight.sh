#!/bin/bash

# Setup QuickSight for Oriole Analytics
# This script creates VPC connection and PostgreSQL data source

set -e

PROFILE="bobby"
REGION="us-west-2"
ACCOUNT_ID="864899863517"

# RDS details (from describe-db-instances)
VPC_ID="vpc-05a71591dded80ed8"
SUBNET_ID_1="subnet-00c2ff0b72cef60f8"
SUBNET_ID_2="subnet-0c69feb27d23b37e6"
SECURITY_GROUP_ID="sg-04d7de0045e5b5e34"
RDS_HOST="continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com"
RDS_PORT="5432"
RDS_DATABASE="oriole"
RDS_USERNAME="oriole_user"

echo "🔗 Setting up QuickSight for Oriole Analytics"
echo "=============================================="

# Step 1: Create VPC Connection
echo ""
echo "📡 Step 1: Creating VPC Connection..."

VPC_CONNECTION_ID=$(aws quicksight create-vpc-connection \
  --aws-account-id $ACCOUNT_ID \
  --vpc-connection-id "oriole-vpc-connection" \
  --name "Oriole RDS VPC Connection" \
  --subnet-ids $SUBNET_ID_1 $SUBNET_ID_2 \
  --security-group-ids $SECURITY_GROUP_ID \
  --profile $PROFILE \
  --region $REGION \
  --query 'VpcConnectionId' \
  --output text 2>&1)

if [[ $VPC_CONNECTION_ID == *"error"* ]] || [[ $VPC_CONNECTION_ID == *"ConflictException"* ]]; then
  echo "⚠️  VPC connection may already exist, continuing..."
  VPC_CONNECTION_ID="oriole-vpc-connection"
else
  echo "✅ VPC Connection created: $VPC_CONNECTION_ID"
fi

# Wait for VPC connection to be ready
echo "⏳ Waiting for VPC connection to be available..."
sleep 15

# Step 2: Check VPC connection status
echo ""
echo "🔍 Step 2: Checking VPC Connection status..."
aws quicksight describe-vpc-connection \
  --aws-account-id $ACCOUNT_ID \
  --vpc-connection-id $VPC_CONNECTION_ID \
  --profile $PROFILE \
  --region $REGION \
  --query '{Status:Status,SubnetIds:SubnetIds,SecurityGroupIds:SecurityGroupIds}' \
  --output table

# Step 3: Create PostgreSQL Data Source
echo ""
echo "🗄️  Step 3: Creating PostgreSQL Data Source..."

# You'll need to provide the RDS password
read -sp "Enter RDS password for oriole_user: " RDS_PASSWORD
echo ""

DATA_SOURCE_ID="oriole-postgres-$(date +%s)"

aws quicksight create-data-source \
  --aws-account-id $ACCOUNT_ID \
  --data-source-id $DATA_SOURCE_ID \
  --name "Oriole PostgreSQL Database" \
  --type "POSTGRESQL" \
  --data-source-parameters "{
    \"PostgreSqlParameters\": {
      \"Host\": \"$RDS_HOST\",
      \"Port\": $RDS_PORT,
      \"Database\": \"$RDS_DATABASE\"
    }
  }" \
  --credentials "{
    \"CredentialPair\": {
      \"Username\": \"$RDS_USERNAME\",
      \"Password\": \"$RDS_PASSWORD\"
    }
  }" \
  --vpc-connection-properties "{
    \"VpcConnectionArn\": \"arn:aws:quicksight:$REGION:$ACCOUNT_ID:vpcConnection/$VPC_CONNECTION_ID\"
  }" \
  --permissions "[
    {
      \"Principal\": \"arn:aws:quicksight:$REGION:$ACCOUNT_ID:user/default/bobbyburgess\",
      \"Actions\": [
        \"quicksight:DescribeDataSource\",
        \"quicksight:DescribeDataSourcePermissions\",
        \"quicksight:PassDataSource\",
        \"quicksight:UpdateDataSource\",
        \"quicksight:DeleteDataSource\",
        \"quicksight:UpdateDataSourcePermissions\"
      ]
    }
  ]" \
  --profile $PROFILE \
  --region $REGION

echo ""
echo "✅ Data Source created: $DATA_SOURCE_ID"

# Step 4: Test connection
echo ""
echo "🧪 Step 4: Testing data source connection..."
sleep 5

aws quicksight describe-data-source \
  --aws-account-id $ACCOUNT_ID \
  --data-source-id $DATA_SOURCE_ID \
  --profile $PROFILE \
  --region $REGION \
  --query '{Name:Name,Type:Type,Status:Status,LastUpdatedTime:LastUpdatedTime}' \
  --output table

echo ""
echo "🎉 QuickSight setup complete!"
echo ""
echo "Next steps:"
echo "1. Go to QuickSight console: https://us-west-2.quicksight.aws.amazon.com/"
echo "2. Navigate to Datasets → New dataset"
echo "3. Select data source: Oriole PostgreSQL Database"
echo "4. Start creating visualizations!"
echo ""
echo "Data source ID: $DATA_SOURCE_ID"
echo "VPC connection ID: $VPC_CONNECTION_ID"
