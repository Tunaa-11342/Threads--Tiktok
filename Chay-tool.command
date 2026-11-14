#!/bin/bash
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
export VIENEU_PYTHON="/Volumes/Data/VieNeu-TTS/.venv/bin/python"
if [ ! -d "node_modules/hyperframes" ]; then
  npm ci
fi
node server.mjs --open
