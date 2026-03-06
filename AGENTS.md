# Repository Agent Notes

## Language

- 默认使用中文回复用户，除非用户明确要求其他语言。

## GitHub / Network

- 访问 GitHub 超时或执行 GitHub 相关命令前，先导出代理环境变量：
  `export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=http://127.0.0.1:7890`
- 只要任务对象是 GitHub 项目，优先使用 `gh` 完成仓库信息查看、分支比较、提交查询、PR / Issue 操作等 GitHub 交互。
- 纯本地工作区操作，例如 `git status`、`git diff`、`git merge`、`git rebase`，可以继续使用 `git`；但只要涉及 GitHub 远程交互，优先选择 `gh`。
