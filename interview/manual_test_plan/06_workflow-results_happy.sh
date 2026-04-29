#!/usr/bin/env bash
# §06 happy — `GET /workflow/:id/results` returns 200 + finalResult once the
# workflow has completed. Asserts: response shape matches the README example
# (workflowId, status="completed", finalResult); finalResult.tasks aggregates
# every step in the workflow.

# shellcheck disable=SC1091
source "$(dirname "$0")/_lib.sh"

require_server

RESPONSE=$(post_analysis "manual-06-happy" "$VALID_POLYGON")
WORKFLOW_ID=$(echo "$RESPONSE" | jq -r '.workflowId // empty')
if [ -z "$WORKFLOW_ID" ]; then
  echo "[FATAL] failed to create workflow: $RESPONSE"
  exit 2
fi
echo "WorkflowId: $WORKFLOW_ID"

watch_workflow "$WORKFLOW_ID" 120
FINAL_STATUS="$WATCH_WORKFLOW_STATUS"
assert_eq "workflow reached completed" "$FINAL_STATUS" "completed"

assert_http_status "GET /results returns 200" \
  "GET" "$BASE_URL/workflow/$WORKFLOW_ID/results" "" "200"

BODY=$(curl -sS "$BASE_URL/workflow/$WORKFLOW_ID/results")
echo "--- /results body ---"
echo "$BODY" | format_json | head -20

assert_jq "response workflowId matches" "$BODY" '.workflowId' "$WORKFLOW_ID"
assert_jq "response status is completed" "$BODY" '.status' "completed"
assert_jq "finalResult.tasks has 24 entries" "$BODY" '.finalResult.tasks | length' "24"

summarize
