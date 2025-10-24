#!/bin/bash

# ⚠️ DEPRECATED - Action groups are now managed via CDK
#
# This script is no longer needed. As of 2025-10-24, action groups are
# defined inline in the CDK template (lib/bedrock-agent-construct.js).
#
# To modify action groups:
# 1. Edit lib/action-group-schema.js (OpenAPI schema)
# 2. Run: npm run deploy
#
# This script is kept for historical reference only.

echo "⚠️  This script is DEPRECATED"
echo ""
echo "Action groups are now managed via CDK in lib/bedrock-agent-construct.js"
echo "To update action groups, edit lib/action-group-schema.js and run 'npm run deploy'"
echo ""
echo "Exiting..."
exit 1
