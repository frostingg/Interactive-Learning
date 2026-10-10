# 题内问答 · Interactive Learning

把十多道题放进一张互动答题板：每道题下面都有追问框，完整解答写回这一题的区域。

**v0.3.0 使用当前 ChatGPT 会话生成初次答案和追问答案。插件后端只保存题板与追问，不调用独立模型 API，不需要 API 密钥。生成答案使用 ChatGPT 的正常用量，仍受你的套餐、账户和模式限制。** 部署与实际宿主测试状态见 [验证记录](VERIFICATION.md)，源码和离线演示不代表已经接入成功。

个人私有插件已部署：[题内问答](https://chatgpt.com/plugins/plugin_asdk_app_sites_9d45976b1cb48191b1cad4d004c26d2c)。插件系统报告已安装到创建者账户。生产表 qa_boards 已创建；当前正在进行的宿主对话没有暴露新插件工具，真实 Chat / Work 点击追问与模型写回仍待实测。打开插件入口后在需要时选择它，输入“把这些题做成互动答题板”。

源码仓库：[frostingg/Interactive-Learning](https://github.com/frostingg/Interactive-Learning)。

## 按需使用

1. 在支持插件与 MCP App 界面的 ChatGPT 客户端安装并连接“题内问答”。在需要时选择或 @ 提及它，也可以明确说：“把下面的问题做成互动答题板。”
2. ChatGPT 先完成各题答案，再显示一张题板。一次支持 1–30 道题；超过上限分组展示。
3. 在不明白的题目里点击“在这里追问”，输入疑问。也可以选中本题的一段文字，把它加入追问。
4. 当前 ChatGPT 会话处理追问后，完整解答保存并显示在原题下方。其他题目继续留在原位。

普通问答、普通多题问题不会自动启用此工作流。你明确说“此会话以后使用互动模式”时，才持续用于当前会话；说“退出互动模式”即可停止。插件不会替换所有原生聊天回复。

此路线面向 Chat 和 Work 中能够加载该插件工具、显示组件并接收组件消息的会话。实际可用入口、权限提示和界面行为取决于账户及客户端，网页与桌面、Chat 与 Work 需要分别验证。

## 追问怎样回到原题

首次答案由当前 ChatGPT 模型准备，通过 `create_board` 保存并展示。题内追问使用以下流程：

```text
原题卡片提交追问
  → ask_card 保存待处理请求
  → 组件向当前 ChatGPT 会话发送处理提示
  → get_card_request 读取本题及其追问历史
  → 当前 ChatGPT 模型生成解答
  → submit_card_answer 保存到原题
  → 原组件轮询 get_card_request，显示新增解答
```

组件使用 MCP Apps `ui/message`，或宿主提供的 `sendFollowUpMessage`（请求 `scrollToBottom: false`），让当前会话处理待答请求。**主聊天可能出现一次处理轮次、简短确认或工具记录，不能保证完全隐藏。** 完整解释写入原题卡片，工作流要求主聊天只作简短确认，不创建新的题板组件。宿主不支持组件消息时，题内追问不能完成真实解答。

每道题有独立 ID 与追问历史。`get_card_request` 只返回指定题目的内容；原答案也需由当前模型核对。后端按用户身份隔离记录，使用并发保存与请求 ID 去重。失败时界面保留输入，可重试同一次追问；已完成的请求不重复生成。临时输入与折叠状态保存在 widget state，正式题板保存在服务端。

## 个人私有部署与连接

使用 Sites 的个人私有托管边界部署同一个服务与 MCP App：

- Worker 提供 `/mcp`，部署清单声明 `mcp` 能力与逻辑 D1 绑定 `DB`。
- `db/schema.ts` 是表结构源文件，`drizzle/` 保存生成的 SQL、snapshot 与 journal；构建将迁移和托管清单放入部署产物。
- 后端仅信任 Sites 认证边界注入的 `oai-authenticated-user-id`，每次读取和写入都检查记录归属。服务访问凭证不能替代用户身份。
- Sites 发布后提供对应的私有插件。使用同一个插件安装或连接，按需选择；不要另外创建重复插件。连接成功后先调用只读 `service_status`，再验证真实题板流程。

本路线没有独立模型 API 配置步骤，也不会读取或复用 ChatGPT 的登录凭证来请求外部推理服务。Sites 插件是否支持附带并保留 skill 文件，需要通过实际编辑与发布能力核对；MCP 工具说明也包含该工作流。GitHub 保存源代码，安装连接由 ChatGPT 与 Sites 完成。

自托管时需要另行实现受支持的鉴权边界。不能直接把开发服务器发布到互联网，也不能把任意客户端传来的身份头当作登录身份。

## 离线演示

打开 `public/demo.html` 可查看 12 道题的自包含演示。**所有演示答复均为预设内容，不由 AI 根据追问生成**；演示不访问模型，也不保存真实学习记录。

## 本地开发

Node.js 22 及以上。运行服务与核心测试无需模型密钥；数据库迁移生成需要项目中的开发依赖。

```sh
node --test
node scripts/build.mjs
node src/local.mjs
```

浏览器打开 `http://127.0.0.1:8787/`，本地 MCP 地址为 `http://127.0.0.1:8787/mcp`。服务只绑定回环地址，开发身份为 `local-user`，记录写入忽略提交的 `.local-data/boards.json`。首页是预设演示；真实 widget 需要兼容宿主通过 `create_board` 加载，完成追问还需要宿主读取请求并写回答案。

修改表结构后使用已安装的开发依赖运行 `npm run db:generate`，检查生成迁移后按 Sites 流程发布。不要在请求处理中创建表或改动已应用的迁移。

## 主要文件

```text
plugin.json                 插件源码清单
skills/inline-qa/SKILL.md    按需启用与原题写回工作流
public/widget.html          MCP App 题卡组件
public/demo.html            预设答复演示
src/core.mjs                MCP 与待答请求、写回流程
src/store.mjs               测试存储和 D1 存储
src/local.mjs               回环开发服务与文件持久化
src/worker.mjs              Sites 认证边界后的入口
db/schema.ts                D1 表结构
drizzle/                    生成的 SQL 与迁移元数据
scripts/build.mjs           Worker 与部署产物构建
test/core.test.mjs          核心行为检查
```

## 官方参考

- [Skill 的职责](https://developers.openai.com/plugins/concepts/skills)
- [互动 UI 与工具调用](https://developers.openai.com/plugins/build/chatgpt-ui)
- [组件桥接与状态](https://developers.openai.com/plugins/reference)
- [插件连接与测试](https://developers.openai.com/plugins/quickstart)