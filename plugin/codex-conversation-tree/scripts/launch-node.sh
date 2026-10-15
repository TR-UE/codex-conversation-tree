#!/bin/sh
set -eu
tree_path_node=$(command -v node 2>/dev/null || true)
tree_resources=${CODEX_ELECTRON_RESOURCES_PATH:-/Applications/ChatGPT.app/Contents/Resources}
for tree_node in \
  "${TREE_NODE_BINARY:-}" \
  "${CODEX_MCP_NODE_PATH:-}" \
  "${CODEX_BROWSER_USE_NODE_PATH:-}" \
  "$tree_resources/cua_node/bin/node" \
  "${HOME:-}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
  "$tree_path_node" \
  "${HOME:-}"/.nvm/versions/node/*/bin/node \
  /opt/homebrew/bin/node /usr/local/bin/node
do
  if [ -n "$tree_node" ] && [ -x "$tree_node" ] && "$tree_node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
    exec "$tree_node" "$@"
  fi
done
printf '%s\n' '对话树需要 Node.js 22 或更新版本；未找到 Codex 内置或本机 Node 运行时。' >&2
exit 127
