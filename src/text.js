// 记忆语料的分词与切块。
//
// 为什么不用 FTS5 自带的 trigram 分词器：中文两个字的关键词（「服务器」「报销」）
// 在 trigram 下切不出任何 token，一条都搜不到。所以这里在应用层切：
// 中文按重叠 bigram（二字）切，ASCII 按词切，交给 FTS5 的 unicode61 存。
// 效果等于给 SQLite 现装了一个中文分词器，而不用编译任何扩展。

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/
const WORD = /[a-z0-9_]/

/** 文本 → token 数组（中文 bigram + ASCII 词）。 */
export function tokenize(text) {
  const out = []
  const low = String(text).toLowerCase()
  let i = 0
  while (i < low.length) {
    const ch = low[i]
    if (CJK.test(ch)) {
      let j = i
      while (j < low.length && CJK.test(low[j])) j++
      const seg = low.slice(i, j)
      if (seg.length === 1) out.push(seg)
      else for (let k = 0; k < seg.length - 1; k++) out.push(seg.slice(k, k + 2))
      i = j
    } else if (WORD.test(ch)) {
      let j = i
      while (j < low.length && WORD.test(low[j])) j++
      out.push(low.slice(i, j))
      i = j
    } else {
      i++
    }
  }
  return out
}

/**
 * 查询侧停用字（2026-09-26 晚加）：bigram 是两个虚字就丢掉。
 *
 * 为什么：查询被切成所有相邻二字对、再平权 OR，"的全""是什""什么""是谁""家的"
 * 这类虚词对会把 BM25 的票投给"字面像、其实不是答案"的块 —— 实测「某人的全名是什么」
 * 把唯一含「全名」的那条正确块挤到 5 名之外，前排全是恰好含 什么/的 的日记。
 * 规则只丢**两个字都停用**的组合（"服务""讨厌"这类实词一律留下），
 * 全丢光了就退回原样，保证不会把某条查询搜成空。
 */
const STOP = new Set('的是什么谁哪了个在有不没很还就都要能会也吗呢吧啊你我他她它们这那之到对把被和与上下时候说做怎为于其而且则或者一二三四'.split(''))

/** 查询串 → FTS5 MATCH 表达式：每个 token 一个短语，OR 起来，交给 bm25 排序。 */
export function matchExpression(query) {
  const all = [...new Set(tokenize(query))]
  if (all.length === 0) return undefined
  const kept = all.filter((t) => !(t.length === 2 && STOP.has(t[0]) && STOP.has(t[1])))
  const toks = kept.length > 0 ? kept : all
  return toks.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

/**
 * 把一份 markdown 切成检索块：**按条目边界切**（v2，2026-09-26 晚）。
 *
 * v1 是"按行攒到 180 字"，问题实测出来了：一条 bullet 才五六十字，攒着攒着就把
 * 相邻的**另一件事**也吞进同一块 —— 「某台服务器的归属」和「某个人的职务」挤在
 * 一块，查"服务器是谁家的"时后者把向量分数稀释掉，目标块掉到 40 名之外。
 *
 * v2 的边界：空行、列表项（- * + 1.）、markdown 标题，任一出现就开新块；
 * 一条条目超长（> target）才按长度硬切。行号仍保留块首行，方便回原文。
 */
export function chunkText(text, target = 180) {
  const chunks = []
  let buf = []
  let start = 1
  const BOUNDARY = /^\s*(?:[-*+]|\d+\.)\s/
  const HEADING = /^#{1,6}\s/
  const push = () => {
    const body = buf.join('\n').trim()
    if (body !== '') chunks.push({ line: start, text: body })
    buf = []
  }
  const lines = String(text).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      push()
      continue
    }
    if (buf.length > 0 && (BOUNDARY.test(line) || HEADING.test(line))) push()
    if (buf.length === 0) start = i + 1
    buf.push(line)
    if (buf.join('\n').length >= target) push()
  }
  push()
  return chunks
}
