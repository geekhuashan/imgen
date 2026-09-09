# imgen · Huashan fork

一个面向命令行与 AI Skill 的图片生成/编辑工具，支持文生图、图生图、透明背景和最高 4K 输出。

本仓库基于 [lawrencewzen/imgen](https://github.com/lawrencewzen/imgen) 的 MIT 许可代码维护。当前是本地开发 fork；个人 GitHub 远端尚未创建，因此没有把第三方上游误设为可推送的 `origin`。来源、基线与同步方式见 [FORK.md](FORK.md)。

## ✨ Features

- 🖼️ **文生图 & 图生图** — 一条命令，从文字生成图片或修改已有图片
- 🔑 **两种认证路径** — 可复用 Codex 登录，也可通过 OpenAI API Key 明确选择图片模型
- 📐 **最高 4K 分辨率** — 支持到 3840×2160（4K UHD）
- 🪟 **透明背景** — 一键输出透明 PNG，适合做图标、贴纸
- 🤖 **原生 AI Skill** — 在 Claude Code / Codex / Gemini CLI 里直接说"帮我画一张……"即可触发
- ⚡ **直出本地文件** — 图片直接写盘，无中间云端上传
- 🧭 **模型职责分离** — 编排模型和实际图片模型使用不同参数，避免误判后端
- 🩺 **可审计诊断** — 支持重试控制和不保存图片 Base64 的 SSE 摘要

## 📦 安装

需要 Node.js 20 或更高版本。请先克隆或打开已审阅的 checkout，再从仓库内运行安装脚本；本 fork 不支持会覆盖现有目录的 `curl | bash` 或 `irm | iex` 安装。

在已审阅 checkout 的仓库根目录运行：

```bash
./install-skill.sh
```

个人 GitHub fork 创建后，才使用它的已核实地址克隆新的工作副本。

尚未创建个人 GitHub fork 时，可直接在当前本地仓库执行：

```bash
npm ci
npm test
npm run build
npm link
```

macOS/Linux 安装脚本会把个人技能入口安装到 `~/.agents/skills/imgen` 后同步共享技能；Windows 使用 `install-skill.ps1`。

## 🚀 用法

```
imgen [options] <prompt>

  -i, --image <path...>   输入图（图生图，1~5 张）
  -o, --out <path>        输出路径（默认 ./image-<时间戳>.png）
  -n, --count <num>       生成数量
  -s, --size <size>       尺寸，如 1024x1024 / 1024x1536 / 3840x2160
  -q, --quality <q>       low | medium | high | xhigh | max | auto
  -b, --background <bg>   transparent | opaque | auto
  -m, --model <model>     编排模型（负责调用图片工具）
  --image-model <model>   图片模型（如 gpt-image-2.5-sunburst / flare）
  --backend <backend>     chatgpt（订阅额度）| openai-api（官方 API Key）
```

## 💡 示例

```bash
# 文生图
imgen "a red fox in snow" -o fox.png

# 图生图
imgen "make it night, neon lights" -i fox.png -o fox-night.png

# 官方 API：2.5 Sunburst 4K 最终图（需 OPENAI_API_KEY）
imgen "a nebula wallpaper" --backend openai-api --image-model gpt-image-2.5-sunburst -s 3840x2160 -q max -o nebula.png

# 官方 API：2.5 Flare 快速日常出图
imgen "a clean editorial illustration" --backend openai-api --image-model gpt-image-2.5-flare -q low -o draft.png

# 透明贴纸
imgen "a cute cat sticker" -b transparent -o cat.png
```

`chatgpt` 后端复用 ChatGPT/Codex 登录与订阅额度，但不回显实际图片后端；要明确、可验证地指定 GPT Image 2.5，请使用 `openai-api` 后端。API 模式从环境变量读取 `OPENAI_API_KEY`，不会把 Key 写入命令行参数或配置文件。

输入图片会发送到所选 OpenAI 后端处理；“直出本地文件”只表示结果不经过额外的第三方存储服务。

官方能力说明：[GPT Image 2.5 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst) · [GPT Image 2.5 Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare) · [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation)

## 🤖 AI Skill 用法

安装后，在支持 Skill 的 AI 工具里直接用自然语言触发，无需记命令：

| 工具 | 说一句话 |
|------|---------|
| Claude Code | "帮我画一张雪地里的狐狸" |
| Codex | "生成一个透明背景的 logo" |
| Gemini CLI | "把这张图改成赛博朋克风" |

## 🛠️ 开发与验证

```bash
npm test
npm run build
git diff --check
```

`src/` 是实现源码，`dist/` 是随源码重新构建的发布产物。测试只证明客户端请求、解析和错误处理；账户权限、服务运行状态及真实出图结果需要分别验证。上游同步和发布边界见 [FORK.md](FORK.md)。

## 📄 License

MIT。原项目版权与许可见 [LICENSE](LICENSE)，本 fork 保留原作者归属。
