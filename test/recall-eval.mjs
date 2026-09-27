// 召回准头评测：拿一批「你确知答案在哪」的问题，量 top-1 / top-3 / top-5 命中率。
//
//   node test/recall-eval.mjs --db .dsh-memory/index.db
//   node test/recall-eval.mjs --db .dsh-memory/index.db --model /path/to/model.gguf
//   node test/recall-eval.mjs --db .dsh-memory/index.db --cases my-cases.json --fts-only
//
// 要传生产库也可以 —— 它会先拷一份到临时目录再测，不动你的库。
//
// 判法：命中的块必须 (a) 正文里含期望子串，(b) 落在期望的文件里（没写 path 就不限）。
// 期望子串用短词，保证不会被切块切成两半。
//
// ⚠️ 这个脚本的价值全在**题目**上。文件末尾的 DEFAULT_CASES 只是示例，
//    请换成你自己语料里的真问题 —— 否则测出来的数字没有意义。
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Index } from '../src/store.js'
import { Recaller } from '../src/recall.js'
import { loadEmbedder, embedderReady } from '../src/embed.js'

const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined
}
const ftsOnly = argv.includes('--fts-only')
const src = argOf('--db')
const modelPath = argOf('--model')
const casesPath = argOf('--cases')

if (!src) {
  console.error('用法：node test/recall-eval.mjs --db <索引库路径> [--model <GGUF>] [--cases <题目.json>] [--fts-only]')
  console.error('例：  node test/recall-eval.mjs --db .dsh-memory/index.db')
  process.exit(2)
}
if (!existsSync(src)) {
  console.error(`索引库不存在：${src}`)
  process.exit(2)
}

/** 题目：{ q, sub, path? }。path 可以是正则（JS 里）或字符串（JSON 里）。 */
function loadCases() {
  if (!casesPath) return DEFAULT_CASES()
  const raw = JSON.parse(readFileSync(casesPath, 'utf8'))
  return raw.map((c) => ({ ...c, path: c.path ? new RegExp(c.path) : undefined }))
}

const tmp = join(tmpdir(), 'dsh-memory-search-eval')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(src + suffix)) cpSync(src + suffix, join(tmp, `memory.db${suffix}`))
}

const index = new Index(join(tmp, 'memory.db'))
let embedNote = 'off（只跑关键词）'
if (!ftsOnly && modelPath) {
  await loadEmbedder({ modelPath })
  embedNote = embedderReady() ? 'on' : '加载失败 → 只剩关键词'
} else if (!ftsOnly) {
  embedNote = 'off（没给 --model）'
}
console.log(`库：${JSON.stringify(index.describe())}  向量路：${embedNote}\n`)

const CASES = loadCases()
const recaller = new Recaller(index, { candidatePool: 40, rrfK: 10 })
const miss = []
let hit1 = 0
let hit3 = 0
let hit5 = 0

for (const c of CASES) {
  const hits = await recaller.search(c.q, { limit: 5, scope: 'owner' })
  const rank = hits.findIndex((h) => h.text.includes(c.sub) && (!c.path || c.path.test(h.path)))
  if (rank === 0) hit1++
  if (rank >= 0 && rank < 3) hit3++
  if (rank >= 0) hit5++
  else miss.push({ c, hits })
  const tag = rank === 0 ? '✓1' : rank > 0 ? `✓${rank + 1}` : '✗ '
  const where = hits[rank]
    ? `${hits[rank].path.split('/').slice(-2).join('/')}:${hits[rank].line}`
    : hits[0]
      ? `#1 是 ${hits[0].path.split('/').slice(-2).join('/')}:${hits[0].line}`
      : '无命中'
  console.log(`${tag}  ${c.q}  →  ${where}`)
}

const n = CASES.length
console.log(`\ntop1 ${hit1}/${n}   top3 ${hit3}/${n}   top5 ${hit5}/${n}   漏 ${miss.length}`)
for (const m of miss) {
  console.log(`\n✗ ${m.c.q}（找「${m.c.sub}」）实际前 5：`)
  for (const h of m.hits) console.log(`    ${h.score}\t${h.path.split('/').slice(-2).join('/')}:${h.line}\t${h.text.replace(/\s+/g, ' ').slice(0, 60)}`)
}
index.close()
process.exitCode = miss.length > 0 ? 1 : 0

/**
 * 示例题目 —— **请换成你自己语料里的真问题**。
 * sub 是期望命中的短子串；path 可选，用来限定答案该出现的文件。
 */
function DEFAULT_CASES() {
  return [
    { q: '主服务器托管在哪', sub: '北星机房', path: /public\.md$/ },
    { q: '谁最烦别人说什么词', sub: '随便' },
    { q: '项目代号叫什么', sub: '海鸥' },
  ]
}
