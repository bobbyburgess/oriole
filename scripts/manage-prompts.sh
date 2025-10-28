#!/bin/bash
# Prompt Version Management Script
# Handles creating, listing, and viewing prompt versions in Parameter Store
#
# Naming convention: /oriole/prompts/YYYYMMDD_vNNN
# Example: /oriole/prompts/20251027_v001
#
# This ensures:
# - Timestamps show when prompt was created
# - Sequential versioning (v001, v002, etc.)
# - Self-documenting (no need to look up what "v1" means)
# - No duplicate prompt text stored in database

set -e

PROFILE="bobby"
REGION="us-west-2"
PROMPT_PREFIX="/oriole/prompts/"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

show_usage() {
  echo "Prompt Version Management"
  echo "========================="
  echo ""
  echo "Usage: $0 <command> [options]"
  echo ""
  echo "Commands:"
  echo "  list                    List all prompt versions"
  echo "  view <version>          View a specific prompt version"
  echo "  create <file>           Create new prompt version from file"
  echo "  copy <from> <to>        Copy existing version to new version"
  echo "  latest                  Show the most recent prompt version"
  echo ""
  echo "Examples:"
  echo "  $0 list"
  echo "  $0 view 20251027_v001"
  echo "  $0 create prompts/my-new-prompt.txt"
  echo "  $0 copy 20251027_v001 20251028_v002"
  echo "  $0 latest"
  echo ""
  echo "Naming Convention:"
  echo "  Format: YYYYMMDD_vNNN"
  echo "  Example: 20251027_v001 (first version on Oct 27, 2025)"
  echo ""
}

list_prompts() {
  echo -e "${BLUE}📋 Available Prompt Versions${NC}"
  echo "=============================="
  echo ""

  aws ssm get-parameters-by-path \
    --path "$PROMPT_PREFIX" \
    --profile $PROFILE \
    --region $REGION \
    --query 'Parameters[*].[Name,LastModifiedDate]' \
    --output table

  echo ""
  echo -e "${YELLOW}💡 Tip: Use '$0 view <version>' to see prompt content${NC}"
}

view_prompt() {
  local version=$1

  if [ -z "$version" ]; then
    echo "Error: Version required"
    echo "Usage: $0 view <version>"
    echo "Example: $0 view 20251027_v001"
    exit 1
  fi

  # Remove prefix if user included it
  version=${version#/oriole/prompts/}

  echo -e "${BLUE}📄 Prompt Version: $version${NC}"
  echo "=============================="
  echo ""

  aws ssm get-parameter \
    --name "${PROMPT_PREFIX}${version}" \
    --profile $PROFILE \
    --region $REGION \
    --query 'Parameter.Value' \
    --output text

  echo ""
}

create_prompt() {
  local file_path=$1

  if [ -z "$file_path" ]; then
    echo "Error: File path required"
    echo "Usage: $0 create <file>"
    echo "Example: $0 create prompts/my-prompt.txt"
    exit 1
  fi

  if [ ! -f "$file_path" ]; then
    echo "Error: File not found: $file_path"
    exit 1
  fi

  # Generate version name
  local date_part=$(date +%Y%m%d)

  # Find next version number for today
  local existing_versions=$(aws ssm get-parameters-by-path \
    --path "$PROMPT_PREFIX" \
    --profile $PROFILE \
    --region $REGION \
    --query "Parameters[?contains(Name, '/${date_part}_v')].Name" \
    --output text | wc -l)

  local next_num=$(printf "%03d" $((existing_versions + 1)))
  local version="${date_part}_v${next_num}"

  echo -e "${BLUE}📝 Creating new prompt version: $version${NC}"
  echo ""

  # Read prompt from file
  local prompt_text=$(cat "$file_path")

  # Show preview
  echo "Preview (first 200 chars):"
  echo "---"
  echo "${prompt_text:0:200}..."
  echo "---"
  echo ""

  read -p "Create this as ${version}? (y/N) " -n 1 -r
  echo ""

  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled"
    exit 1
  fi

  # Create parameter
  aws ssm put-parameter \
    --name "${PROMPT_PREFIX}${version}" \
    --value "$prompt_text" \
    --type String \
    --description "Prompt version created on $(date)" \
    --profile $PROFILE \
    --region $REGION

  echo ""
  echo -e "${GREEN}✅ Created prompt version: $version${NC}"
  echo ""
  echo "To use this prompt in experiments:"
  echo "  ./trigger-experiment.sh OLLAMA NOTUSED qwen2.5:7b 1 $version"
  echo ""
}

copy_prompt() {
  local from_version=$1
  local to_version=$2

  if [ -z "$from_version" ] || [ -z "$to_version" ]; then
    echo "Error: Both from and to versions required"
    echo "Usage: $0 copy <from-version> <to-version>"
    echo "Example: $0 copy 20251027_v001 20251028_v001"
    exit 1
  fi

  # Remove prefix if user included it
  from_version=${from_version#/oriole/prompts/}
  to_version=${to_version#/oriole/prompts/}

  echo -e "${BLUE}📋 Copying prompt version${NC}"
  echo "From: $from_version"
  echo "To:   $to_version"
  echo ""

  # Get existing prompt
  local prompt_text=$(aws ssm get-parameter \
    --name "${PROMPT_PREFIX}${from_version}" \
    --profile $PROFILE \
    --region $REGION \
    --query 'Parameter.Value' \
    --output text)

  if [ -z "$prompt_text" ]; then
    echo "Error: Source version not found: $from_version"
    exit 1
  fi

  # Create new parameter
  aws ssm put-parameter \
    --name "${PROMPT_PREFIX}${to_version}" \
    --value "$prompt_text" \
    --type String \
    --description "Copied from ${from_version} on $(date)" \
    --profile $PROFILE \
    --region $REGION

  echo -e "${GREEN}✅ Copied to: $to_version${NC}"
  echo ""
}

latest_prompt() {
  echo -e "${BLUE}🔍 Finding latest prompt version${NC}"
  echo ""

  local latest=$(aws ssm get-parameters-by-path \
    --path "$PROMPT_PREFIX" \
    --profile $PROFILE \
    --region $REGION \
    --query 'Parameters | sort_by(@, &LastModifiedDate) | [-1].[Name,LastModifiedDate]' \
    --output text)

  if [ -z "$latest" ]; then
    echo "No prompts found"
    exit 0
  fi

  local name=$(echo "$latest" | awk '{print $1}')
  local date=$(echo "$latest" | awk '{print $2, $3}')
  local version=${name#/oriole/prompts/}

  echo -e "${GREEN}Latest version: $version${NC}"
  echo "Modified: $date"
  echo ""
  echo "View with: $0 view $version"
  echo ""
}

# Main command router
case "$1" in
  list)
    list_prompts
    ;;
  view)
    view_prompt "$2"
    ;;
  create)
    create_prompt "$2"
    ;;
  copy)
    copy_prompt "$2" "$3"
    ;;
  latest)
    latest_prompt
    ;;
  *)
    show_usage
    exit 1
    ;;
esac
