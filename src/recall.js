// 语料扫描 + 混合检索。
//
// 两路召回各管一半：FTS5 命中「原话」（专有名词、数字、原句），向量命中「意思」
// （「上次重启是为了什么」这种查询里一个原词都没有，只有向量捞得到）。
// 两路各自排名后用 RRF 融 —— 不比较分数（bm25 和余弦根本不是一个量纲），只比名次。

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { chunkText } from './text.js'
import { embed } from './embed.js'

/**
 * 切块规则的版本戳。规则一改（这里加 v2、或改 target 字数），所有文件自动重切 ——
 * 不然 mtime/size 没变，isFresh 会认为"没动过"，索引永远停在旧切法上。
 * 改 chunkText 的行为就必须改这个串。
 */
export const CHUNK_SIG = 'chunk-v2:180'

/** 极简 glob → 正则（只支持 ** 和 *，够用就好）。逐字符扫，别用连续的 replace —— 先替换出来的 `.*` 会被后一步的 `*` 规则再咬一口。 */
export function globToRegExp(pattern) {
  const SPECIAL = '.+^${}()|[]\\'
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (SPECIAL.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`^${out}$`)
}

/** 递归找出所有 .md（跳过隐形目录，别把 .git 和索引库自己扫进来）。 */
export function scanMarkdown(roots, exclude = []) {
  const skip = exclude.map(globToRegExp)
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.md')) {
        if (skip.some((re) => re.test(full) || re.test(relative('/', full).slice(1)))) continue
        try {
          const info = statSync(full)
          found.push({ path: full, mtime: info.mtimeMs, size: info.size })
        } catch {
          // 文件正好被删/换掉，跳过，下一轮再说
        }
      }
    }
  }
  for (const root of roots) walk(root)
  return found
}

/**
 * 增量同步：只重切 mtime/size 变过的文件，删掉已经不存在的。
 *
 * embedding 慢（这块 CPU 上一块约 0.4 秒），所以先只建 FTS、把向量留空，
 * 由调用方分批补 —— 检索在向量补齐之前就能用，只是弱一些。
 *
 * 切块规则（CHUNK_SIG）一变会**整库重切 → 向量全部重算**（语料一多就是几十分钟的事）。
 * 我们挨过这一次（先上线、后改规则，向量白算两遍），所以这里上了闸：
 * 规则变了自己不动手，只把新旧版本记下来、喊一声，等 acceptSpecChange 才重切。
 * 旧的索引继续用 —— 带病能用，好过为一条规则在后台烧几十分钟。
 */
export async function syncIndex(index, { roots, exclude, onFile, onDone, specLock, acceptSpecChange = false, onSpecChange }) {
  const present = scanMarkdown(roots, exclude)
  const seen = new Set(present.map((f) => f.path))
  const changed = { changed: 0, chunks: 0, removed: 0, total: present.length, skippedSpec: undefined }

  // 「库是按哪套规范切的」——没锁（新库/老库第一趟）就当成当前规范。
  // 点头同意换规范时，这枚旧戳就是**重切的判据**：isFresh 拿它比，库里那些
  // 旧戳文件就都算"不新鲜"，才会真被重切。别用 CHUNK_SIG 去比 —— 那样 mtime/size
  // 都没变，一个文件都不会重切，"点头"就成了句空话（自检里踩过）。
  let dbSpec = CHUNK_SIG
  if (specLock) {
    const lock = readSpecLock(specLock)
    const seenSigs = index.sigCounts()
    const dbEmpty = seenSigs.every((row) => row.n === 0)
    const stale = lock ? seenSigs.filter((row) => row.sig !== lock.spec && row.n > 0) : []
    if (!lock) {
      writeSpecLock(specLock, CHUNK_SIG, 'first-run')
    } else if (lock.spec !== CHUNK_SIG && !dbEmpty && !acceptSpecChange) {
      // 闸落下：规范变了，但不替自己决定再烧一遍向量
      const staleFiles = stale.reduce((sum, row) => sum + row.n, 0)
      changed.skippedSpec = { from: lock.spec, to: CHUNK_SIG, files: staleFiles }
      onSpecChange?.(changed.skippedSpec)
      onDone?.({ ...changed, present: present.length })
      return changed
    } else if (lock.spec !== CHUNK_SIG) {
      dbSpec = lock.spec
      writeSpecLock(specLock, CHUNK_SIG, 'accepted')
    }
  }

  let chunks = 0
  for (const file of present) {
    if (index.isFresh(file.path, file.mtime, file.size, dbSpec)) continue
    let text
    try {
      text = readFileSync(file.path, 'utf8')
    } catch {
      continue
    }
    const parts = chunkText(text)
    index.replaceFile(file.path, file.mtime, file.size, parts.map((p) => ({ line: p.line, text: p.text })), CHUNK_SIG)
    changed.changed++
    chunks += parts.length
    onFile?.(file.path, parts.length)
  }
  let removed = 0
  for (const path of index.knownPaths()) {
    if (!seen.has(path)) {
      index.forgetFile(path)
      removed++
    }
  }
  changed.chunks = chunks
  changed.removed = removed
  onDone?.({ changed: changed.changed, chunks, removed, total: present.length })
  return changed
}

/** 读「当前认的切块规范」这枚锁（没锁就返回 undefined）。 */
export function readSpecLock(lockPath) {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8'))
    return typeof raw?.spec === 'string' ? raw : undefined
  } catch {
    return undefined
  }
}

/** 写锁（只在规范真变了或第一次建库时写）。 */
export function writeSpecLock(lockPath, spec, reason) {
  try {
    mkdirSync(dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, `${JSON.stringify({ spec, reason, at: new Date().toISOString() }, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

/** 还没算向量的块，分批补上。返回补了多少。 */
export async function backfillVectors(index, { batch = 32, onProgress, signal }) {
  let done = 0
  for (;;) {
    if (signal?.aborted) break
    const rows = index.missingVectors(batch)
    if (rows.length === 0) break
    const filled = []
    for (const row of rows) {
      const vec = await embed(row.text)
      if (vec) filled.push({ id: row.id, vec })
    }
    if (filled.length === 0) break
    index.putVectors(filled)
    done += filled.length
    onProgress?.(done)
  }
  return done
}

/**
 * 语料落在哪一层密级 —— 群通道只许碰 public，别的按 personal 保守处理。
 * 判据是**文件名**（任何目录下的 public.md / personal.md / secret.md），
 * 不要求放在某个特定目录里；认不出的一律当 personal（保守）。
 */
export function levelOf(path) {
  if (/public\.md$/.test(path)) return 'public'
  if (/secret\.md$/.test(path)) return 'secret'
  if (/personal\.md$/.test(path)) return 'personal'
  return 'personal'
}

const LEVELS_BY_SCOPE = {
  owner: new Set(['public', 'personal', 'secret']),
  group: new Set(['public']),
  guest: new Set(['public']),
}

/**
 * 来源权重：长跑下去必然出现这种情况 —— 语料里「正经记下来的事实」只占几个百分点，
 * 而「日记里我正在讨论这件事」那类段落占大头，后者字面上最像查询，
 * 于是前排全是元讨论。所以给事实文件抬权重、给归档类降权。
 *
 * 这里依赖文件名约定（public/personal/secret.md、carryover/），详见 README「密级」。
 */
const SOURCE_WEIGHT = [
  [/(?:public|personal|secret)\.md$/, 1.5],
  [/\/carryover\//, 0.6],
]

export function weightOf(path) {
  for (const [re, w] of SOURCE_WEIGHT) if (re.test(path)) return w
  return 1
}

/** 同一个文件最多贡献几条命中（第一趟限额，凑不满再放开）。 */
const PER_FILE_CAP = 2

/** RRF 融合两路排名（按来源加权）。 */
function fuse(fts, vec, k, pathOf = () => '') {
  const scores = new Map()
  const bump = (id, rank) => scores.set(id, (scores.get(id) ?? 0) + weightOf(pathOf(id)) / (k + rank + 1))
  fts.forEach((row, rank) => bump(row.id, rank))
  vec.forEach((row, rank) => bump(row.id, rank))
  const raw = new Map()
  fts.forEach((row) => raw.set(row.id, { ...(raw.get(row.id) ?? {}), bm25: row.score }))
  vec.forEach((row) => raw.set(row.id, { ...(raw.get(row.id) ?? {}), cosine: row.score }))
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score, ...raw.get(id) }))
    .sort((a, b) => b.score - a.score)
}

export class Recaller {
  constructor(index, config = {}) {
    this.index = index
    this.candidatePool = config.candidatePool ?? 40
    this.rrfK = config.rrfK ?? 10
    this.lastError = undefined
  }

  /**
   * 检索。scope 决定密级过滤 —— owner 全给，群/客人只有 public。
   * 没有模型就自动只剩 FTS 那一路（不报错，只是弱一点）。
   */
  async search(query, { limit = 6, scope = 'owner', signal } = {}) {
    const allowed = LEVELS_BY_SCOPE[scope] ?? LEVELS_BY_SCOPE.guest
    const { matchExpression } = await import('./text.js')
    const expression = matchExpression(query)
    let fts = []
    if (expression) {
      try {
        fts = this.index.searchFts(expression, this.candidatePool)
      } catch (error) {
        this.lastError = error
        fts = []
      }
    }
    let vec = []
    if (signal?.aborted !== true) {
      try {
        const qvec = await embed(query, { query: true })
        if (qvec) vec = this.index.searchVector(qvec, this.candidatePool)
      } catch (error) {
        this.lastError = error
      }
    }
    const texts = this.index.chunkTexts([...new Set([...fts, ...vec].map((r) => r.id))])
    const fused = fuse(fts, vec, this.rrfK, (id) => texts.get(id)?.path ?? '')
    const hits = []
    const perFile = new Map()
    const take = (capped) => {
      for (const row of fused) {
        if (hits.length >= limit) break
        const chunk = texts.get(row.id)
        if (!chunk) continue
        if (!allowed.has(levelOf(chunk.path))) continue
        if (hits.some((h) => h.path === chunk.path && h.line === chunk.line)) continue
        // 限额只压"会霸榜的"来源：正典文件本来就没几条，压它反而把答案挡在外面（实测过）
        const cap = !capped ? Infinity : weightOf(chunk.path) >= 1.5 ? Infinity : PER_FILE_CAP
        const used = perFile.get(chunk.path) ?? 0
        if (used >= cap) continue
        perFile.set(chunk.path, used + 1)
        hits.push({
          path: chunk.path,
          line: chunk.line,
          text: chunk.text,
          score: Number(row.score.toFixed(4)),
          bm25: row.bm25 === undefined ? undefined : Number(row.bm25.toFixed(2)),
          cosine: row.cosine === undefined ? undefined : Number(row.cosine.toFixed(3)),
        })
      }
    }
    take(true) // 第一趟：同一文件最多 PER_FILE_CAP 条
    if (hits.length < limit) take(false) // 凑不满再放开
    return hits
  }
}

/** 把命中拼成一段可读的上下文（注入用），带预算上限。 */
export function formatHits(hits, { budgetChars = 1600, root = '' } = {}) {
  if (hits.length === 0) return ''
  const lines = []
  let used = 0
  for (const hit of hits) {
    const where = root && hit.path.startsWith(root) ? hit.path.slice(root.length).replace(/^\//, '') : hit.path
    const body = hit.text.replace(/\s*\n\s*/g, ' / ').trim()
    const line = `- ${where}:${hit.line} — ${body}`
    if (used + line.length > budgetChars) break
    lines.push(line)
    used += line.length
  }
  return lines.join('\n')
}
