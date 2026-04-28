#!/usr/bin/env bash
# §01 happy — PolygonAreaJob calculates and persists area for a valid Polygon.
# Asserts: workflow completes; all polygonArea tasks (steps 2,3,4) are
# `completed`; each carries an `areaSqMeters` > 0 in Result.data.

# shellcheck disable=SC1091
source "$(dirname "$0")/_lib.sh"

require_server

RESPONSE=$(post_analysis "manual-01-happy" "$VALID_POLYGON")
WORKFLOW_ID=$(echo "$RESPONSE" | jq -r '.workflowId // empty')
if [ -z "$WORKFLOW_ID" ]; then
  echo "[FATAL] failed to create workflow: $RESPONSE"
  exit 2
fi
echo "WorkflowId: $WORKFLOW_ID"

FINAL_STATUS=$(wait_terminal "$WORKFLOW_ID" 90)
assert_eq "workflow reached completed" "$FINAL_STATUS" "completed"

dump_workflow "$WORKFLOW_ID"

# All three polygonArea steps in the YAML must be completed.
assert_sqlite_eq "polygonArea tasks completed (count)" \
  "SELECT count(*) FROM tasks WHERE workflowId='$WORKFLOW_ID' AND taskType='polygonArea' AND status='completed';" \
  "3"

# Every completed polygonArea task carries a positive areaSqMeters in Result.data.
assert_sqlite_eq "polygonArea results carry positive areaSqMeters" \
  "SELECT count(*) FROM tasks t JOIN results r ON r.taskId=t.taskId \
   WHERE t.workflowId='$WORKFLOW_ID' AND t.taskType='polygonArea' \
     AND CAST(json_extract(r.data,'\$.areaSqMeters') AS REAL) > 0;" \
  "3"

summarize
