#!/bin/bash

# Default polling duration
DURATION=6

# Parse command line arguments
for arg in "$@"; do
  case $arg in
    --duration=*)
    DURATION="${arg#*=}"
    shift
    ;;
  esac
done

# Define a Python snippet to handle the mixed JSON formatting
FORMAT_JSON=$(cat << 'EOF'
import sys, json
try:
    data = json.load(sys.stdin)
    out = []
    for k, v in data.items():
        if k == 'tasks' and isinstance(v, list):
            # Format each task in the array onto a single line
            tasks_str = ",\n".join(f"    {json.dumps(t)}" for t in v)
            out.append(f'  "{k}": [\n{tasks_str}\n  ]')
        else:
            # Standard formatting for everything else
            out.append(f'  "{k}": {json.dumps(v)}')
    print("{\n" + ",\n".join(out) + "\n}")
except Exception:
    # If the curl response isn't valid JSON, just print it raw
    print(sys.stdin.read())
EOF
)

# 1. Start the workflow and extract the WORKFLOW_ID
echo "Creating new workflow..."
WORKFLOW_ID=$(curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{"clientId":"manual-task5-happy","geoJson":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}}' | jq -r .workflowId)

# Check if WORKFLOW_ID was successfully retrieved
if [ -z "$WORKFLOW_ID" ] || [ "$WORKFLOW_ID" == "null" ]; then
  echo "Error: Failed to retrieve WORKFLOW_ID. Is the server running?"
  exit 1
fi

echo "Started Workflow ID: $WORKFLOW_ID"
echo "Polling status every 1 second for $DURATION seconds..."
echo "--------------------------------------------------------"

# 2. Poll the status for the specified duration
for (( i=1; i<=DURATION; i++ )); do
  echo "--- [$(date +'%H:%M:%S')] (Poll $i of $DURATION) ---"
  
  # Pipe the curl output into our Python formatter
  curl -sS "http://localhost:3000/workflow/$WORKFLOW_ID/status" | python3 -c "$FORMAT_JSON"
  
  sleep 1
done

echo "--------------------------------------------------------"
echo "Polling finished. Fetching final results..."

# 3. Output the final results with headers included (-i)
curl -sS -i "http://localhost:3000/workflow/$WORKFLOW_ID/results"