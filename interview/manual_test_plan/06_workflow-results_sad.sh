#!/usr/bin/env bash
# §06 sad — Three error branches of `GET /workflow/:id/results`:
#   1. Unknown workflowId            → 404 WORKFLOW_NOT_FOUND
#   2. Workflow not yet terminal     → 400 WORKFLOW_NOT_TERMINAL
#   3. Workflow terminated as failed → 400 WORKFLOW_FAILED  (post-#22 strict
#      contract — supersedes the earlier lenient policy that returned 200 for
#      any terminal state.)

# shellcheck disable=SC1091
source "$(dirname "$0")/_lib.sh"

require_server

# Branch 1 — unknown id.
UNKNOWN_ID="00000000-0000-0000-0000-000000000000"
assert_http_status "(unknown) returns 404" \
  "GET" "$BASE_URL/workflow/$UNKNOWN_ID/results" "" "404"
UNKNOWN_BODY=$(curl -sS "$BASE_URL/workflow/$UNKNOWN_ID/results")
assert_jq "(unknown) error=WORKFLOW_NOT_FOUND" "$UNKNOWN_BODY" '.error' "WORKFLOW_NOT_FOUND"

# Branch 2 — created but not yet terminal. The status check is racy against
# the worker pool; first GET typically catches initial/in_progress before any
# task can complete on the multi-step DAG.
RESP_PENDING=$(post_analysis "manual-06-sad-pending" "$VALID_POLYGON")
PENDING_ID=$(echo "$RESP_PENDING" | jq -r '.workflowId // empty')
echo "Pending WorkflowId: $PENDING_ID"
assert_http_status "(pending) returns 400" \
  "GET" "$BASE_URL/workflow/$PENDING_ID/results" "" "400"
PENDING_BODY=$(curl -sS "$BASE_URL/workflow/$PENDING_ID/results")
assert_jq "(pending) error=WORKFLOW_NOT_TERMINAL" "$PENDING_BODY" '.error' "WORKFLOW_NOT_TERMINAL"

# Branch 3 — terminal=failed (post-#22 strict 400 WORKFLOW_FAILED).
RESP_FAILED=$(post_analysis "manual-06-sad-failed" "$INVALID_POLYGON")
FAILED_ID=$(echo "$RESP_FAILED" | jq -r '.workflowId // empty')
echo "Failed WorkflowId: $FAILED_ID"
FINAL_STATUS=$(wait_terminal "$FAILED_ID" 90)
assert_eq "(failed) workflow reached failed" "$FINAL_STATUS" "failed"
assert_http_status "(failed) returns 400" \
  "GET" "$BASE_URL/workflow/$FAILED_ID/results" "" "400"
FAILED_BODY=$(curl -sS "$BASE_URL/workflow/$FAILED_ID/results")
assert_jq "(failed) error=WORKFLOW_FAILED" "$FAILED_BODY" '.error' "WORKFLOW_FAILED"

summarize
