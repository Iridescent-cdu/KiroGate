#!/usr/bin/env bash

set -euo pipefail

# 用途：
# - 在 macOS 或 Windows 环境下生成 Claude 的本地配置文件
# - macOS 额外往 ~/.zshrc 追加本地 API 的环境变量，方便终端与 IDE 读取
# 行为：
# - 写入 ~/.claude/config.json（或 Windows 下的配置路径），primaryApiKey 指向 self
# - 向 ~/.zshrc 追加 ANTHROPIC_BASE_URL 与 ANTHROPIC_AUTH_TOKEN，若已有标记则跳过
# 使用：
# - bash setup_claude_config.sh
# 注意：
# - 脚本具备幂等性：存在标记时不会重复追加 zshrc 内容；遇到不支持的系统会退出

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

write_shell_exports() {
  local shell_rc="$HOME/.zshrc"
  local marker="# Claude local API config"
V
  # Add env vars for local Claude API only if not already present
  if [[ -f "$shell_rc" ]] && grep -q "$marker" "$shell_rc"; then
    echo "Skipped updating $shell_rc (marker already present)"
    return
  fi

  cat >> "$shell_rc" <<'EOF'
# Claude local API config
export ANTHROPIC_BASE_URL="http://localhost:8000"
export ANTHROPIC_AUTH_TOKEN="my-super-secret-password-123"
EOF
  echo "Appended Claude env vars to $shell_rc"
}

case "$(uname -s)" in
  Darwin)  write_config "$HOME/.claude/config.json"; write_shell_exports ;;
  CYGWIN*|MINGW*|MSYS*) write_config "C:\\Users\\Administrator\\.claude\\config.json" ;;
  *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

# 下面是 VS Code 设置示例（Settings.json 内的 claudeCode.environmentVariables）,用于配置 Claude Code for VS Code
# 用于在编辑器中传递本地 Claude API 地址与鉴权，按需复制到设置文件即可
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
