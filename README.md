# dsh-memory-search

[English](README.en.md) | 简体中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的**长期记忆检索**插件。

把一堆 markdown 笔记做成 Agent「想得起来」的记忆：两路召回（本地向量 + 关键词），
每轮自动把相关的旧事带进上下文，Agent 也能自己 `memory_search` 去翻。

> 一个跑得久的 Agent，问题常常不是模型不够聪明，而是**它不记得**。
> 这个插件不训练、不微调，只做一件事：把你自己写的笔记，变成随时查得到的记忆。

> **同类里更成熟的选择**：[csyangwen/dsh-memory-evolve](https://github.com/csyangwen/dsh-memory-evolve)、[Aik358/dsh-auto-memory](https://github.com/Aik358/dsh-auto-memory)、[FuRongJun-1999/dsh-memory](https://github.com/FuRongJun-1999/dsh-memory) 都比这份成熟，要装先看它们。
> 我们这份留着的理由：它是**我们自己线上记忆检索的抽出版**——两路召回（本地向量 + 关键词）和密级过滤都是跑过的那套，
> 自检自带语料、不用先接上你的数据，索引删了也能从 `.md` 重建。
> 功能面比上面几个窄，选之前先比一比。

---

## 为什么需要它（用 markdown 当语料）

记忆存在磁盘上的 `.md` 里，数据库只是**索引**：

- 笔记你随时能打开改，改完索引自己跟上（按 mtime/size 增量重切，只动改过的那篇）
- 备份、diff、git 版本化都是现成的
- 索引删了随时重建 —— 笔记是唯一的真相来源

## 特性

- **混合召回**：SQLite FTS5 关键词 + 本地 embedding 向量，RRF 融合 —— 「原话」和「意思」各管一半。
  中文按重叠 bigram 在应用层切词，**不用编译任何 SQLite 扩展**。
- **零 API 花费**：向量模型跑在本地（`node-llama-cpp`，CPU 就行）。
- **不装模型也能用**：`modelPath` 留空就只跑关键词那一路，一条依赖都不用多。
- **两个出口**：`memory_search` 工具（Agent 主动查）+ 每轮自动召回（塞进系统提示，**不进对话记录**）。
- **可选密级**：同一堆语料里，群聊只可能召回 public，私事只在主人会话里出现。
- **切块规范有闸**：改切块规则不会偷偷把全库向量重算一遍，要你显式点头。

## 安装

```bash
dsh plugin --profile web add github:JackZo400/dsh-memory-search
```

装完按下面的「配置」改一遍，再重启对应 profile。

**环境要求**：Node **≥ 22.5**（用的是内置 `node:sqlite`；实测 22.22 直接可用，会打一条
`ExperimentalWarning`，属正常）。想开向量检索才需要装 `node-llama-cpp` 并自己下一个 GGUF 模型
—— 它列在 `optionalDependencies` 里，装不上也不影响关键词检索。

## 配置

配置写在你的 profile patch 里（bundle patch 的 `insert` 段）：

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

几个容易踩的点：

- **`roots` 不配就是空索引**，日志会提醒你。
- **`modelPath` 留空**时插件只建关键词索引，`embedding.enabled` 开着也白开（不会报错）。
- **`queryInstruction`**：默认值是给 Qwen3-Embedding 用的指令前缀（它 instruction-aware，
  检索质量吃这个前缀）。**换别的嵌入模型（bge-m3、nomic 之类）建议在配置里显式清空**，
  不然前缀会污染语义。
- **换嵌入模型要删掉索引库重建** —— 向量维度不同，旧向量没法复用（代码会检测到维度不匹配，
  直接放弃语义那一路，不会给你算出垃圾结果）。

## 配置（语料怎么放）

没有固定结构，递归收 `.md`，两个建议：

1. **一条一事**（一个 bullet 一件事、段落之间空行）。切块是按「空行 / 列表项 / 标题」
   这些边界走的 —— 相邻的两件事被塞进同一块，检索精度会掉。
2. **事实文件别混进大量流水账**。语料里「日记里我正在讨论这件事」的段落会字面上更像查询，
   把真正的事实挤出前排。插件给 `public.md` / `personal.md` / `secret.md` 这类文件加了
   1.5 倍来源权重、给 `carryover/` 目录降了权，但语料结构还是你自己最清楚。

## 配置（密级，可选）

判据是**文件名**（放在哪个目录下都行）：

| 文件名 | 密级 | 谁能召回 |
| --- | --- | --- |
| `public.md` | `public` | 所有会话 |
| `personal.md` | `personal` | 只有 owner 会话 |
| `secret.md` | `secret` | 只有 owner 会话 |
| 其它任何文件 | `personal`（保守） | 只有 owner 会话 |

「谁是 owner」由可选的**通道映射**决定 —— 一个 JSON，把会话 key 映射到 session id：

```json
{ "c2c:1A2B3C": { "sessionId": "8f0c…" }, "group:123456": { "sessionId": "ab12…" } }
```

配上 `sessionMap` 之后：`group:`/`grp:` 开头的 key 判成 `group`（只给 public）、
在 `ownerIds` 里的判成 `owner`（全给）、其余判成 `guest`（只给 public）。
**判不出通道时不召回**（fail closed）—— 宁可少给，不可漏私事。

**不配 `sessionMap` 就不做任何过滤**，所有会话都当 owner —— 单人使用（不接群）的时候，
这才是你想要的默认。

## 工作原理

```
markdown 语料 ──scan──▶ 切块（按条目边界）──▶ SQLite
                                              ├── chunks（正文 + 向量 BLOB）
                                              └── chunks_fts（bigram token）
查询 ──┬── FTS5 MATCH ──▶ bm25 排名 ─┐
       └── embed ──────▶ 余弦排名 ──┴── RRF 融合 ──▶ 按来源加权 ──▶ 密级过滤 ──▶ top-k
```

- **RRF 融合**：不比较两路的分数（bm25 和余弦根本不是一个量纲），只比名次。
- **切块**：按空行 / 列表项 / markdown 标题切，条目超长才按长度硬切；保留起始行号，方便回原文。
- **增量**：每个文件记 mtime + size，只重切变过的；删掉的文件从索引里忘掉。
- **切块规范闸**：切块规则变了（`CHUNK_SIG`），默认**只记账不重切** ——
  要重切得设 `acceptSpecChange: true`（那一下会把全部向量重算）。
- **两个出口**：`memory_search` 工具返回原文片段 + 出处（不是摘要）；
  自动召回挂在 `system-prompt/assemble` 上，往系统提示里加一段 `memory-search`，
  **不写进对话记录**，所以不会污染上下文历史。

## 测试

```bash
node test/selftest.mjs         # 切块 / 分词 / 索引 / 检索（临时语料，无外部依赖）
node test/plugin-selftest.mjs  # 插件契约：工具注册、系统提示段、服务暴露、密级
node test/spec-guard.mjs       # 切块规范闸：改了规则不许偷偷重切
npm test                       # 上面三个一起
```

`test/recall-eval.mjs` 是**评测脚手架**，不是自检 —— 它对着你自己的索引库跑一批
「问句 → 期望命中的片段/文件」的题，报告 top-1 / top-3 / top-5 命中率：

```bash
node test/recall-eval.mjs --db .dsh-memory/index.db --corpus ./memory
```

题目要按你自己的语料改（文件头部有示例）。**这是这个插件最该动的地方** ——
召回质量跟语料结构强相关，我给的默认权重只在一类语料上验证过。

## 已知局限

- **切块规则是启发式的**（空行/列表/标题），对「一大段长文」的笔记不友好。
- **来源权重是硬编码的三条**，按文件名/目录匹配。语料结构差异大的话，得改 `src/recall.js`。
- **向量检索是全量扫描**（几百到几千块是毫秒级，上万块就该上专门的向量库了）。
- **中文分词只做 bigram**，没有词表 —— 专有名词查得准，语法层面的理解不做。
- **嵌入模型只在 Qwen3-Embedding-0.6B 上验证过**，换模型请留意 `queryInstruction` 和维度。

## License

MIT © 2026 JackZo400

---

## English

→ Full English README: [README.en.md](README.en.md)
