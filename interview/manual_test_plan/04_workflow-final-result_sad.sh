#!/usr/bin/env bash
# §04 sad — When the workflow fails, `Workflow.finalResult` still records the
# failure (per README §4 requirement: "include failure information in the
# final result"). Asserts: column is non-null even on failure; failedAtStep
# carries the failed step number; the failed task entry carries an `error`
# block with a public message + reason.

# shellcheck disable=SC1091
source "$(dirname "$0")/_lib.sh"

require_server

RESPONSE=$(post_analysis "manual-04-sad" "$INVALID_POLYGON")
WORKFLOW_ID=$(echo "$RESPONSE" | jq -r '.workflowId // empty')
if [ -z "$WORKFLOW_ID" ]; then
  echo "[FATAL] failed to create workflow: $RESPONSE"
  exit 2
fi
echo "WorkflowId: $WORKFLOW_ID"

FINAL_STATUS=$(wait_terminal "$WORKFLOW_ID" 90)
assert_eq "workflow reached failed" "$FINAL_STATUS" "failed"

# Eager write happens for terminal=failed too — column is populated.
assert_sqlite_eq "finalResult column is not null on failed workflow" \
  "SELECT (finalResult IS NOT NULL) FROM workflows WHERE workflowId='$WORKFLOW_ID';" \
  "1"

FINAL_RESULT_RAW=$(sqlite3 "$DATABASE_PATH" \
  "SELECT finalResult FROM workflows WHERE workflowId='$WORKFLOW_ID';")
echo "--- finalResult (DB column) ---"
echo "$FINAL_RESULT_RAW" | format_json | head -40

# README §4 explicitly: "include failure information in the final result".
assert_jq "finalResult.failedAtStep is a number" "$FINAL_RESULT_RAW" \
  '(.failedAtStep | type)' "number"
# At least one task entry carries a public { message, reason } error block.
assert_jq "at least one task entry has an error.message" "$FINAL_RESULT_RAW" \
  '([.tasks[] | select(.error.message != null)] | length > 0)' "true"

summarize
