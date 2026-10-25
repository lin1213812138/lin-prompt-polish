# prompt-polish — 提示词优化插件

在你按下发送之前，DeepSeek 总是看不懂你的提示词、于是一次次反复查询？
这个插件会在消息进入主 Agent 之前，先用一次轻量的辅助模型调用，
把你的原始提示词改写成「意图明确、边界清晰、可直接执行」的版本，
再把改写结果交给主 Agent。

## 工作原理

1. 监听 `agent/pre-step`，只处理最后一条 `role: 'user'` 的消息；
2. 长度在 `minLength` 与 `maxLength` 之间、且不是 JSON/路径等结构化内容时，才触发改写；
3. 通过 `ctx.llm.prepareCall()` + `call.stream()` 做一次辅助 LLM 调用；
4. 改写结果替换原消息，交回主 Agent；失败时按 `onError` 策略放行或中止。

## 配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `minLength` | `12` | 原文低于该长度不改写 |
| `maxLength` | `8000` | 原文超过该长度不改写 |
| `timeoutMs` | `60000` | 改写超时（毫秒） |
| `onError` | `keep` | 失败策略：`keep` 原样放行 / `abort` 阻止本轮 |

在 `设置 → 插件 → prompt-polish` 里修改，或直接编辑 `cordis.patch.yml` 的 `config`。

## 验证

随便发一条含糊的中文消息，日志里应出现：

```
prompt-polish: 24 -> 96 chars
```

## 文件

- `index.js` — 插件本体（`inject` / `Config` / `apply`）
- `cordis.patch.yml` — 装载声明
- `locale/{zh,en}.json`、`icon.svg` — 元数据
