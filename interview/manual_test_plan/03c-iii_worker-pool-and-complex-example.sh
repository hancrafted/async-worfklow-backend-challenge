#!/bin/bash

# 1. Execute the POST request and capture the response
RESPONSE=$(curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-pool-happy",
    "geoJson": { "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] }
  }')

# 2. Extract the workflowId using jq
WORKFLOW_ID=$(echo $RESPONSE | jq -r '.workflowId')

# Check if workflowId was successfully retrieved
if [ "$WORKFLOW_ID" == "null" ] || [ -z "$WORKFLOW_ID" ]; then
  echo "Error: Could not retrieve workflowId."
  echo "Response: $RESPONSE"
  exit 1
fi

echo "Started Workflow: $WORKFLOW_ID"
echo "Polling database... (Press Ctrl+C to stop)"
echo "------------------------------------------"

# 3. Loop every second to query sqlite3
while true; do
  # Clear screen or print separator to keep output readable
  clear
  echo "Workflow ID: $WORKFLOW_ID"
  date
  
  sqlite3 -header -column data/database.sqlite \
    "SELECT t.stepNumber, t.taskType, t.status, r.error \
     FROM tasks t LEFT JOIN results r ON r.resultId = t.resultId \
     WHERE t.workflowId='$WORKFLOW_ID' ORDER BY t.stepNumber;"

  sleep 1
done