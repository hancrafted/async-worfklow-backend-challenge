#!/usr/bin/env bash
# §04 happy — `Workflow.finalResult` is eagerly written when the workflow
# reaches a completed terminal state, and contains an entry for every task.
# Asserts: the column is non-null in SQLite; the parsed payload echoes the
# workflowId; the tasks[] aggregate has 24 entries (one per YAML step).

# shellcheck disable=SC1091
source "$(dirname "$0")/_lib.sh"

require_server

RESPONSE=$(post_analysis "manual-04-happy" "$VALID_POLYGON")
WORKFLOW_ID=$(echo "$RESPONSE" | jq -r '.workflowId // empty')
if [ -z "$WORKFLOW_ID" ]; then
  echo "[FATAL] failed to create workflow: $RESPONSE"
  exit 2
fi
echo "WorkflowId: $WORKFLOW_ID"

FINAL_STATUS=$(wait_terminal "$WORKFLOW_ID" 120)
assert_eq "workflow reached completed" "$FINAL_STATUS" "completed"

# The eager write inside the post-task transaction populated the column.
assert_sqlite_eq "finalResult column is not null" \
  "SELECT (finalResult IS NOT NULL) FROM workflows WHERE workflowId='$WORKFLOW_ID';" \
  "1"

# The synthesized payload aggregates every task in the workflow.
FINAL_RESULT_RAW=$(sqlite3 "$DATABASE_PATH" \
  "SELECT finalResult FROM workflows WHERE workflowId='$WORKFLOW_ID';")
echo "--- finalResult (DB column) ---"
echo "$FINAL_RESULT_RAW" | format_json | head -40

assert_jq "finalResult.workflowId matches" "$FINAL_RESULT_RAW" '.workflowId' "$WORKFLOW_ID"
assert_jq "finalResult.tasks has 24 entries" "$FINAL_RESULT_RAW" '.tasks | length' "24"
# On the happy path nothing failed, so the framework omits failedAtStep entirely.
assert_jq "finalResult.failedAtStep is absent" "$FINAL_RESULT_RAW" \
  '(.failedAtStep == null)' "true"

summarize
