#!/usr/bin/env bash
set -euo pipefail
exec npm run dev -- --host localhost --port 5173 --strictPort
