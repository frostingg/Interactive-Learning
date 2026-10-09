# 题内问答 · Interactive Learning

把十多道题放进一张互动答题板：每道题下面都有追问框，新的解答追加在这一题的区域，其他题目保持位置。

**当前版本是源码 MVP。已实现服务端、题卡界面和可离线运行的交互演示；尚未部署或在 ChatGPT 中安装验证。演示使用明确标注的预设答复。真实局部 AI 需要配置服务端模型。**

## 能做到什么

- ChatGPT 首次回答一组题目时，通过 `create_board` 展示一个嵌入式题目列表。
- 卡片直接调用 `ask_card`，后端生成解答，界面仅在当前题下追加。
- 每个问题拥有独立 ID 与历史；追问时只发送本题内容。
- 用户身份隔离，乐观并发保存，重复请求复用，失败后保留输入。
- 输入、折叠等临时状态使用 widget state；真实内容保存到服务端。
- 卡片内选中文字后，可把它加入本题追问。

## 能力边界

Skill 是工作流指令，不能接管 ChatGPT 的所有原生回复。此项目通过 MCP App 展示互动答题板，**不会修改宿主旧消息**，也没有“安装后所有对话强制变成卡片”的接口。

默认题内追问不调用 `ui/message` 或 `sendFollowUpMessage`，因此不主动生成一条主聊天消息。宿主仍可能显示工具活动、权限提示等系统行为，需要在实际 ChatGPT 账户和客户端验证。插件使用入口与支持的模式取决于账户和客户端；官方 quickstart 当前通过 ChatGPT Work 连接测试。

GitHub 托管源代码不等于 ChatGPT 插件已经上线。当前 `plugin.json` 是工作流的源清单；尚无已验证的远程 MCP 地址，仓库不包含假的 `mcp.json`。仅安装此 skill 不会启用交互。

## 看演示

直接打开 `public/demo.html`。它自包含、无需依赖或密钥，展示 12 道题，可在各题内追加“预设示例解答”。演示不访问模型，也不保存真实学习内容。

## 本地开发

Node.js 22 及以上；没有第三方运行依赖。

```sh
node --test
node scripts/build.mjs
node src/local.mjs
```

浏览器打开 `http://127.0.0.1:8787/`。本地 MCP 地址为 `http://127.0.0.1:8787/mcp`。服务仅绑定回环地址，持久数据写入忽略提交的 `.local-data/boards.json`，开发模式使用独立的 `local-user` 身份。**不要把此开发服务直接发布到互联网或把客户端提供的身份头当作可信登录。**

真实生成需在启动进程的服务器环境中配置 `OPENAI_API_KEY` 和 `OPENAI_MODEL`。模型应选用你项目可访问且支持 Responses API 的模型。当前代码不会自动读取 `.env`；可以用 Node `--env-file=.env` 或系统环境变量。密钥只在后端使用，不填到题卡、GitHub 或普通聊天消息里。独立 API 请求按所配置项目的计费方式执行。

本地首页仍是明确标注的预设演示。真实 widget 由 MCP 客户端调用 `create_board` 后加载，不会偷偷将演示切换成真实生成。

## ChatGPT 服务与连接

优先使用 Sites 的私有托管边界：

1. `src/worker.mjs` 导出 Worker `fetch(request, env)`；运行 build 后入口为 `dist/server/index.js`。它只信任 Sites 认证边界提供的 `oai-authenticated-user-id`。
2. 通过 Sites 受支持的构建/存储流程声明 MCP 与逻辑 D1 绑定 `DB`。按其迁移流程生成/应用 `db/0001.sql` 对应的表，不在运行时创建表。当前仓库未注册 Site，未包含生产 Site ID。
3. 在托管服务端配置模型和密钥。使用独立模型 API 的局部回答已实现；ChatGPT plan 的专用 OAuth 推理路径是未来可选项，**当前未实现**，不能拿现有 ChatGPT/Codex 登录凭证直接复用。
4. 在受支持的 ChatGPT 插件界面连接已部署的 HTTPS `/mcp`，使用 Sites 创建的同一个私有插件，不额外创建重复插件。将 skill 通过支持保留技能的插件编辑方式加入；该能力需对实际插件验证。
5. 真实测试：创建题板 → 第二题追问 → 检查第二题内部出现解答 → 第一题不变 → 刷新恢复 → 主聊天未收到追问消息。网页和桌面应用分别验证。

也可以自托管，但必须先实现受支持的 OAuth/鉴权边界，服务器不能信任任意浏览器发送的 `oai-authenticated-user-id`。默认 Worker 不应暴露于允许伪造身份头的公开源。

## 目录

```text
plugin.json
skills/inline-qa/SKILL.md
public/widget.html      真正的 MCP App 题卡
public/demo.html        自包含预设演示
src/core.mjs            MCP、题目工作流、模型适配
src/store.mjs           内存测试存储和 D1 存储
src/local.mjs           回环开发服务与文件持久化
src/worker.mjs          认证边界后的托管入口
db/0001.sql             生产表结构
scripts/build.mjs      零依赖 Worker 打包
test/core.test.mjs
```

## 已验证和待验证

- 自动测试：逐题与逐用户隔离、并发不同题保存、重复请求、失败后重试、模型请求上下文、MCP 协议与资源。
- 静态演示：另见 `VERIFICATION.md` 的实际运行结果。
- 未验证：真实 OpenAI 请求、生产 D1、Sites 发布、ChatGPT 安装和网页/桌面宿主行为。

## 官方参考

- [Skill 的职责](https://developers.openai.com/plugins/concepts/skills)
- [互动 UI 与工具调用](https://developers.openai.com/plugins/build/chatgpt-ui)
- [Widget bridge](https://developers.openai.com/plugins/reference)
- [插件连接 quickstart](https://developers.openai.com/plugins/quickstart)
- [可选 ChatGPT plan 推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

此仓库不含 API 密钥、生产学习记录或账号登录凭证。
