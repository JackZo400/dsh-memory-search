// 记忆索引库：SQLite（node 内置）+ FTS5 + 向量列。
//
// 三张表各管一件事：
//   files   —— 每个文件的 mtime/size，用来判断要不要重切（增量）
//   chunks  —— 切好的块 + 它的向量（BLOB）
//   chunks_fts —— bigram 分词后的正文，管关键词命中
// 检索时两路各出一份排名，再在 recall.js 里用 RRF 融合 —— 关键词负责「原话命中」，
// 向量负责「意思对得上但用词不一样」（「上次重启是为了什么」这种只有向量捞得到）。

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { tokenize } from './text.js'

export class Index {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        mtime REAL NOT NULL,
        size INTEGER NOT NULL,
        sig TEXT
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        text TEXT NOT NULL,
        vec BLOB
      );
      CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(tokens, tokenize='unicode61');
    `)
    // 老库没有 sig 列：切块规则一变就得能重切，补上它（已经存在会抛，忽略）
    try {
      this.db.exec('ALTER TABLE files ADD COLUMN sig TEXT')
    } catch {
      // 列已存在
    }
    this.vecCache = undefined
    this.stats = { files: 0, chunks: 0, vectors: 0 }
  }

  close() {
    try {
      this.db.close()
    } catch {
      // 已经关了就算了
    }
  }

  /** 库里现在有什么（给自检和 /记忆 这类命令看）。 */
  describe() {
    const files = this.db.prepare('SELECT COUNT(*) AS n FROM files').get().n
    const chunks = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n
    const vectors = this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE vec IS NOT NULL').get().n
    return { files, chunks, vectors }
  }

  /** 一个文件变了吗（mtime+size 都一致才算没变）。 */
  isFresh(path, mtime, size, sig) {
    const row = this.db.prepare('SELECT mtime, size, sig FROM files WHERE path = ?').get(path)
    return Boolean(row) && row.mtime === mtime && row.size === size && (row.sig ?? null) === (sig ?? null)
  }

  /** 覆盖一个文件的全部块。vec 允许为空（模型没起来时先只建 FTS）；sig 是切块规则的版本戳。 */
  replaceFile(path, mtime, size, chunks, sig) {
    const del = this.db.prepare('DELETE FROM chunks WHERE path = ?')
    const delFts = this.db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE path = ?)')
    const insChunk = this.db.prepare('INSERT INTO chunks (path, line, text, vec) VALUES (?, ?, ?, ?)')
    const insFts = this.db.prepare('INSERT INTO chunks_fts (rowid, tokens) VALUES (?, ?)')
    const upsertFile = this.db.prepare(
      'INSERT INTO files (path, mtime, size, sig) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, sig = excluded.sig',
    )
    this.db.exec('BEGIN')
    try {
      delFts.run(path)
      del.run(path)
      for (const chunk of chunks) {
        const vec = chunk.vec
          ? new Uint8Array(chunk.vec.buffer, chunk.vec.byteOffset, chunk.vec.byteLength)
          : null
        // FTS 的 rowid 必须和 chunks.id 对齐（chunks.id 就是 rowid），两路排名才对得上同一个块
        const { lastInsertRowid } = insChunk.run(path, chunk.line, chunk.text, vec)
        insFts.run(Number(lastInsertRowid), tokenize(chunk.text).join(' '))
      }
      upsertFile.run(path, mtime, size, sig ?? null)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.vecCache = undefined
  }

  /** 库里出现过哪些切块规则版本戳（sig → 文件数，给"规范变了"的闸用）。 */
  sigCounts() {
    // 空串字面量在 node:sqlite 里要写成 ''（双引号会被当成列名），干脆在 JS 里归一
    return this.db
      .prepare('SELECT sig, COUNT(*) AS n FROM files GROUP BY sig')
      .all()
      .map((row) => ({ sig: row.sig ?? '', n: row.n }))
  }

  /** 索引里已经登记的路径（用来发现被删掉的文件）。 */
  knownPaths() {
    return this.db.prepare('SELECT path FROM files').all().map((r) => r.path)
  }

  /** 删掉一个文件的全部痕迹。 */
  forgetFile(path) {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE path = ?)').run(path)
      this.db.prepare('DELETE FROM chunks WHERE path = ?').run(path)
      this.db.prepare('DELETE FROM files WHERE path = ?').run(path)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.vecCache = undefined
  }

  /** 还没算向量的块（模型后起来时补课用）。 */
  missingVectors(limit) {
    return this.db.prepare('SELECT id, text FROM chunks WHERE vec IS NULL LIMIT ?').all(limit)
  }

  /** 给一批块补向量。 */
  putVectors(rows) {
    const upd = this.db.prepare('UPDATE chunks SET vec = ? WHERE id = ?')
    this.db.exec('BEGIN')
    try {
      for (const row of rows) {
        upd.run(new Uint8Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength), row.id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.vecCache = undefined
  }

  /** 关键词那一路：bm25 排名（分数越小越相关，FTS5 的约定）。 */
  searchFts(query, limit) {
    const rows = this.db.prepare('SELECT rowid AS id, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?').all(query, limit)
    return rows.map((r) => ({ id: Number(r.id), score: Number(r.score) }))
  }

  /** 向量那一路：把归一化后的向量矩阵常驻内存，一次全扫（几百块是几毫秒的量级）。 */
  searchVector(qvec, limit) {
    const cache = this.vectorCache()
    // 换了嵌入模型 → 查询向量和库里的维度对不上。直接放弃这一路，
    // 而不是拿着越界的下标算出"看着像结果"的垃圾（要恢复语义检索得删库重建）。
    if (cache.dim === 0 || qvec.length !== cache.dim) return []
    const scored = []
    for (let i = 0; i < cache.ids.length; i++) {
      let dot = 0
      const base = i * cache.dim
      for (let k = 0; k < cache.dim; k++) dot += qvec[k] * cache.matrix[base + k]
      scored.push({ id: cache.ids[i], score: dot })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  vectorCache() {
    if (this.vecCache) return this.vecCache
    const rows = this.db.prepare('SELECT id, vec FROM chunks WHERE vec IS NOT NULL').all()
    const dim = rows.length > 0 ? rows[0].vec.byteLength / 4 : 0
    const ids = new Array(rows.length)
    const matrix = new Float32Array(rows.length * dim)
    for (let i = 0; i < rows.length; i++) {
      ids[i] = Number(rows[i].id)
      const raw = rows[i].vec
      // SQLite 给的 Uint8Array 可能挂在共享 buffer 上，必须带 offset 读
      const view = new Float32Array(raw.buffer, raw.byteOffset, dim)
      matrix.set(view, i * dim)
    }
    this.vecCache = { ids, matrix, dim }
    return this.vecCache
  }

  /** 取一批块的正文（检索结果要用）。 */
  chunkTexts(ids) {
    if (ids.length === 0) return new Map()
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db.prepare(`SELECT id, path, line, text FROM chunks WHERE id IN (${placeholders})`).all(...ids)
    return new Map(rows.map((r) => [Number(r.id), { path: r.path, line: Number(r.line), text: r.text }]))
  }
}
