# imgen fork 协作约定

## 项目边界

- 本项目是 `lawrencewzen/imgen` 的 MIT fork；保留上游归属，以本地提交区分个人贡献。
- `upstream` 只用于获取第三方更新；只有核实属于 `github.com/geekhuashan/` 的 `origin` 才能作为推送目标。
- 保留 `/Users/huashan/.local/share/imgen` 兼容入口，新的开发命令使用本项目物理路径。

## 修改与验证

- 修改前检查 Git 状态并保留已有工作；提交时只暂存本任务路径。
- `src/` 是实现源码，`dist/` 是需要随源码重新构建的发布产物。行为改动至少运行 `npm test`、`npm run build` 和 `git diff --check`。
- 分开描述编排模型、图片模型、请求被接受和实际图片结果；私有 ChatGPT 后端不回显图片模型时不得声称已验证具体后端。
- 保持 `chatgpt` 兼容路径与 `openai-api` 官方路径相互独立，不因升级一个后端破坏另一个。

## 安全与安装

- 凭据只从既有认证目录或环境变量读取；不写入源码、文档、测试、日志或提交。
- 不使用远程管道脚本覆盖本地 fork。安装和更新从已审阅的本地 checkout 执行。
- 个人技能唯一入口为 `/Users/huashan/.agents/skills/imgen`；技能修改后运行 `/Users/huashan/.local/bin/sync-shared-skills --adopt`。
- 中文提交说明使用“新增 / 优化 / 修复 / 重构 / 文档”等前缀。
