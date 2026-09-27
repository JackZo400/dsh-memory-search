// 自检：切块规范变了的那道闸。
//   node test/spec-guard.mjs
// 验的是：规范变了默认**不重切**（只记账、喊一声），acceptSpecChange: true 才真重切。
// 为什么要有这道闸：重切 = 全部向量重算，语料一多就是几十分钟的机器时间。
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Index } from '../src/store.js'
import { syncIndex, readSpecLock, writeSpecLock, CHUNK_SIG } from '../src/recall.js'

const ROOT = join(tmpdir(), 'dsh-memory-search-guard')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'corpus'), { recursive: true })
// 造一份小语料：两条条目，当前切块规则下会切成 2 块
writeFileSync(join(ROOT, 'corpus', 'a.md'), '# 甲\n\n- 第一件事，写长一点，让它自己占一块。\n- 第二件事，也写长一点，够独立成块。\n')
const DB = join(ROOT, 'memory', '.index', 'memory.db')
const LOCK = join(ROOT, 'memory', '.index', 'spec-lock.json')

const fail = []
const ok = (label, condition) => {
  console.log(`${condition ? '✓' : '✗'} ${label}`)
  if (!condition) fail.push(label)
}
const fresh = () => new Index(DB)
const sync = (index, acceptSpecChange) =>
  syncIndex(index, { roots: [join(ROOT, 'corpus')], exclude: [], specLock: LOCK, acceptSpecChange })

// ---- 1. 第一次建库：正常切，锁写下当前规范 ----
let index = fresh()
const first = await sync(index, false)
ok(`首次建库正常切（${first.changed} 个文件 / ${first.chunks} 块）`, first.changed === 1 && first.chunks > 0)
ok('首次建库没有触发闸', first.skippedSpec === undefined)
ok(`锁 = 当前规范（${CHUNK_SIG}）`, readSpecLock(LOCK)?.spec === CHUNK_SIG)

// ---- 2. 规范变了（伪装成旧锁 = 索引是旧切法建的）：默认不重切 ----
writeSpecLock(LOCK, 'chunk-v1-legacy', 'test')
const before = index.describe().chunks
const second = await sync(index, false)
ok('规范变了：没重切（changed = 0）', second.changed === 0)
ok(
  `规范变了：闸记下了新旧版本（${second.skippedSpec?.from} → ${second.skippedSpec?.to}）`,
  second.skippedSpec?.from === 'chunk-v1-legacy' && second.skippedSpec?.to === CHUNK_SIG,
)
ok(`规范变了：块数没动（还是 ${before} 块）`, index.describe().chunks === before)
ok('规范变了：锁**没**被偷偷改成新规范', readSpecLock(LOCK)?.spec === 'chunk-v1-legacy')
index.close()

// ---- 3. 明确点头（acceptSpecChange: true）：真重切，锁跟上 ----
index = fresh()
const third = await sync(index, true)
ok(`点头后真重切（${third.changed} 个文件 / ${third.chunks} 块）`, third.changed === 1 && third.chunks > 0)
ok('点头后锁更新成新规范', readSpecLock(LOCK)?.spec === CHUNK_SIG)

// ---- 4. 规范没变时，谁都不许乱动 ----
index.close()
index = fresh()
const fourth = await sync(index, false)
ok('规范没变：一个文件都不重切', fourth.changed === 0 && fourth.skippedSpec === undefined)
index.close()

console.log(fail.length === 0 ? '\n全过' : `\n挂了 ${fail.length} 项：${fail.join(' / ')}`)
process.exit(fail.length === 0 ? 0 : 1)
