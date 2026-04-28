#!/usr/bin/env bash
# §02 sad — When upstream tasks fail, the report job is not run on garbage.
# Submits invalid GeoJSON so polygonArea fails early; the fail-fast sweep
# transitions all `waiting`/`queued` siblings to `skipped`. Asserts: no
# reportGeneration task ran to completion; all four are `skipped`. Failure
# information itself surfaces via the framework-synthesized finalResult,
# not via a half-baked report — that is exactly the README §2 requirement.

# shellcheck disable=SC1091
source "$(dirname "$0")/_lib.sh"

require_server

RESPONSE=$(post_analysis "manual-02-sad" "$INVALID_POLYGON")
WORKFLOW_ID=$(echo "$RESPONSE" | jq -r '.workflowId // empty')
if [ -z "$WORKFLOW_ID" ]; then
  echo "[FATAL] failed to create workflow: $RESPONSE"
  exit 2
fi
echo "WorkflowId: $WORKFLOW_ID"

FINAL_STATUS=$(wait_terminal "$WORKFLOW_ID" 90)
assert_eq "workflow reached failed" "$FINAL_STATUS" "failed"

dump_workflow "$WORKFLOW_ID"

# No reportGeneration task ran on a corrupted DAG.
assert_sqlite_eq "zero reportGeneration tasks completed" \
  "SELECT count(*) FROM tasks WHERE workflowId='$WORKFLOW_ID' AND taskType='reportGeneration' AND status='completed';" \
  "0"

# All four reportGeneration steps were swept to `skipped` by fail-fast.
assert_sqlite_eq "reportGeneration tasks skipped (count)" \
  "SELECT count(*) FROM tasks WHERE workflowId='$WORKFLOW_ID' AND taskType='reportGeneration' AND status='skipped';" \
  "4"

# Failure detail flows through the synthesized finalResult, not the report.
assert_sqlite_eq "finalResult records failedAtStep" \
  "SELECT (json_extract(finalResult,'\$.failedAtStep') IS NOT NULL) FROM workflows WHERE workflowId='$WORKFLOW_ID';" \
  "1"

summarize
