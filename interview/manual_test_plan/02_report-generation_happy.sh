#!/usr/bin/env bash
# §02 happy — ReportGenerationJob aggregates upstream outputs into a JSON report.
# Asserts: all four reportGeneration tasks (steps 21,22,23,24) complete; the
# final aggregation step (24) carries a Result.data with workflowId, finalReport
# string, and a tasks array containing exactly its three upstream entries.

# shellcheck disable=SC1091
source "$(dirname "$0")/_lib.sh"

require_server

RESPONSE=$(post_analysis "manual-02-happy" "$VALID_POLYGON")
WORKFLOW_ID=$(echo "$RESPONSE" | jq -r '.workflowId // empty')
if [ -z "$WORKFLOW_ID" ]; then
  echo "[FATAL] failed to create workflow: $RESPONSE"
  exit 2
fi
echo "WorkflowId: $WORKFLOW_ID"

# watch_workflow renders a live 1s tick to the terminal in TTY mode and
# falls back to wait_terminal in batch/pipe contexts; we read status from
# the WATCH_WORKFLOW_STATUS side-channel so the live tick stays visible
# (a `$(...)` capture would force [ -t 1 ] false and silence the tick).
watch_workflow "$WORKFLOW_ID" 120
FINAL_STATUS="$WATCH_WORKFLOW_STATUS"
assert_eq "workflow reached completed" "$FINAL_STATUS" "completed"

# Four reportGeneration tasks (steps 21,22,23 lane reports + 24 final aggregation).
assert_sqlite_eq "reportGeneration tasks completed (count)" \
  "SELECT count(*) FROM tasks WHERE workflowId='$WORKFLOW_ID' AND taskType='reportGeneration' AND status='completed';" \
  "4"

# Step 24's Result.data carries the canonical { workflowId, tasks, finalReport } shape.
STEP_24_DATA=$(sqlite3 "$DATABASE_PATH" \
  "SELECT r.data FROM tasks t JOIN results r ON r.taskId=t.taskId \
   WHERE t.workflowId='$WORKFLOW_ID' AND t.stepNumber=24;")
echo "--- step 24 Result.data ---"
echo "$STEP_24_DATA" | format_json

assert_jq "step 24 data.workflowId matches" "$STEP_24_DATA" '.workflowId' "$WORKFLOW_ID"
assert_jq "step 24 finalReport is non-empty string" "$STEP_24_DATA" \
  '(.finalReport | type == "string" and length > 0)' "true"
# Step 24 dependsOn is [21,22,23] in the YAML, so its tasks[] aggregate has 3 entries.
assert_jq "step 24 tasks[] has 3 upstream entries" "$STEP_24_DATA" '.tasks | length' "3"

summarize
