# 安装与故障排查

## 安装

在已登录且支持本地插件的 macOS 桌面应用中使用。下载仓库 `dist/` 中的 ZIP 或版本发布页中的安装包；解压后双击 `安装.command`。完成后重启应用，在插件目录找到“对话树”并启用，再在新对话中通过 `@` 选择它。

安装器把插件放到 `~/Desktop/Codex-Conversation-Tree/plugin/`，把数据放到 `~/Desktop/Codex-Conversation-Tree/data/native/`，并合并 `~/.agents/plugins/marketplace.json`。已存在的聊天数据和其他插件条目保留。

本仓库也提供 `.agents/plugins/marketplace.json`，供支持仓库插件目录的宿主加载；ZIP 安装入口已做独立验证。

## 面板与后台

面板在本机回环地址运行，默认端口为 4321。实际调用插件工具后才启动后台。已有对话没有刷新 MCP 工具时，插件 Skill 可以通过包内 CLI 打开面板。

只读检查：

```sh
sh plugin/codex-conversation-tree/scripts/launch-node.sh plugin/codex-conversation-tree/server/cli.mjs doctor
```

## 分支操作

点击新分支节点，右侧“打开分支”旁边有“设为主分支”。已有新提问的分支也可在提问详情顶部的“当前路径”中设置。

已剪分支需要先恢复；已永久删除的原生会话不能恢复或设为主分支。创建分支后直接打开返回的那个会话，无需再次选择“创建聊天分叉”。

## 遇到错误

- 找不到插件：确认安装完成、应用已重启、个人插件目录中的插件已启用。
- 找不到 Node：需要 Node.js 22 或以上；安装器会优先查找桌面应用内置版本。
- 找不到 Codex：确认本机有可执行的 Codex CLI 或应用内置 CLI。
- 原生删除提示占用：先在使用该会话的应用中结束执行并关闭会话，重新预览后重试。插件不会终止其他应用的进程。
- 原生删除提示历史依赖：保留依赖中的会话，或仅剪枝。主分支切换不会改写原生历史来源。

请勿直接删除或修改原生 Codex 的数据库或历史文件来绕过依赖检查。
