#!/bin/bash
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
if [ -f "/Volumes/Data/VieNeu-TTS/.venv/bin/python" ]; then
  export VIENEU_PYTHON="/Volumes/Data/VieNeu-TTS/.venv/bin/python"
fi
if [ ! -d "node_modules" ] || [ ! -d "node_modules/lucide" ]; then
  echo "Cai dat / cap nhat thu vien node..."
  npm install
fi
node server.mjs --open
