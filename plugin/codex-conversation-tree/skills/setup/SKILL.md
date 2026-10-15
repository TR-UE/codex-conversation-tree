---
name: setup
description: 首次安装对话树插件、检查安装状态或配置本机入口时使用。
---

# 首次设置对话树

本插件只在本机运行。数据默认保存在当前用户桌面的 Codex-Conversation-Tree/data/native。

1. 根据本 SKILL.md 所在目录向上两级找到插件根目录。运行插件根目录下的 `scripts/launch-node.sh`，参数为该根目录下 `server/setup.mjs` 的绝对路径。该脚本通过官方 Codex CLI 安装个人插件来源和 MCP 兼容入口，不覆盖对话记录。
2. 运行同一启动脚本，参数为插件根目录下 `server/cli.mjs` 的绝对路径以及 `doctor`，检查依赖与数据路径。
3. 如果当前会话已经有 open_tree_panel 工具，使用当前真实 threadId 打开并关联当前对话。首次设置也可以通过 conversation-tree Skill 中的 CLI 入口立即打开内置浏览器面板。
4. 说明新插件通常需要用户重启桌面应用并在新会话中加载；不要把这个动作说成已经完成，不自动重启正在使用的 Codex。

不要上传本机数据、发布公共插件、安装其他软件、关联其他聊天，或绕过 hooks 信任与原生删除确认。
