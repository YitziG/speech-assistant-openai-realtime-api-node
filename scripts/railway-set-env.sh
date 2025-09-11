#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=${1:-.env}

if ! command -v railway >/dev/null 2>&1; then
  echo "Error: railway CLI not found. Install: https://railway.app/docs/cli" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: env file '$ENV_FILE' not found" >&2
  exit 1
fi

echo "Pushing variables from $ENV_FILE to current Railway service..."

# Try multiple CLI forms for compatibility across Railway CLI versions
try_set() {
  local key="$1"; shift
  local val="$1"; shift
  local kv="${key}=${val}"

  # 1) Newer CLI variant: --set KEY=VALUE
  if railway variables --set "$kv" >/dev/null 2>&1; then
    return 0
  fi
  # 2) Shorthand -s KEY=VALUE
  if railway variables -s "$kv" >/dev/null 2>&1; then
    return 0
  fi
  # 3) Subcommand form: variables set KEY VALUE
  if railway variables set "$key" "$val" >/dev/null 2>&1; then
    return 0
  fi
  # 4) Subcommand form with KEY=VALUE
  if railway variables set "$kv" >/dev/null 2>&1; then
    return 0
  fi
  # 5) Legacy env set KEY=VALUE
  if railway env set "$kv" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# Read KEY=VALUE pairs, ignore blank lines and lines starting with '#', and trim inline comments (# ...)
while IFS= read -r line; do
  # Trim leading/trailing whitespace
  line="$(echo "$line" | sed -e 's/^\s*//' -e 's/\s*$//')"
  # Skip comments/empty
  [[ -z "$line" || "$line" =~ ^# ]] && continue
  # Drop inline comments (preserve URL-encoded or literal '#'? heuristic: split on ' #' only)
  if [[ "$line" =~ \ \# ]]; then
    line="${line%% \#*}"
  fi
  # Split on first '='
  key="${line%%=*}"
  val="${line#*=}"
  # Trim whitespace around key/val
  key="$(echo "$key" | sed -e 's/^\s*//' -e 's/\s*$//')"
  val="$(echo "$val" | sed -e 's/^\s*//' -e 's/\s*$//')"
  if [[ -z "$key" ]]; then
    continue
  fi
  echo "- set $key"
  if ! try_set "$key" "$val"; then
    echo "  ! failed to set $key — please set it manually via 'railway variables --set \"$key=$val\"' (or your CLI's supported syntax)" >&2
  fi
done < "$ENV_FILE"

echo "Done. Verify with: railway variables list"
