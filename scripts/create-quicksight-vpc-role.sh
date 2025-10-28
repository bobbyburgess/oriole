#!/bin/bash

# Create IAM role for QuickSight VPC access
# This role allows QuickSight to create ENIs in your VPC

set -e

PROFILE="bobby"
REGION="us-west-2"
ACCOUNT_ID="864899863517"
ROLE_NAME="QuickSightVPCConnectionRole"

echo "🔐 Creating IAM role for QuickSight VPC access..."

# Step 1: Create trust policy (allows QuickSight to assume this role)
cat > /tmp/quicksight-trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "quicksight.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# Step 2: Create the role
echo "Creating role: $ROLE_NAME..."
ROLE_ARN=$(aws iam create-role \
  --role-name $ROLE_NAME \
  --assume-role-policy-document file:///tmp/quicksight-trust-policy.json \
  --description "Allows QuickSight to create VPC connections and access RDS" \
  --profile $PROFILE \
  --query 'Role.Arn' \
  --output text 2>&1)

if [[ $ROLE_ARN == *"error"* ]] || [[ $ROLE_ARN == *"EntityAlreadyExists"* ]]; then
  echo "⚠️  Role may already exist, fetching ARN..."
  ROLE_ARN=$(aws iam get-role \
    --role-name $ROLE_NAME \
    --profile $PROFILE \
    --query 'Role.Arn' \
    --output text)
fi

echo "✅ Role ARN: $ROLE_ARN"

# Step 3: Create inline policy for VPC/ENI permissions
echo ""
echo "Attaching VPC permissions policy..."

cat > /tmp/quicksight-vpc-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:CreateNetworkInterface",
        "ec2:ModifyNetworkInterfaceAttribute",
        "ec2:DeleteNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeSubnets",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeVpcs",
        "ec2:CreateNetworkInterfacePermission"
      ],
      "Resource": "*"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name $ROLE_NAME \
  --policy-name "QuickSightVPCAccess" \
  --policy-document file:///tmp/quicksight-vpc-policy.json \
  --profile $PROFILE

echo "✅ VPC permissions attached"

# Step 4: Wait for role to propagate
echo ""
echo "⏳ Waiting 10 seconds for IAM role to propagate..."
sleep 10

# Cleanup temp files
rm -f /tmp/quicksight-trust-policy.json /tmp/quicksight-vpc-policy.json

echo ""
echo "🎉 QuickSight VPC role created successfully!"
echo ""
echo "Role ARN: $ROLE_ARN"
echo ""
echo "Next step: Use this role ARN when creating VPC connection"
echo "  aws quicksight create-vpc-connection --role-arn $ROLE_ARN ..."
