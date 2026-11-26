#!/usr/bin/env bash
set -euo pipefail

# Certbot can also renew unrelated certificates on the same server.
if [[ -n "${RENEWED_LINEAGE:-}" && "${RENEWED_LINEAGE##*/}" != corec-ip ]]; then
  exit 0
fi

# Resolve the symlink installed in Certbot's renewal-hooks/deploy directory.
script_path="$(readlink -f -- "${BASH_SOURCE[0]}")"
project_dir="$(cd -- "$(dirname -- "$script_path")/.." && pwd)"
compose=(docker compose --project-directory "$project_dir"
  -f "$project_dir/docker-compose.yml")

"${compose[@]}" exec -T web nginx -t
exec "${compose[@]}" exec -T web nginx -s reload
