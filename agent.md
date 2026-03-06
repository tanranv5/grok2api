# Agent Notes

- 访问 GitHub 超时或执行 GitHub 相关命令前，先执行：`export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=http://127.0.0.1:7890`。
- GitHub 项目优先使用 `gh` 完成仓库信息查看、分支比较、提交查询、PR / Issue 操作等远程交互。
- 纯本地工作区操作（如 `git status`、`git diff`、`git merge`）可继续使用 `git`；涉及 GitHub 远程交互时优先 `gh`。
- 实际代理指令文件以 `AGENTS.md` 为准，本文件为兼容说明。
