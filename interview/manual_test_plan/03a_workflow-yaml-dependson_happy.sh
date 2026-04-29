#!/usr/bin/env bash
# §03a happy — `dependsOn` in YAML is parsed, persisted, and surfaced via API.
# Asserts: a workflow built from the example YAML completes end-to-end (proving
# the dependency chain executes in topological order) and that GET /status
# echoes the dependsOn arrays back as stepNumber lists matching the YAML.
# Sad-path coverage for malformed/cyclic YAML lives in tests/03a-workflow-yaml-dependson/.

# shellcheck disable=SC1091
source "$(dirname "$0")/_lib.sh"

require_server

RESPONSE=$(post_analysis "manual-03a-happy" "$VALID_POLYGON")
WORKFLOW_ID=$(echo "$RESPONSE" | jq -r '.workflowId // empty')
if [ -z "$WORKFLOW_ID" ]; then
  echo "[FATAL] failed to create workflow: $RESPONSE"
  exit 2
fi
echo "WorkflowId: $WORKFLOW_ID"

watch_workflow "$WORKFLOW_ID" 120
FINAL_STATUS="$WATCH_WORKFLOW_STATUS"
assert_eq "workflow reached completed (full DAG executed)" "$FINAL_STATUS" "completed"

STATUS_BODY=$(curl -sS "$BASE_URL/workflow/$WORKFLOW_ID/status")
echo "--- /status tasks (dependsOn arrays) ---"
echo "$STATUS_BODY" | jq '.tasks[] | {stepNumber, dependsOn}'

# Spot-check three representative dependency edges from the YAML.
assert_jq "step 5 dependsOn = [2]" "$STATUS_BODY" \
  '.tasks[] | select(.stepNumber==5) | .dependsOn | tostring' "[2]"
assert_jq "step 17 dependsOn = [14,15,16]" "$STATUS_BODY" \
  '.tasks[] | select(.stepNumber==17) | .dependsOn | sort | tostring' "[14,15,16]"
assert_jq "step 24 dependsOn = [21,22,23]" "$STATUS_BODY" \
  '.tasks[] | select(.stepNumber==24) | .dependsOn | sort | tostring' "[21,22,23]"

summarize
