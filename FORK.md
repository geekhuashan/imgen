# Fork 维护说明

## 来源与基线

- 上游：`https://github.com/lawrencewzen/imgen.git`
- 初始基线：`fbbb725d929d6945a0f42600d9f2f9eb0473e2eb`
- 许可：MIT
- 本地物理路径：`/Users/huashan/Documents/AI for development/10-软件项目/imgen`
- 兼容入口：`/Users/huashan/.local/share/imgen`

本仓库继承上游历史，不把第三方代码描述为本人原创。个人贡献以基线之后的提交和本文件记录为准。

## 本地增强

1. 编排模型推理等级可配置（仅 `openai-api` 下发，原因见下方“后端行为变化”）。
2. 瞬时失败重试次数可控，并支持脱敏 SSE 结构诊断。
3. 图片模型与编排模型分离，支持 GPT Image 2.5 Sunburst/Flare。
4. 新增 OpenAI 官方 Responses API 后端；Key 只从环境变量读取。
5. 安装流程失败关闭，不再通过远程脚本删除本地 fork。

GPT Image 2.5 的模型名与能力以 OpenAI 官方文档为准：[Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)、[Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare) 和 [图像生成指南](https://developers.openai.com/api/docs/guides/image-generation)。

## 后端行为变化

- 2026-11-05（Hermes 诊断记录里最后一次出图在 11-04 21:17，11-05 07:00 起失败）：ChatGPT Codex 后端把请求里显式的 `reasoning.effort` 当作图片工具的 `complexity`，返回 `image_generation_user_error`（`param: complexity`）。响应回显的图片模型固定为 `gpt-image-2-codex`，`none`、`low`、`medium`、`max` 都被拒；工具字段写 `complexity` 同样被拒，写 `auto` 直接 400。与编排模型、`--image-model`、尺寸和质量无关。
- 因此 `chatgpt` 与 `cliproxy`（含 Magpie 网关）不再发送 `reasoning`，由服务端用编排模型默认值（`gpt-5.6-luna` 回显为 `medium`），`--reasoning-effort` 在这两个后端不生效。`openai-api` 未实测，保持原样。后端修好后可再评估恢复。
- 订阅额度调不到 GPT Image 2.5/2.6（2026-11-05 用 Plus 账号实测，直连和 Magpie 结果相同）：`tools[0].model` 写 2.5、2.6 甚至不存在的名字都会成功，回显一律是 `gpt-image-2-codex`；顶层 `model` 写图片模型返回 400（不支持 ChatGPT 账号）；模型目录里没有图片模型。Codex 后端的 `images/generations` 同样接受不存在的模型名，还忽略 `complexity`、`output_format: svg` 和 `size`，且不回显模型。
- 官方文档：2.5 可作 Responses 图片工具的模型，现有 `openai-api` 后端可用；2.6 只支持 `v1/images/generations` 和 `v1/images/edits`，不支持 Responses，接入要给 `openai-api` 增加 Image API 路径。两者都按量付费，尚未实测。

## 远端约定

- `upstream`：第三方维护者仓库，只 fetch，不 push。
- `origin`：仅在创建并核实 `github.com/geekhuashan/imgen` 后添加。
- 未配置本人 `origin` 时保持无推送目标；不得把 upstream 临时改成 origin 后发布。

## 同步上游

同步前先确认工作区干净并通过测试：

```bash
git status --short
npm test
npm run build
git fetch upstream
git log --oneline --left-right main...upstream/main
```

先阅读上游差异，再在单独分支合并或变基；不对含本地改动的工作区直接运行覆盖式安装、强制重置或自动合并。解决冲突后重新运行测试、构建、CLI 帮助和最小出图验证。

## 发布边界

- 发布前安装并保留本地 Git 隐私防护。
- 只推送到现场核实属于 `geekhuashan` 的精确 HTTPS 远端。
- 不提交 API Key、OAuth token、账户文件、图片输入原件、生成结果或诊断中的图片 Base64。
- ChatGPT 后端未回显实际图片模型时，不把成功响应写成 GPT Image 2.5 的消费端证明。
