#!/usr/bin/env bash
# §05 happy — `GET /workflow/:id/status` returns the canonical README shape
# (workflowId, status, totalTasks, completedTasks) plus the per-task array.
# Asserts: 200 immediately after creation; totalTasks=24; once terminal,
# completedTasks=24 and status=completed.

# shellcheck disable=SC1091
source "$(dirname "$0")/_lib.sh"

require_server

RESPONSE=$(post_analysis "manual-05-happy" "$VALID_POLYGON")
WORKFLOW_ID=$(echo "$RESPONSE" | jq -r '.workflowId // empty')
if [ -z "$WORKFLOW_ID" ]; then
  echo "[FATAL] failed to create workflow: $RESPONSE"
  exit 2
fi
echo "WorkflowId: $WORKFLOW_ID"

# Initial GET — server is reachable and returns the canonical shape.
assert_http_status "GET /status returns 200 (initial)" \
  "GET" "$BASE_URL/workflow/$WORKFLOW_ID/status" "" "200"

INITIAL_BODY=$(curl -sS "$BASE_URL/workflow/$WORKFLOW_ID/status")
echo "--- initial /status ---"
echo "$INITIAL_BODY" | format_json | head -8

assert_jq "initial workflowId matches" "$INITIAL_BODY" '.workflowId' "$WORKFLOW_ID"
assert_jq "initial totalTasks is 24" "$INITIAL_BODY" '.totalTasks' "24"

# Wait until terminal and re-check.
watch_workflow "$WORKFLOW_ID" 120
FINAL_STATUS="$WATCH_WORKFLOW_STATUS"
assert_eq "workflow reached completed" "$FINAL_STATUS" "completed"

FINAL_BODY=$(curl -sS "$BASE_URL/workflow/$WORKFLOW_ID/status")
assert_jq "final status is completed" "$FINAL_BODY" '.status' "completed"
assert_jq "final completedTasks is 24" "$FINAL_BODY" '.completedTasks' "24"
assert_jq "final totalTasks is 24" "$FINAL_BODY" '.totalTasks' "24"

summarize
