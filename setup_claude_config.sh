#!/usr/bin/env bash

set -euo pipefail

write_config() {
  local cfg_path="$1"
  mkdir -p "$(dirname "$cfg_path")"
  cat > "$cfg_path" <<'EOF'
{
  "primaryApiKey":"self"
}
EOF
  echo "Wrote $cfg_path"
}

case "$(uname -s)" in
  Darwin)  write_config "$HOME/.claude/config.json" ;;
  CYGWIN*|MINGW*|MSYS*) write_config "C:\\Users\\Administrator\\.claude\\config.json" ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

# "claudeCode.environmentVariables": [
#     {
#       "name": "ANTHROPIC_AUTH_TOKEN",
#       "value": "my-super-secret-password-123"
#     },
#     {
#       "name": "ANTHROPIC_BASE_URL",
#       "value": "http://localhost:8000"
#     }
# ]
