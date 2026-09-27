// 自检：不开 dsh，把检索核心（切块 → 索引 → 两路召回 → 密级过滤）跑一遍。
// 自带一份小语料，不依赖你自己的任何目录，clone 下来就能跑。
//
//   node test/selftest.mjs                                    只建关键词索引，秒级
//   node test/selftest.mjs --model /path/to/model.gguf        顺带验向量那一路（慢，要模型）
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Index } from '../src/store.js'
import { Recaller, syncIndex, backfillVectors, formatHits } from '../src/recall.js'
import { loadEmbedder, embedderReady } from '../src/embed.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '.tmp', 'selftest')
const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

// ---------- 自带语料：三份不同密级的笔记 + 一篇流水账日记 ----------
const corpus = join(ROOT, 'corpus')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(corpus, 'diary'), { recursive: true })
writeFileSync(
  join(corpus, 'public.md'),
  ['# 项目', '', '- 项目代号叫「海鸥」，对外一律用代号，别写正式名字。', '- 主服务器托管在北星机房，每年三月续费。', '- 发布节奏：每周三晚上八点，改完先跑一遍冒烟。', ''].join('\n'),
)
writeFileSync(
  join(corpus, 'personal.md'),
  ['# 人', '', '- 运维的老张最烦别人说「随便」，他要求把话说具体。', '- 备份口令放在 secrets/backup.txt 里，不在聊天里传。', ''].join('\n'),
)
writeFileSync(
  join(corpus, 'secret.md'),
  ['# 应急', '', '- 备用管理员账号是 admin2，只在主账号登不上时用。', ''].join('\n'),
)
writeFileSync(
  join(corpus, 'diary', '2026-01-02.md'),
  ['# 2026-01-02', '', '- 今天讨论了半天「那次故障到底怎么来的」，最后也没定论。', ''].join('\n'),
)

const index = new Index(join(ROOT, 'memory.db'))
const t0 = Date.now()
const sync = await syncIndex(index, { roots: [corpus], exclude: [] })
console.log(`同步：${sync.total} 文件 / ${sync.chunks} 块 / 新切 ${sync.changed} / 删 ${sync.removed}  (${Date.now() - t0}ms)`)

const modelPath = argOf('--model')
if (modelPath) {
  const loaded = await loadEmbedder({ modelPath })
  console.log('embedding:', embedderReady() ? 'OK' : String(loaded?.error))
  if (embedderReady()) {
    const t1 = Date.now()
    const filled = await backfillVectors(index, { batch: 64, onProgress: (n) => process.stderr.write(`  ${n}\r`) })
    console.log(`向量：${filled} 块 (${((Date.now() - t1) / 1000).toFixed(0)}s)`)
  }
}
console.log('库:', JSON.stringify(index.describe()))

// ---------- 检索：期望的答案确实在语料里 ----------
const recaller = new Recaller(index)
const CASES = [
  { q: '主服务器托管在哪', sub: '北星机房' },
  { q: '备份口令放在哪里', sub: 'backup.txt' },
  { q: '谁最烦别人说什么词', sub: '随便' },
  { q: '项目代号叫什么', sub: '海鸥' },
  { q: '发布节奏是怎样的', sub: '每周三' },
  { q: '备用管理员账号是什么', sub: 'admin2' },
]
let hit = 0
console.log('')
for (const c of CASES) {
  const hits = await recaller.search(c.q, { limit: 3, scope: 'owner' })
  const rank = hits.findIndex((h) => h.text.includes(c.sub))
  if (rank >= 0) hit++
  const where = rank >= 0 ? `${hits[rank].path.split('/').slice(-1)[0]}:${hits[rank].line}` : '（没命中）'
  console.log(`  ${rank === 0 ? '✓' : rank > 0 ? `~${rank + 1}` : '✗'} ${c.q} → ${where}`)
}
console.log(`\n前 3 命中 ${hit}/${CASES.length}`)

// ---------- 密级：群 scope 只该拿到 public ----------
// 用一条「public 里真有答案」的问法 —— 拿 personal 独有的问题去测，0 条也算「过」，
// 会把「过滤太狠、群什么都搜不到」这种毛病蒙过去。
const groupHits = await recaller.search('项目代号叫什么', { limit: 10, scope: 'group' })
const leaked = groupHits.filter((h) => !/public\.md$/.test(h.path))
console.log(`\n密级检查：群 scope 命中 ${groupHits.length} 条，越级 ${leaked.length} 条`)
if (leaked.length > 0) {
  console.log('  ✗ 越级：', leaked.map((h) => h.path).join(', '))
  process.exitCode = 1
} else if (groupHits.length === 0) {
  console.log('  ✗ 群里一条都搜不到 —— 过滤太狠了')
  process.exitCode = 1
} else {
  console.log('  ✓ 群能搜到，且只拿到 public')
}

// ---------- 注入格式（带出处、带预算） ----------
const text = formatHits(await recaller.search('项目代号叫什么', { limit: 2, scope: 'owner' }), { budgetChars: 400, root: corpus })
console.log(`\n注入片段（${text.length} 字）:\n${text}`)
if (!/\.md:\d+/.test(text)) {
  console.log('  ✗ 注入片段里没有「文件:行号」出处')
  process.exitCode = 1
}

index.close()
if (hit < CASES.length) {
  console.log(`\n✗ 有 ${CASES.length - hit} 条没进前 3 —— 召回质量退化了`)
  process.exitCode = 1
} else if (!process.exitCode) {
  console.log('\n全过')
}
