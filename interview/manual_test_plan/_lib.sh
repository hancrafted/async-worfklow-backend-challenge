# Shared helpers for interview/manual_test_plan scripts.
# Sourced by every NN_*.sh — never executed directly.
# Two-terminal contract: reviewer runs `npm start` in one terminal and the
# script in another. No script manages the server lifecycle.

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
DATABASE_PATH="${DATABASE_PATH:-data/database.sqlite}"

PASS_COUNT=0
FAIL_COUNT=0
SCRIPT_NAME="$(basename "${BASH_SOURCE[1]:-${0}}")"

VALID_POLYGON='{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}'
INVALID_POLYGON='{"type":"Point","coordinates":[0,0]}'

# Asserts the dev server is reachable. Exits with actionable help if not.
require_server() {
  if ! curl -sS -o /dev/null --max-time 3 "$BASE_URL/"; then
    echo "[ERROR] Cannot reach $BASE_URL. Start the server in another terminal:"
    echo "    npm start"
    exit 2
  fi
}

# Wraps POST /analysis. Echoes the JSON response body to stdout.
post_analysis() {
  local clientId="$1"
  local geoJson="$2"
  curl -sS -X POST "$BASE_URL/analysis" \
    -H 'Content-Type: application/json' \
    -d "{\"clientId\":\"$clientId\",\"geoJson\":$geoJson}"
}

# Polls /workflow/:id/status until terminal or timeout.
# Echoes the final status (completed|failed|timeout) on stdout.
wait_terminal() {
  local workflowId="$1"
  local timeoutSec="${2:-90}"
  local elapsed=0
  local status=""
  while [ "$elapsed" -lt "$timeoutSec" ]; do
    status=$(curl -sS "$BASE_URL/workflow/$workflowId/status" | jq -r '.status // empty')
    if [ "$status" = "completed" ] || [ "$status" = "failed" ]; then
      echo "$status"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "timeout"
  return 1
}

# Live-tails a workflow's tasks every 1s in interactive terminals, falling
# back to silent polling (wait_terminal semantics) outside a TTY so the
# 11-script batch loop stays free of clear codes / per-tick noise.
# Echoes the final terminal status (completed|failed|timeout) on stdout —
# same contract as wait_terminal, so callers can substitute either helper
# via $(...). Also exports WATCH_WORKFLOW_STATUS for callers that want the
# live tick visible (i.e. invoke without $() capture, since [ -t 1 ] is
# always false inside command substitution).
watch_workflow() {
  local workflowId="$1"
  local timeoutSec="${2:-120}"
  WATCH_WORKFLOW_STATUS=""
  if [ ! -t 1 ]; then
    local s
    s=$(wait_terminal "$workflowId" "$timeoutSec")
    local rc=$?
    WATCH_WORKFLOW_STATUS="$s"
    echo "$s"
    return $rc
  fi
  local elapsed=0
  local status=""
  while [ "$elapsed" -lt "$timeoutSec" ]; do
    status=$(curl -sS "$BASE_URL/workflow/$workflowId/status" | jq -r '.status // empty')
    clear
    echo "Workflow: $workflowId  elapsed=${elapsed}s  status=${status:-unknown}"
    sqlite3 -header -column "$DATABASE_PATH" \
      "SELECT t.stepNumber, t.taskType, t.status, r.error \
       FROM tasks t LEFT JOIN results r ON r.resultId = t.resultId \
       WHERE t.workflowId='$workflowId' ORDER BY t.stepNumber;"
    if [ "$status" = "completed" ] || [ "$status" = "failed" ]; then
      echo "watch_workflow: $workflowId -> $status in ${elapsed}s"
      WATCH_WORKFLOW_STATUS="$status"
      echo "$status"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "watch_workflow: $workflowId -> timeout in ${elapsed}s"
  WATCH_WORKFLOW_STATUS="timeout"
  echo "timeout"
  return 1
}

# Pretty-prints the workflow's tasks straight from sqlite for evidence.
dump_workflow() {
  local workflowId="$1"
  echo "--- workflow $workflowId tasks ---"
  sqlite3 -header -column "$DATABASE_PATH" \
    "SELECT t.stepNumber, t.taskType, t.status \
     FROM tasks t WHERE t.workflowId='$workflowId' ORDER BY t.stepNumber;"
}

# Indented JSON pretty-printer (graceful on non-JSON input).
format_json() {
  python3 -c 'import sys, json
try:
    data = json.load(sys.stdin)
    print(json.dumps(data, indent=2))
except Exception:
    sys.stdout.write(sys.stdin.read())'
}

# assert_eq <name> <actual> <expected>
assert_eq() {
  local name="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "[PASS] $name (got=$actual)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "[FAIL] $name expected='$expected' actual='$actual'"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# assert_jq <name> <json> <jqExpr> <expected>
assert_jq() {
  local name="$1" json="$2" jqExpr="$3" expected="$4"
  local actual
  actual=$(printf '%s' "$json" | jq -r "$jqExpr")
  assert_eq "$name" "$actual" "$expected"
}

# assert_http_status <name> <method> <url> <body|""> <expected>
assert_http_status() {
  local name="$1" method="$2" url="$3" body="$4" expected="$5"
  local actual
  if [ -n "$body" ]; then
    actual=$(curl -sS -o /dev/null -w '%{http_code}' \
      -X "$method" -H 'Content-Type: application/json' -d "$body" "$url")
  else
    actual=$(curl -sS -o /dev/null -w '%{http_code}' -X "$method" "$url")
  fi
  assert_eq "$name" "$actual" "$expected"
}

# assert_sqlite_eq <name> <query> <expected>
assert_sqlite_eq() {
  local name="$1" query="$2" expected="$3"
  local actual
  actual=$(sqlite3 "$DATABASE_PATH" "$query")
  assert_eq "$name" "$actual" "$expected"
}

summarize() {
  echo "----------------------------------------"
  if [ "$FAIL_COUNT" -eq 0 ]; then
    echo "[PASS] $SCRIPT_NAME ($PASS_COUNT/$PASS_COUNT assertions)"
    exit 0
  fi
  echo "[FAIL] $SCRIPT_NAME ($FAIL_COUNT failed, $PASS_COUNT passed)"
  exit 1
}
