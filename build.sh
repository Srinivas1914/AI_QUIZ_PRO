#!/usr/bin/env bash
# Exit on error
set -o errexit

npm install
npm run build

# Ensure dist exists and has content
if [ ! -d "dist" ]; then
  echo "Build failed: dist directory not found"
  exit 1
fi

# Install Python dependencies for the Python backend
if [ -f "python_backend/requirements.txt" ]; then
  echo "Installing Python dependencies..."
  pip install -r python_backend/requirements.txt || pip3 install -r python_backend/requirements.txt || echo "Warning: Python deps install failed"
fi
