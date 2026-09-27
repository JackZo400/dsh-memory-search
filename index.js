/**
 * dsh-memory-search —— 把一堆 markdown 笔记做成 Agent「想得起来」的长期记忆。
 *
 * 两路召回：本地 embedding（node-llama-cpp）管「意思」，SQLite FTS5（中文 bigram）
 * 管「原话」，RRF 融合。语料是磁盘上的 markdown，不是数据库 ——
 * 笔记你随时能自己改，索引跟着文件走（改了哪篇，下次同步只重切那篇）。
 *
 * 两个出口：
 *   · memory_search 工具 —— Agent 需要的时候自己去查
 *   · 自动召回 —— 每轮按用户消息捞几条，塞进系统提示（不进对话记录）
 *
 * 安全（可选）：语料可以分密级（public / personal / secret 三种文件名），
 * 按会话通道过滤 —— 群聊只可能召回 public。不配通道映射就不过滤（单人场景最好用）；
 * 配了映射却判不出通道时**不召回**（fail closed）。
 * @module dsh-memory-search
 */

import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Index } from './src/store.js'
import { Recaller, syncIndex, backfillVectors, formatHits, levelOf } from './src/recall.js'
import { loadEmbedder, embedderReady, disposeEmbedder, setQueryInstruction } from './src/embed.js'

/** Cordis 插件名。 */
export const name = 'dsh-memory-search'

/** 需要的能力：注册工具、往系统提示里塞上下文。 */
export const inject = ['tools', 'systemPrompt']

const DEFAULTS = {
  // 索引库落在哪。相对路径按「dsh 的工作目录」算。
  dbPath: '.dsh-memory/index.db',
  // 本地嵌入模型（GGUF）。**留空 = 不启用向量**，只跑关键词那一路（见 README「不装模型也能用」）。
  modelPath: '',
  // 语料根目录：递归收集里面的 .md。至少配一个，否则索引是空的（日志会提醒）。
  roots: [],
  // 通道映射文件（可选）。配了才按密级过滤，格式见 README「密级」。
  // 形如 { "<会话 key>": { "sessionId": "<session id>" } }。
  sessionMap: '',
  // 主人 id 列表：只有配上 sessionMap 才有意义（用来把某些会话判成 owner）。
  ownerIds: [],
  // 不扫哪些（glob；绝对路径和相对路径都匹配）。索引库自己不能被当成语料。
  exclude: ['**/.index/**', '**/node_modules/**'],
  syncIntervalMs: 300_000,
  // 切块规范（CHUNK_SIG）变了的处理：false = 只记账、不重切（默认，见 recall.js 里的闸）。
  // 真要换规范才设 true —— 那一下会把全部向量重算一遍。
  acceptSpecChange: false,
  search: { candidatePool: 40, rrfK: 10 },
  recall: { enabled: true, limit: 4, budgetChars: 1600, order: 130 },
  // queryInstruction 没配就沿用 Qwen3-Embedding 的默认前缀（见 src/embed.js）；换模型建议显式清空。
  embedding: { enabled: true, threads: 6, contextSize: 1024, batchSize: 256 },
}

/** 把 patch 里的 config 和默认值合起来（嵌套那两层也要合）。 */
function resolveConfig(raw) {
  const merged = { ...DEFAULTS, ...(raw ?? {}) }
  merged.search = { ...DEFAULTS.search, ...(raw?.search ?? {}) }
  merged.recall = { ...DEFAULTS.recall, ...(raw?.recall ?? {}) }
  merged.embedding = { ...DEFAULTS.embedding, ...(raw?.embedding ?? {}) }
  return merged
}

/** 会话 key → 通道级别。跟 qq 插件里的 scopeOf 是同一套规则（owner 才是主人私聊）。 */
function scopeOfKey(key, ownerIds) {
  const kind = key.split(':', 1)[0]
  if (kind === 'group' || kind === 'grp') return 'group'
  if (kind === 'bot') return 'owner'
  const id = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
  return ownerIds.includes(id) ? 'owner' : 'guest'
}

/** 从一条用户消息里抠出文本。 */
function messageText(message) {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 注册这个插件。 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  // 查询前缀按配置覆盖；没配就保留 Qwen3-Embedding 的默认前缀（换模型建议显式清空）
  setQueryInstruction(config.embedding.queryInstruction)
  // 直接写 stderr，不走 ctx.logger。
  // 踩过的坑：cordis 的 logger 服务默认只挂一个「内存环形缓冲」exporter ——
  // info 既不落文件也不打屏，插件看着像根本没加载。所以这里自己写 stderr，
  // 落到哪（journald / 重定向到文件）交给宿主决定。
  const log = (...args) => {
    try {
      process.stderr.write(`${new Date().toISOString()} [dsh-memory-search] ${args.join(' ')}\n`)
    } catch {
      // 连 stderr 都没了就算了
    }
  }

  const index = new Index(config.dbPath)
  const recaller = new Recaller(index, config.search)

  /** 插件的自述状态（工具和命令都用它）。 */
  const state = {
    phase: 'idle',
    error: undefined,
    counts: { files: 0, chunks: 0, vectors: 0 },
    embedded: false,
    progress: '',
  }

  // ---------------- 会话 → 通道（决定密级） ----------------
  let mapCache = { at: 0, bySession: new Map() }
  function sessionScopes() {
    try {
      const info = statSync(config.sessionMap)
      if (info.mtimeMs !== mapCache.at) {
        const raw = JSON.parse(readFileSync(config.sessionMap, 'utf8'))
        const bySession = new Map()
        for (const [key, value] of Object.entries(raw)) {
          if (value?.sessionId) bySession.set(value.sessionId, scopeOfKey(key, config.ownerIds))
        }
        mapCache = { at: info.mtimeMs, bySession }
      }
    } catch {
      // 映射文件不在（还没起过会话）——那就谁都别召回，安全
    }
    return mapCache.bySession
  }

  // ---------------- 后台建索引 ----------------
  // 切块规范的锁：规范一改就整库重切 + 向量重算（一趟约 7 分钟），所以不默默做。
  const specLock = join(dirname(config.dbPath), 'spec-lock.json')

  const noteSpecChange = (info) => {
    log(
      `切块规范变了（${info.from} → ${info.to}，${info.files} 个文件还是旧切法）——没有重切，索引照旧用。`,
      `要换就设 acceptSpecChange: true 再重载（真跑起来会重算全部向量）。`,
    )
  }

  const prepare = async () => {
    if (config.roots.length === 0) log('还没配 roots —— 没有语料可索引，见 README 的配置一节。')
    state.phase = 'indexing'
    const sync = await syncIndex(index, {
      roots: config.roots,
      exclude: config.exclude,
      onFile: () => {},
      specLock,
      acceptSpecChange: config.acceptSpecChange,
      onSpecChange: noteSpecChange,
    })
    state.counts = index.describe()
    log(
      sync.skippedSpec
        ? `语料同步：${sync.total} 个文件（规范待定，没重切），共 ${state.counts.chunks} 块`
        : `语料同步：${sync.total} 个文件（新切 ${sync.changed}，删 ${sync.removed}），共 ${state.counts.chunks} 块`,
    )
    // 没开向量、或没配模型路径 —— 只跑关键词那一路（照样能用，只是搜同义词弱一点）
    if (!config.embedding.enabled || !config.modelPath) {
      if (!config.modelPath) log('没配 modelPath —— 只跑关键词那一路（FTS5）。')
      state.phase = 'ready'
      return
    }
    state.phase = 'embedding'
    const loaded = await loadEmbedder({
      modelPath: config.modelPath,
      threads: config.embedding.threads,
      contextSize: config.embedding.contextSize,
      batchSize: config.embedding.batchSize,
    })
    state.embedded = embedderReady()
    if (!state.embedded) {
      state.error = loaded?.error ? String(loaded.error) : 'embedding 模型没载起来'
      log('向量那半没起来，先只跑关键词：', state.error)
    } else {
      const filled = await backfillVectors(index, {
        batch: 32,
        onProgress: (done) => {
          state.progress = `${done} 块向量已补`
        },
      })
      log(`向量补课：${filled} 块`)
    }
    state.counts = index.describe()
    state.phase = 'ready'
    state.progress = ''
    log(`索引就绪：${state.counts.chunks} 块 / ${state.counts.vectors} 有向量 / embedding=${state.embedded}`)
  }

  const resync = async () => {
    try {
      await syncIndex(index, {
        roots: config.roots,
        exclude: config.exclude,
        specLock,
        acceptSpecChange: config.acceptSpecChange,
        onSpecChange: noteSpecChange,
      })
      if (config.embedding.enabled && embedderReady()) await backfillVectors(index, { batch: 32 })
      state.counts = index.describe()
    } catch (error) {
      log('增量同步出错：', String(error))
    }
  }

  // 索引跟着记忆文件走：定时看看有没有新写的日记
  ctx.effect(() => {
    const timer = setInterval(() => {
      void resync()
    }, config.syncIntervalMs)
    return () => clearInterval(timer)
  })

  ctx.effect(() => {
    prepare().catch((error) => {
      state.phase = 'failed'
      state.error = String(error)
      log('建索引失败：', String(error))
    })
    return () => {
      index.close()
      void disposeEmbedder()
    }
  })

  // ---------------- 出口一：memory_search 工具 ----------------
  ctx.tools.register({
    name: 'memory_search',
    description:
      '在自己的长期记忆里检索（长期笔记、日记、归档）。问到「以前说过什么 / 那天怎么回事 / 谁是谁」这类问题时先查它，再回答。返回的是原文片段和出处，不是摘要。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '要查的事，用中文自然句子或关键词都行。' },
        limit: { type: 'integer', description: '最多给几条，默认 6。' },
      },
      required: ['query'],
    },
    output: {
      // dsh 只收 JSON Schema 的一个子集：required 是 object 上的字符串数组，
      // 不能写成属性里的 required: true（那是 defineTool 的简写方言，这里没用它）
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '这次的查询串。' },
          hits: {
            type: 'array',
            description: '命中的原文片段，按相关度排序。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', description: '文件路径。' },
                line: { type: 'integer', description: '文件里的起始行号。' },
                text: { type: 'string', description: '原文片段。' },
                score: { type: 'number', description: '融合后的相关度分数。' },
              },
              required: ['path', 'line', 'text', 'score'],
            },
          },
          note: { type: 'string', description: '需要我知道的额外说明（比如索引还没建好）。' },
        },
        required: ['query', 'hits'],
      },
      render: (args, value) => {
        const lines = [`记忆检索「${value.query}」：${value.hits.length} 条`]
        for (const hit of value.hits) {
          lines.push('', `${hit.path}:${hit.line}`, hit.text)
        }
        if (value.note) lines.push('', value.note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = String(args?.query ?? '').trim()
      const limit = Math.min(Math.max(Number(args?.limit ?? 6) || 6, 1), 20)
      if (!query) return { query, hits: [], note: '查询是空的。' }
      if (state.phase !== 'ready' && state.phase !== 'idle') {
        return { query, hits: [], note: `索引还在建（${state.phase}）。` }
      }
      const hits = await recaller.search(query, { limit, scope: 'owner', signal: exec?.signal })
      const note = state.embedded
        ? undefined
        : '注意：这次只有关键词命中（向量那半没启用或没起来），同义不同词的可能漏了。'
      return {
        query,
        hits: hits.map((hit) => ({ path: hit.path, line: hit.line, text: hit.text, score: hit.score })),
        ...(note ? { note } : {}),
      }
    },
  })

  // ---------------- 出口二：自动召回 ----------------
  if (config.recall.enabled) {
    /** sessionId → 这一轮最新的用户消息（inbox 一进来就记下，早于组装） */
    const latest = new Map()
    /** sessionId → 已经算过的召回结果（一个 turn 里可能组装好几次） */
    const cached = new Map()

    ctx.on('agent/inbox/inserted', (payload) => {
      const text = messageText(payload?.message)
      if (payload?.agent?.id && text) {
        latest.set(String(payload.agent.id), text)
        cached.delete(String(payload.agent.id))
      }
    })

    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const result = await next()
      try {
        // 可选访问用 ctx.get：直接点 ctx.agents 在没 inject 时会抛
        const agent = ctx.get('agents')?.currentInitiator?.()
        const sessionId = agent?.id ? String(agent.id) : undefined
        if (!sessionId) return result
        const query = latest.get(sessionId)
        if (!query) return result
        // 没配通道映射（sessionMap 为空）就直接当 owner —— 单人场景开箱能用。
        // 配了映射才做分层；判不出通道就当客人，宁可少召回，不可漏私事。
        const scopes = config.sessionMap ? sessionScopes() : undefined
        const scope = scopes ? scopes.get(sessionId) : 'owner'
        if (scope !== 'owner') return result
        let text = cached.get(sessionId)
        if (text === undefined) {
          const hits = await recaller.search(query, { limit: config.recall.limit, scope })
          text = formatHits(hits, { budgetChars: config.recall.budgetChars })
          cached.set(sessionId, text)
          if (text) log(`召回 ${hits.length} 条 → ${sessionId.slice(0, 8)}`)
        }
        if (!text) return result
        return {
          ...result,
          contexts: [
            ...result.contexts,
            {
              name: 'memory-search',
              order: config.recall.order,
              text: `以下是检索到的旧记忆片段（不一定相关，只是可能有关的原文；要确认就自己去看原文）：\n${text}`,
            },
          ],
        }
      } catch (error) {
        // 召回失败绝不能影响正常回复
        log('自动召回出错：', String(error))
        return result
      }
    })
  }

  // ---------------- 自检用的内部接口 ----------------
  try {
    ctx.provide('memorySearch', {
      status: () => ({ ...state, counts: index.describe() }),
      search: (query, options) => recaller.search(query, options),
      resync,
    })
  } catch (error) {
    log('暴露 memorySearch 失败（不影响检索本身）：', String(error))
  }
}

export { levelOf }
