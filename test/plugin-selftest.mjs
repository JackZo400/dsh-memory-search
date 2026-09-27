// 插件级自检：不开 dsh，用一个假 ctx 把 apply() 跑一遍 ——
// 验插件契约（工具注册 / 系统提示段 / 服务暴露）和密级路由。
//   node test/plugin-selftest.mjs
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const DIR = join(tmpdir(), 'dsh-memory-search-plugin-selftest')
rmSync(DIR, { recursive: true, force: true })
mkdirSync(join(DIR, 'corpus'), { recursive: true })

// 自带语料：public 一份（群也可见）、personal 一份（只有 owner 可见）
writeFileSync(join(DIR, 'corpus', 'public.md'), '# 项目\n\n- 项目代号叫「海鸥」。\n- 发布节奏是每周三晚上八点。\n')
writeFileSync(join(DIR, 'corpus', 'personal.md'), '# 人\n\n- 运维的老张最烦别人说「随便」。\n')

// 通道映射：一个主人会话、一个群会话、再加一个映射里没有的会话（测 fail closed）
writeFileSync(
  join(DIR, 'session-map.json'),
  JSON.stringify({
    'bot:OWNER': { sessionId: 'sess-owner', at: 1 },
    'group:100000': { sessionId: 'sess-group', at: 1 },
  }),
)

/** 造一个假 ctx，跑一遍 apply()，收集它注册了什么。 */
function harness() {
  const registered = { tools: [], events: [], provides: [] }
  let initiator
  const ctx = {
    logger: { info: () => {} },
    tools: {
      register: (def) => {
        registered.tools.push(def)
        return () => {}
      },
    },
    systemPrompt: { context: () => () => {} },
    on: (name, fn) => {
      registered.events.push({ name, fn })
      return () => {}
    },
    effect: (fn) => {
      const dispose = fn()
      return () => dispose?.()
    },
    provide: (name, value) => {
      registered.provides.push({ name, value })
    },
    get: (name) => (name === 'agents' ? { currentInitiator: () => initiator } : undefined),
  }
  return { ctx, registered, setInitiator: (v) => { initiator = v } }
}

const fail = []
const ok = (label, condition) => {
  console.log(`${condition ? '✓' : '✗'} ${label}`)
  if (!condition) fail.push(label)
}
const waitReady = async (service) => {
  for (let i = 0; i < 60 && service.status().phase !== 'ready'; i++) await new Promise((r) => setTimeout(r, 200))
  return service.status()
}

// ============ 一、配了通道映射：按密级路由 ============
const a = harness()
apply(a.ctx, {
  dbPath: `${DIR}/memory.db`,
  roots: [`${DIR}/corpus`],
  sessionMap: `${DIR}/session-map.json`,
  embedding: { enabled: false },
  syncIntervalMs: 3_600_000,
})

ok('注册了 memory_search 工具', a.registered.tools.some((t) => t.name === 'memory_search'))
ok('注册了自动召回（system-prompt/assemble）', a.registered.events.some((e) => e.name === 'system-prompt/assemble'))
ok('注册了 inbox 监听', a.registered.events.some((e) => e.name === 'agent/inbox/inserted'))
ok('暴露了 memorySearch 服务', a.registered.provides.some((p) => p.name === 'memorySearch'))

const service = a.registered.provides.find((p) => p.name === 'memorySearch').value
const status = await waitReady(service)
ok(`索引就绪（${status.counts.chunks} 块 / ${status.counts.files} 文件）`, status.phase === 'ready' && status.counts.chunks > 0)

// ---- 工具本身 ----
const tool = a.registered.tools.find((t) => t.name === 'memory_search')
const value = await tool.execute({ query: '项目代号叫什么' }, { signal: undefined })
ok(`工具能查（拿到 ${value.hits.length} 条）`, value.hits.length > 0)
ok('工具声明了输出 schema', Boolean(tool.output?.schema?.properties?.hits))
const rendered = tool.output.render({ query: '项目代号叫什么' }, value)
ok('render 出的是文本块', rendered[0]?.type === 'text' && rendered[0].text.includes('项目代号叫什么'))

// ---- 自动召回：主人会话该注入，群会话和认不出的会话不该 ----
const assemble = a.registered.events.find((e) => e.name === 'system-prompt/assemble').fn
const insert = a.registered.events.find((e) => e.name === 'agent/inbox/inserted').fn
const empty = { sections: [], contexts: [], tools: [], variables: {} }
const next = async () => empty
const ask = (sessionId, text) => {
  a.setInitiator({ id: sessionId })
  insert({ agent: { id: sessionId }, message: { role: 'user', content: [{ type: 'text', text }] } })
  return assemble(empty, {}, next)
}

const ownerOut = await ask('sess-owner', '项目代号叫什么')
const injected = ownerOut.contexts.filter((c) => c.name === 'memory-search')
ok(`主人会话注入了一条召回（${injected[0]?.text?.length ?? 0} 字）`, injected.length === 1 && injected[0].text.length > 10)
ok('注入里带出处（文件:行号）', /\.md:\d+/.test(injected[0]?.text ?? ''))

const groupOut = await ask('sess-group', '项目代号叫什么')
ok('群会话不注入', groupOut.contexts.length === 0)

const unknownOut = await ask('sess-unknown', '项目代号叫什么')
ok('映射里没有的会话不注入（fail closed）', unknownOut.contexts.length === 0)

// ============ 二、不配通道映射：所有会话都当 owner（单人场景的默认） ============
const b = harness()
apply(b.ctx, {
  dbPath: `${DIR}/memory-no-map.db`,
  roots: [`${DIR}/corpus`],
  embedding: { enabled: false },
  syncIntervalMs: 3_600_000,
})
const serviceB = b.registered.provides.find((p) => p.name === 'memorySearch').value
await waitReady(serviceB)
const assembleB = b.registered.events.find((e) => e.name === 'system-prompt/assemble').fn
const insertB = b.registered.events.find((e) => e.name === 'agent/inbox/inserted').fn
b.setInitiator({ id: 'whatever-session' })
insertB({ agent: { id: 'whatever-session' }, message: { role: 'user', content: [{ type: 'text', text: '项目代号叫什么' }] } })
const noMapOut = await assembleB(empty, {}, next)
ok('不配 sessionMap 时任何会话都注入（不做密级过滤）', noMapOut.contexts.filter((c) => c.name === 'memory-search').length === 1)

console.log(fail.length === 0 ? '\n全过' : `\n挂了 ${fail.length} 项：${fail.join(' / ')}`)
// 插件里挂着定时增量同步，测试得显式退出，不然进程不散
process.exit(fail.length === 0 ? 0 : 1)
