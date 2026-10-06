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
