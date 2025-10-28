#!/bin/bash
# Refresh QuickSight SPICE datasets with latest experiment data
#
# Usage: ./refresh-quicksight-datasets.sh [dataset-name]
#   No args: Refresh all datasets
#   With arg: Refresh specific dataset only
#
# Examples:
#   ./refresh-quicksight-datasets.sh                    # Refresh all
#   ./refresh-quicksight-datasets.sh oriole-experiments # Refresh one

set -e

PROFILE="bobby"
REGION="us-west-2"
ACCOUNT_ID="864899863517"

# ANSI colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

DATASETS=(
  "oriole-experiments"
  "oriole-agent-actions"
  "oriole-parameter-sweep"
)

refresh_dataset() {
  local dataset=$1
  local ingestion_id="manual-$(date +%s)-$$"

  echo -e "${BLUE}🔄 Refreshing: $dataset${NC}"

  # Trigger ingestion
  aws quicksight create-ingestion \
    --aws-account-id $ACCOUNT_ID \
    --data-set-id "$dataset" \
    --ingestion-id "$ingestion_id" \
    --profile $PROFILE \
    --region $REGION \
    --output json > /dev/null

  # Wait a moment for ingestion to start
  sleep 2

  # Check status
  local status=$(aws quicksight list-ingestions \
    --aws-account-id $ACCOUNT_ID \
    --data-set-id "$dataset" \
    --profile $PROFILE \
    --region $REGION \
    --max-results 1 \
    --query 'Ingestions[0].[IngestionStatus,RowInfo.RowsIngested]' \
    --output text)

  local ingestion_status=$(echo "$status" | awk '{print $1}')
  local rows=$(echo "$status" | awk '{print $2}')

  if [ "$ingestion_status" = "COMPLETED" ] || [ "$ingestion_status" = "RUNNING" ]; then
    echo -e "  ${GREEN}✅ Status: $ingestion_status${NC}"
    if [ "$rows" != "None" ] && [ -n "$rows" ]; then
      echo -e "  📊 Rows: $rows"
    fi
  else
    echo -e "  ${YELLOW}⚠️  Status: $ingestion_status${NC}"
  fi
  echo ""
}

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}QuickSight Dataset Refresh${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# If specific dataset provided, refresh only that one
if [ -n "$1" ]; then
  echo "Refreshing specific dataset: $1"
  echo ""
  refresh_dataset "$1"
else
  echo "Refreshing all datasets..."
  echo ""
  for dataset in "${DATASETS[@]}"; do
    refresh_dataset "$dataset"
  done
fi

echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Refresh complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "View results in QuickSight:"
echo "  https://us-west-2.quicksight.aws.amazon.com/"
echo ""
echo "💡 Tip: Set up automatic refresh schedules in the QuickSight console"
echo "   (Datasets → Select dataset → Schedule refresh)"
