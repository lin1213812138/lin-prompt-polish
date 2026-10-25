/**
 * prompt-polish — 提示词优化插件
 *
 * 在用户消息进入主 Agent 之前，先用一次轻量的辅助 LLM 调用把原始提示词
 * 改写成「意图明确、约束清晰、可直接执行」的版本，再交给主 Agent。
 *
 * 插件形态与 @local/answer-now 完全一致：默认导出是插件模块本体
 * （`inject` / `Config` / `apply`），由 cordis.patch.yml 按名字装载；
 * `apply(ctx, config)` 收到的 ctx 即插件 fiber 的上下文。
 */

import z from '@deepseek-ai/schemastery'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'

const name = 'prompt-polish'

export const inject = ['llm']

export const Config = z.object({
  /** 总开关 */
  enabled: z.boolean().default(true),
  /** 低于该长度的原文不改写（过短的短句通常没有歧义） */
  minLength: z.number().default(12),
  /** 原文超过该长度则跳过改写（避免辅助调用开销过大） */
  maxLength: z.number().default(8000),
  /** 改写超时（毫秒） */
  timeoutMs: z.number().default(60_000),
  /** 改写失败时的策略：keep = 原样放行；abort = 阻止本轮 */
  onError: z.union([z.const('keep'), z.const('abort')]).default('keep'),
})

const REWRITE_SYSTEM = [
  '你是提示词工程专家。用户会给你一段他准备发给编程 Agent 的原始提示词。',
  '你的唯一任务：在**不改变用户意图、不添加用户没有提出的要求**的前提下，把它改写成更清晰的版本。',
  '改写要求：',
  '1. 用用户的同一语言输出（用户写中文就输出中文，写英文就输出英文）。',
  '2. 保留原始需求、对象、目标、约束、验收标准；信息缺失时不要编造，也不要向用户提问。',
  '3. 补足明确的执行要素：目标、范围、步骤/顺序、约束与例外、完成判据；把口语、省略、指代不清的说法写实。',
  '4. 删除寒暄、语气词、重复表述与无关内容。',
  '5. 原文是代码、命令、JSON、路径等结构化内容时，原样保留，不要改写。',
  '6. 控制长度：一般不超过原文 3 倍，且不超过 1200 字。',
  '只输出改写后的提示词正文本身，不要输出解释、不要加引号、不要使用代码块包裹。',
].join('\n')

const humanizeError = (error) => String(error?.message ?? error)

/**
 * Pick the provider/model route for the auxiliary call: an explicitly configured
 * route wins, otherwise reuse the latest logged request, then the agent options.
 */
function resolveRoute(agent) {
  const latest = agent?.session?.requestHeader?.()?.config
  if (latest?.provider && latest?.model) {
    return { provider: latest.provider, model: latest.model }
  }
  const provider = agent?.options?.provider
  const model = agent?.options?.model
  if (provider && model) return { provider, model }
  return undefined
}

async function polish(ctx, agent, text, signal) {
  const route = resolveRoute(agent)
  if (!route) throw new Error('no provider/model route is available for prompt-polish')
  const call = await ctx.llm.prepareCall(route, signal)
  const options = {
    ...call.config,
    messages: [{ role: 'user', content: text }],
    system: REWRITE_SYSTEM,
    signal,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of call.stream(options)) assembler.push(chunk)
  if (assembler.finish?.kind === 'error' || assembler.finish?.kind === 'aborted') {
    throw new Error(assembler.finish.failure?.message || 'prompt-polish stream failed')
  }
  return textFromBlocks(assembler.blocks()).trim()
}

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function extractText(message) {
  const { content } = message
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('\n')
      .trim()
  }
  return ''
}

function looksStructured(text) {
  const t = text.trimStart()
  if (/^[{[\]"]/.test(t)) return true // JSON / 数组
  if (/^[A-Za-z]:\\|\/\w/.test(t) && t.length < 200) return true // 纯路径
  return false
}

function apply(ctx, config) {
  const cfg = { enabled: true, minLength: 12, maxLength: 8000, timeoutMs: 60_000, onError: 'keep', ...config }
  const state = { inFlight: new Set() }

  ctx.on('agent/pre-step', async (params, next) => {
    // This listener wraps the decision instead of owning it, so every path must
    // return next()'s result: a waterfall listener that returns undefined makes
    // the loop read `.kind` off undefined.
    const decision = await next()
    if (!cfg.enabled) return decision
    const { agent, messages, signal } = params
    if (!agent || !Array.isArray(messages) || !messages.length) return decision
    if (decision?.kind !== 'enter') return decision
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'user') return decision
    const text = extractText(last)
    if (!text) return decision
    if (text.length < cfg.minLength || text.length > cfg.maxLength) return decision
    if (looksStructured(text)) return decision
    if (state.inFlight.has(text)) return decision

    state.inFlight.add(text)
    let rewritten
    try {
      rewritten = await polish(ctx, agent, text, signal)
    } catch (error) {
      if (cfg.onError === 'abort') {
        ctx.logger.warn('prompt-polish rewrite failed, aborting turn: ' + humanizeError(error))
        return { kind: 'reject' }
      }
      ctx.logger.warn('prompt-polish rewrite failed, passthrough: ' + humanizeError(error))
      return decision
    } finally {
      state.inFlight.delete(text)
    }
    if (!rewritten || rewritten === text) return decision
    ctx.logger.info(`prompt-polish: ${text.length} -> ${rewritten.length} chars`)

    // Keep the downstream decision's message identities and ordering; only the
    // last user message's text is replaced.
    const entered = decision.messages.slice()
    const index = entered.findLastIndex((message) => message.id === last.id)
    if (index === -1) return decision
    const content = Array.isArray(entered[index].content)
      ? entered[index].content.flatMap((part) =>
          part?.type === 'text' ? [{ ...part, text: rewritten }] : [part],
        )
      : [{ type: 'text', text: rewritten }]
    entered[index] = { ...entered[index], content }
    return { ...decision, messages: entered }
  })
}

export { apply, name }
