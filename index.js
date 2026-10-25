/**
 * prompt-polish — manual prompt optimizer (Host half)
 *
 * Registers a /polish <text> command. The handler runs one auxiliary LLM call
 * that rewrites the raw prompt into a clear, executable version and returns it
 * as the command result text. The Client half (client.js) renders a composer
 * button that reads the draft, runs this command, and writes the result back.
 *
 * No automatic rewriting: the model never sees a changed prompt unless the
 * user pressed the button.
 */

import z from '@deepseek-ai/schemastery'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'

const name = 'prompt-polish'

export const inject = ['llm', 'agentDefaultModel']

export const Config = z.object({
  /** Rewrite is skipped below this length (short prompts rarely need it). */
  minLength: z.number().default(2),
  /** Rewrite is skipped above this length to bound the auxiliary call. */
  maxLength: z.number().default(8000),
  /** Hard deadline for the auxiliary call, in milliseconds. */
  timeoutMs: z.number().default(60000),
  /** Prefer a fast model for the auxiliary call when set. Leave empty to reuse your currently selected model (provider "magpie" safe default). */
  fastModel: z.string().default(''),
})

const REWRITE_SYSTEM = [
  '把用户的原始提示词改写为清晰可执行的版本。',
  '同一语言输出；保留全部需求与约束，缺失信息不编造、不提问；',
  '补上目标、范围、步骤、约束、完成判据；删寒暄与重复；',
  '代码/命令/JSON/路径原样保留。',
  '只输出改写后的正文，不要解释、引号或代码块。',
  '长度不超过 120 字，越短越好。',
].join('\n')

const humanizeError = (error) => String(error?.message ?? error)

/**
 * Pick the provider/model route for the auxiliary call: the latest logged
 * request first (it reflects what this session actually uses), then agent
 * options, then the configured default selection.
 *
 * If `fastModel` is configured, swap only the model id while keeping the
 * provider discovered above, so the rewrite runs on a cheap/fast model instead
 * of following the user's (possibly reasoning) session model.
 */
let activeCfg = {}
function resolveRoute(ctx, agent) {
  let route
  const latest = agent?.session?.requestHeader?.()?.config
  if (latest?.provider && latest?.model) route = { provider: latest.provider, model: latest.model }
  else if (agent?.options?.provider && agent?.options?.model) {
    route = { provider: agent.options.provider, model: agent.options.model }
  } else {
    const selection = ctx.agentDefaultModel?.currentSelection?.()
    if (selection?.provider && selection?.model) route = { provider: selection.provider, model: selection.model }
  }
  if (!route && typeof ctx.llm?.defaultRoute === 'function') {
    const fallback = ctx.llm.defaultRoute()
    if (fallback?.provider && fallback?.model) route = fallback
  }
  if (route && activeCfg.fastModel) route = { ...route, model: activeCfg.fastModel }
  return route
}

async function polish(ctx, agent, text, signal, onDelta) {
  const route = resolveRoute(ctx, agent)
  if (!route) throw new Error('prompt-polish: no provider/model route is available')
  // The provider validates message content as an ARRAY of blocks (it calls
  // content.some(...)); a plain string content throws. Try the block form
  // first, then fall back to a string for providers that require that.
  // A prepared call can only be dispatched once, so prepare a fresh call in
  // each attempt.
  const shapes = [
    { messages: [{ role: 'user', content: [{ type: 'text', text }] }] },
    { messages: [{ role: 'user', content: text }] },
  ]
  let lastError = null
  for (const shape of shapes) {
    try {
      const call = await ctx.llm.prepareCall(route, signal)
      const options = { ...call.config, system: REWRITE_SYSTEM, signal, ...shape }
      const assembler = new BlockAssembler()
      let emitted = ''
      for await (const chunk of call.stream(options)) {
        assembler.push(chunk)
        // Stream partial text to the caller so the draft updates live instead
        // of only at the end.
        if (onDelta) {
          const full = textFromBlocks(assembler.blocks())
          if (full.length > emitted.length) {
            emitted = full
            onDelta(full)
          }
        }
      }
      if (assembler.finish?.kind === 'error' || assembler.finish?.kind === 'aborted') {
        throw new Error(assembler.finish.failure?.message || 'prompt-polish stream failed')
      }
      return textFromBlocks(assembler.blocks()).trim()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('prompt-polish: stream failed')
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function apply(ctx, config) {
  const cfg = { minLength: 2, maxLength: 8000, timeoutMs: 30000, fastModel: '', ...config }
  activeCfg = cfg
  ctx.logger.info('prompt-polish: apply() 已执行')

  // (Command registration removed: it threw `content.some is not a function`
  // at load time, and the composer button never used it — it POSTs here.)

  // HTTP endpoint for the composer button: the Client half cannot call the LLM
  // itself, so it POSTs the draft here and gets the rewritten text back, then
  // writes it into the draft in place (no message is ever sent).
  const endpoint = async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, CORS_HEADERS)
      res.end()
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    let text = ''
    try {
      text = String((JSON.parse(body) || {}).text ?? '').trim()
    } catch {
      text = ''
    }
    if (!text) {
      json(res, 400, { error: 'empty text' })
      return
    }
    // Stream the rewrite as SSE so the draft fills in progressively — total
    // generation time is unchanged, but the user sees text appear immediately
    // instead of waiting for the whole result.
    res.writeHead(200, {
      ...CORS_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const signal = AbortSignal.timeout(cfg.timeoutMs)
    try {
      await Promise.race([
        polish(ctx, undefined, text, signal, (partial) => {
          res.write('data: ' + JSON.stringify({ partial }) + '\n\n')
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout after ' + cfg.timeoutMs + 'ms')), cfg.timeoutMs),
        ),
      ])
      res.write('event: done\ndata: {}\n\n')
    } catch (error) {
      res.write('event: error\ndata: ' + JSON.stringify({ error: humanizeError(error) }) + '\n\n')
    } finally {
      res.end()
    }
  }

  // Several register() shapes have been seen across versions; try each and keep
  // the first that loads. Wrapped in try/catch so a shape mismatch logs instead
  // of taking the whole plugin down at load time.
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const server = webCtx.reflect.get('webServer')
      if (!server || typeof server.register !== 'function') {
        ctx.logger.warn('prompt-polish: webServer unavailable; the polish button will not work')
        return
      }
      const PATH = '/plugins/lin-prompt-polish/polish'
      const attempts = [
        () => server.register({ kind: 'prefix', path: PATH, handler: endpoint }),
        () => server.register({ kind: 'exact', path: PATH, handler: endpoint }),
        () => server.register({ path: PATH, handler: endpoint }),
        () => server.register(PATH, endpoint),
      ]
      for (const attempt of attempts) {
        try {
          const dispose = attempt()
          if (dispose && typeof dispose === 'function') {
            webCtx.effect(() => dispose, 'prompt-polish: polish endpoint')
          }
          ctx.logger.info('prompt-polish: endpoint registered')
          return
        } catch (error) {
          ctx.logger.warn('prompt-polish: register shape failed: ' + humanizeError(error))
        }
      }
      ctx.logger.warn('prompt-polish: no register() shape worked')
    })
  } catch (error) {
    ctx.logger.warn('prompt-polish: webServer block failed: ' + humanizeError(error))
  }
}

export { apply, name }
