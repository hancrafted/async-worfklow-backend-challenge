#!/usr/bin/env bash
# §01 sad — PolygonAreaJob fails gracefully on non-Polygon GeoJSON.
# Submits a Point geometry; asserts the polygonArea tasks transition to
# `failed`, the workflow itself terminates as `failed`, and Result.error
# captures the descriptive failure message (proves no silent corruption).

# shellcheck disable=SC1091
source "$(dirname "$0")/_lib.sh"

require_server

RESPONSE=$(post_analysis "manual-01-sad" "$INVALID_POLYGON")
WORKFLOW_ID=$(echo "$RESPONSE" | jq -r '.workflowId // empty')
if [ -z "$WORKFLOW_ID" ]; then
  echo "[FATAL] failed to create workflow: $RESPONSE"
  exit 2
fi
echo "WorkflowId: $WORKFLOW_ID"

FINAL_STATUS=$(wait_terminal "$WORKFLOW_ID" 90)
assert_eq "workflow reached failed" "$FINAL_STATUS" "failed"

dump_workflow "$WORKFLOW_ID"

# At least one polygonArea task is marked failed (fail-fast may sweep siblings to skipped).
assert_sqlite_eq "at least one polygonArea task failed" \
  "SELECT (count(*) > 0) FROM tasks WHERE workflowId='$WORKFLOW_ID' AND taskType='polygonArea' AND status='failed';" \
  "1"

# The failed task's Result.error captures the descriptive message.
assert_sqlite_eq "Result.error mentions invalid GeoJSON" \
  "SELECT (count(*) > 0) FROM tasks t JOIN results r ON r.taskId=t.taskId \
   WHERE t.workflowId='$WORKFLOW_ID' AND t.status='failed' \
     AND r.error LIKE '%Invalid GeoJSON%';" \
  "1"

summarize
