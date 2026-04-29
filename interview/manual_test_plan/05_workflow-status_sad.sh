#!/usr/bin/env bash
# §05 sad — `GET /workflow/:id/status` for an unknown id returns 404 with the
# canonical `{ error: "WORKFLOW_NOT_FOUND", message }` shape (README §5).

# shellcheck disable=SC1091
source "$(dirname "$0")/_lib.sh"

require_server

UNKNOWN_ID="00000000-0000-0000-0000-000000000000"

assert_http_status "GET /status with unknown id returns 404" \
  "GET" "$BASE_URL/workflow/$UNKNOWN_ID/status" "" "404"

BODY=$(curl -sS "$BASE_URL/workflow/$UNKNOWN_ID/status")
echo "--- error body ---"
echo "$BODY" | format_json

assert_jq "error code is WORKFLOW_NOT_FOUND" "$BODY" '.error' "WORKFLOW_NOT_FOUND"
assert_jq "error message is non-empty" "$BODY" '(.message | length > 0)' "true"

summarize
