# prompt-polish (lin-prompt-polish)

在 DeepSeek Harness 输入框左侧加一个 **✨ 润色** 按钮：点一下，用一次辅助 LLM 调用把当前草稿改写成更清晰、可执行的提示词，并**就地替换**到输入框（绝不自动发送）。

> Button-only：只在你点按钮时改写，不会自动改写、也不会替你发送消息。

## 功能

- 输入框左侧出现 **✨ 润色** 胶囊按钮（跟随主题色，浅色/深色自适应）。
- 点击后读取当前草稿 → 调用一次辅助 LLM → 把结果**就地写回**输入框，草稿被替换但不发送。
- 流式写入：模型吐第一个字就开始替换，输入框里文字逐字生长。
- 失败/超时会在按钮上显示提示（⚠ / 失败: …），不会静默卡死。

## 工作原理

1. 客户端在 `conversation.input.left` 插槽注册按钮。
2. 点击时读取编辑器里的草稿文本。
3. `POST /plugins/lin-prompt-polish/polish` 把草稿发给宿主端。
4. 宿主端用 `ctx.llm` 准备一次调用（复用你当前选中的模型），流式拼装结果并以 SSE 增量返回。
5. 客户端逐帧把增量写回输入框并触发 React 更新。

## 配置（插件设置）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `minLength` | 2 | 草稿短于此长度不润色 |
| `maxLength` | 8000 | 草稿长于此长度不润色 |
| `timeoutMs` | 15000 | 单次润色硬超时（毫秒） |
| `fastModel` | 空 | 留空=复用当前选中模型；填入 provider 上真实存在的模型 id 可换更快的模型 |

## 安装

从 npm（预构建，无需构建步骤）：

```sh
dsh plugin --profile desktop add lin-prompt-polish
```

或从 GitHub 源码安装：

```sh
dsh plugin --profile desktop add https://github.com/lin1213812138/lin-prompt-polish
```

安装后重启 `dsh web`（或刷新页面）即可。

## 需求

DSH ≥ 0.2.0。

## 许可证

MIT

---

### 发布说明（维护者）

本包通过本地 `file:` 链接在开发中安装。要上架到市场（如 `dshmarket`），需打包并发布：

1. 确保 `package.json` 的 `name` / `version` / `description` / `keywords` / `license` / `files` 完整（已对齐 `lin-answer-now` 的发布结构，含 `author` / `repository` / `homepage` / `bugs`）。
2. `npm pack` 生成 tgz，或直接 `npm publish` 推到 npm 后由市场收录。
3. 按对应市场的提交流程发布（含 README、图标、版本号）。

> 注意：`dsh.client` 的 `immediately: true` 与 `conversation.input.left` 插槽注册均已在当前版本验证可用。
