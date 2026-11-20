#!/bin/bash
# Starts Story Studio. Double-click this file, or run:  bash "Start Story Studio.command"
cd "$(dirname "$0")"

# First run: bring Node, ffmpeg and the narrator voice over from the previous system.
SRC=""
for d in "../New Youtube Automation System copy" "../New Youtube Automation System" "../Youtube Automation System"; do
  if [ -d "$d/bin" ] && [ -d "$d/node_modules" ]; then SRC="$d"; break; fi
done
if [ ! -d bin ] || [ ! -d node_modules ]; then
  if [ -z "$SRC" ]; then
    echo "Could not find the previous system's 'bin' and 'node_modules' folders next to this one."
    echo "Copy those two folders into: $PWD"
    read -n 1 -s -r -p "Press any key to close."
    exit 1
  fi
  echo "First run: copying the video tools and narrator voice from \"$SRC\". This takes a minute."
  [ -d bin ] || cp -R "$SRC/bin" ./bin
  [ -d node_modules ] || cp -R "$SRC/node_modules" ./node_modules
fi
if [ ! -f subscribe_button.png ] && [ -n "$SRC" ] && [ -f "$SRC/subscribe_button.png" ]; then
  cp "$SRC/subscribe_button.png" ./subscribe_button.png
fi

export PATH="$PWD/bin/bin:$PWD/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Node was not found in the 'bin' folder."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
# If Story Studio is already running, just open it instead of starting a second copy.
if curl -s -o /dev/null --max-time 2 http://localhost:3100/api/projects; then
  echo "Story Studio is already running. Opening it in your browser."
  open "http://localhost:3100"
  exit 0
fi
echo "Starting Story Studio at http://localhost:3100"
echo "To stop it, close this window, press Control+C, or double-click 'Stop Story Studio.command'."
(sleep 2 && open "http://localhost:3100") &
node server.js
