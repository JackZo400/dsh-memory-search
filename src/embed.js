// 本地嵌入：Qwen3-Embedding-0.6B（gguf）跑在 node-llama-cpp 上。
//
// 默认强制走 CPU、把上下文窗口开小 —— 默认参数会让常驻内存涨到 5G 以上（实测，
// 11G 的机器上足以把别的服务挤出去）。加载失败不抛，只是让检索退回纯 FTS5：
// 记忆检索坏掉，不该把整个 Agent 带下水。

/**
 * 查询侧指令前缀。Qwen3-Embedding 是 instruction-aware 的，检索质量明显吃这个前缀；
 * 换成别的嵌入模型（bge-m3、nomic 之类）通常该清空 ——
 * 配置里写 `embedding.queryInstruction: ''`，或直接调 setQueryInstruction('')。
 */
const DEFAULT_QUERY_INSTRUCTION = 'Instruct: Given a query, retrieve memory passages that answer it\nQuery: '

let queryInstruction = DEFAULT_QUERY_INSTRUCTION

/** 改查询前缀（插件启动时按配置设一次）。传非字符串 = 退回默认。 */
export function setQueryInstruction(text) {
  queryInstruction = typeof text === 'string' ? text : DEFAULT_QUERY_INSTRUCTION
}

let state = undefined

/** 载入模型（幂等，只载一次）。失败返回 undefined，调用方退回 FTS。 */
export async function loadEmbedder({ modelPath, threads = 6, contextSize = 1024, batchSize = 256 }) {
  if (state !== undefined) return state
  try {
    const { getLlama } = await import('node-llama-cpp')
    const llama = await getLlama({ gpu: false })
    const model = await llama.loadModel({ modelPath, gpuLayers: 0 })
    const context = await model.createEmbeddingContext({ contextSize, batchSize, threads })
    state = { llama, model, context }
  } catch (error) {
    state = null
    return { error }
  }
  return state
}

/** 已经载好了吗（没载或载失败都是 false）。 */
export function embedderReady() {
  return Boolean(state)
}

/** 一段文本 → 归一化后的 Float32Array；没有模型就返回 undefined。 */
export async function embed(text, { query = false } = {}) {
  if (!state) return undefined
  // node-llama-cpp 的返回是 { vector }（number[]），不是 { embedding }
  const { vector } = await state.context.getEmbeddingFor(query ? queryInstruction + text : text)
  // 维度从模型自己报的来，不写死。换模型导致维度和索引库里对不上时，
  // 由 store.js 的维度检查放弃语义那一路 —— 不会算出垃圾排名。
  const dim = vector.length
  const vec = new Float32Array(dim)
  let norm = 0
  for (let i = 0; i < dim; i++) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i++) vec[i] = vector[i] / norm
  return vec
}

/** 释放（给自检和热重载用）。 */
export async function disposeEmbedder() {
  if (!state) return
  const { model } = state
  state = undefined
  try {
    await model.dispose()
  } catch {
    // 释放失败无所谓，进程退出会一起收走
  }
}
