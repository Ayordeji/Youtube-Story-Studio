#!/bin/bash
# Stops Story Studio (the server on port 3100). Your projects are not touched.
PIDS=$(lsof -ti tcp:3100 2>/dev/null)
if [ -z "$PIDS" ]; then
  echo "Story Studio is not running."
else
  kill $PIDS
  echo "Story Studio stopped."
fi
sleep 1
