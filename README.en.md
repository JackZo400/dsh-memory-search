# dsh-memory-search

[简体中文](README.md) | English

A **long-term memory search** plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

It turns a pile of markdown notes into memory an agent can actually recall:
two recall paths (local vectors + keywords), relevant old notes pulled into the
context every turn, and a `memory_search` tool the agent can dig through itself.

> A long-running agent's problem is usually not that the model is not smart
> enough, but that **it does not remember**.
> This plugin does not train and does not fine-tune. It does one thing: turns the
> notes you wrote yourself into memory you can look up at any time.

---

## Why you need it (markdown as the corpus)

Memory lives in `.md` files on disk; the database is only an **index**:

- You can open and edit a note whenever you like, and the index catches up on its
  own (incremental re-chunking by mtime/size, touching only the note that changed)
- Backup, diff and git versioning all come for free
- Delete the index and rebuild it any time — your notes are the single source of truth

## Features

- **Hybrid recall**: SQLite FTS5 keywords + local embedding vectors, fused with
  RRF — the literal words and the meaning each carry half the load. Chinese is
  tokenized at the application layer as overlapping bigrams, so **no SQLite
  extension has to be compiled**.
- **Zero API cost**: the embedding model runs locally (`node-llama-cpp`, CPU is
  enough).
- **Works without a model**: leave `modelPath` empty and only the keyword path
  runs, with not one extra dependency.
- **Two exits**: the `memory_search` tool (the agent asks on purpose) + automatic
  per-turn recall (injected into the system prompt, **never written into the
  conversation log**).
- **Optional access levels**: inside one corpus, a group chat can only ever recall
  public notes, and private matters only surface in the owner's session.
- **A gate on the chunking spec**: changing the chunking rules will not silently
  recompute every vector in the whole library; it needs your explicit approval.

## Install

```bash
dsh plugin --profile web add github:JackZo400/dsh-memory-search
```

After installing, go through the "Configuration" section below, then restart the
matching profile.

**Requirements**: Node **≥ 22.5** (it uses the built-in `node:sqlite`; verified
working on 22.22, which prints one `ExperimentalWarning` — that is normal). Vector
search additionally needs `node-llama-cpp` plus a GGUF model you download yourself
— it is listed under `optionalDependencies`, and failing to install it does not
affect keyword search.

## Configuration

Configuration goes into your profile patch (the `insert` section of the bundle
patch):

```yaml
- insert:
    - id: memory-search
      name: dsh-memory-search
      config:
        dbPath: .dsh-memory/index.db    # 索引库落哪；相对路径按 dsh 的工作目录算
        roots:                          # 语料根目录：递归收集里面的 .md
          - ./memory
        modelPath: ''                   # GGUF 嵌入模型；留空 = 只跑关键词
        recall:
          enabled: true                 # 每轮自动召回
          limit: 4                      # 最多带几条
          budgetChars: 1600             # 注入的字符预算
          order: 130                    # 在系统提示里的排序位
        embedding:
          enabled: true
          threads: 6                    # CPU 线程数
          contextSize: 1024             # 上下文窗口（开大更吃内存）
          batchSize: 256
          queryInstruction: ''          # 见下
        search:
          candidatePool: 40             # 每路召回各取多少候选
          rrfK: 10                      # RRF 平滑常数
        exclude: ['**/.index/**', '**/node_modules/**']
        syncIntervalMs: 300000          # 多久扫一次新写的笔记
        acceptSpecChange: false         # 换切块规则才设 true（会重算全部向量）
```

A few things that are easy to trip over:

- **No `roots` means an empty index**, and the log will remind you.
- **With `modelPath` empty** the plugin builds a keyword index only; turning
  `embedding.enabled` on does nothing (and raises no error).
- **`queryInstruction`**: the default is the instruction prefix for
  Qwen3-Embedding (it is instruction-aware, and retrieval quality depends on that
  prefix). **If you switch to another embedding model (bge-m3, nomic and the
  like), clear it explicitly in the config**, or the prefix will pollute the
  semantics.
- **Switching embedding models means deleting the index and rebuilding it** — the
  vector dimensions differ, so old vectors cannot be reused (the code detects the
  dimension mismatch and drops the semantic path outright rather than handing you
  garbage results).

## Configuration (laying out your corpus)

There is no fixed structure; `.md` files are collected recursively. Two
suggestions:

1. **One item per entry** (one bullet per fact, blank lines between paragraphs).
   Chunking follows boundaries like blank lines / list items / headings — push two
   neighbouring facts into the same chunk and retrieval precision drops.
2. **Do not mix a lot of running journal text into your fact files.** A passage
   like "in my diary I was discussing this very thing" is literally closer to the
   query and shoves the real fact out of the top ranks. The plugin gives files such
   as `public.md` / `personal.md` / `secret.md` a 1.5x source weight and
   down-weights the `carryover/` directory, but no one knows your corpus structure
   better than you do.

## Configuration (access levels, optional)

The criterion is the **file name** (the directory it sits in does not matter):

| File name | Level | Who can recall it |
| --- | --- | --- |
| `public.md` | `public` | all sessions |
| `personal.md` | `personal` | owner sessions only |
| `secret.md` | `secret` | owner sessions only |
| any other file | `personal` (conservative) | owner sessions only |

Who counts as the owner is decided by an optional **channel map** — a JSON that
maps a session key to a session id:

```json
{ "c2c:1A2B3C": { "sessionId": "8f0c…" }, "group:123456": { "sessionId": "ab12…" } }
```

Once `sessionMap` is configured: keys starting with `group:`/`grp:` are judged
`group` (public only), keys listed in `ownerIds` are judged `owner` (everything),
and the rest are judged `guest` (public only). **When the channel cannot be
determined, nothing is recalled** (fail closed) — better to hand out too little
than to leak something private.

**Without `sessionMap` no filtering happens at all** and every session counts as
the owner — for single-user setups (no group chats) that is the default you want.

## How it works

```
markdown 语料 ──scan──▶ 切块（按条目边界）──▶ SQLite
                                              ├── chunks（正文 + 向量 BLOB）
                                              └── chunks_fts（bigram token）
查询 ──┬── FTS5 MATCH ──▶ bm25 排名 ─┐
       └── embed ──────▶ 余弦排名 ──┴── RRF 融合 ──▶ 按来源加权 ──▶ 密级过滤 ──▶ top-k
```

- **RRF fusion**: it never compares the scores of the two paths (bm25 and cosine
  are not even the same unit), only their ranks.
- **Chunking**: split on blank lines / list items / markdown headings; only an
  over-long entry is hard-split by length. Start line numbers are kept so you can
  go back to the source text.
- **Incremental**: mtime + size is recorded per file, so only changed files are
  re-chunked; deleted files are forgotten from the index.
- **Chunking-spec gate**: when the chunking rules change (`CHUNK_SIG`), by default
  it only **records the fact and does not re-chunk** — re-chunking requires
  `acceptSpecChange: true` (and that recomputes every vector).
- **Two exits**: the `memory_search` tool returns raw passages + their source (not
  a summary); automatic recall hooks into `system-prompt/assemble` and adds a
  `memory-search` block to the system prompt, **without writing it into the
  conversation log**, so it does not pollute the context history.

## Tests

```bash
node test/selftest.mjs         # 切块 / 分词 / 索引 / 检索（临时语料，无外部依赖）
node test/plugin-selftest.mjs  # 插件契约：工具注册、系统提示段、服务暴露、密级
node test/spec-guard.mjs       # 切块规范闸：改了规则不许偷偷重切
npm test                       # 上面三个一起
```

`test/recall-eval.mjs` is an **evaluation harness**, not a self-test — it runs a
batch of "question → passage/file expected to hit" cases against your own index
database and reports top-1 / top-3 / top-5 hit rates:

```bash
node test/recall-eval.mjs --db .dsh-memory/index.db --corpus ./memory
```

The cases have to be rewritten for your own corpus (there are examples at the top
of the file). **This is the part of the plugin most worth touching** — recall
quality is tightly coupled to corpus structure, and the default weights I ship were
only validated on one kind of corpus.

## Known limitations

- **The chunking rules are heuristic** (blank lines / lists / headings) and are
  unfriendly to notes written as one long stretch of prose.
- **The source weights are three hard-coded rules**, matched by file name /
  directory. If your corpus structure differs a lot, you have to edit
  `src/recall.js`.
- **Vector search is a full scan** (milliseconds for hundreds to a few thousand
  chunks; at tens of thousands of chunks you should move to a dedicated vector
  store).
- **Chinese tokenization is bigram-only**, with no vocabulary — proper nouns are
  matched precisely, but no syntactic-level understanding is attempted.
- **The embedding model was only validated on Qwen3-Embedding-0.6B**; when you
  switch models, mind `queryInstruction` and the dimensions.

## License

MIT © 2026 JackZo400
