#!/usr/bin/env bash
# Stop only Vite listeners on the Work Calendar development ports.
# It never kills PID 1 or a process whose command does not contain "vite".
set -euo pipefail

force=false
if [[ "${1:-}" == "--force" ]]; then force=true; fi
if [[ $# -gt 0 && "${1:-}" != "--force" ]]; then
  echo "Usage: $0 [--force]" >&2
  exit 64
fi

ports=(5173 5174 4173)
stopped=()
skipped=()

for port in "${ports[@]}"; do
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$pid" == "1" || "$command" != *vite* ]]; then
      skipped+=("$port:$pid")
      continue
    fi
    kill -TERM "$pid"
    stopped+=("$port:$pid")
  done < <(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
done

if [[ ${#stopped[@]} -gt 0 ]]; then
  sleep 2
fi

if [[ "$force" == true ]]; then
  for item in "${stopped[@]}"; do
    pid="${item#*:}"
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ -n "$command" && "$command" == *vite* && "$pid" != "1" ]]; then
      kill -KILL "$pid"
    fi
  done
fi

printf 'stopped=%s skipped=%s\n' \
  "${stopped[*]:-none}" \
  "${skipped[*]:-none}"
