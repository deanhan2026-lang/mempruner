# MemPruner — 灵元记忆治理引擎

> **记忆不牢，地动山摇。** Memory is the foundation. MemPruner is the governance engine that keeps an AI agent's memory honest, slim, and searchable.

MemPruner 是灵元 ANIMA 生态的记忆治理层——在 AI 智能体的记忆写入端加一道**零 LLM 的纯规则分类闸门**，把流水、身份锚点、令牌链、规则、任务分流归档，给每条有效记忆打上温度标签，让记忆**只沉淀该沉淀的，随时找得到该找到的**。

与 [MemGuard](https://github.com/deanhan2026-lang/anima-nas)（记忆安全·存证）并列——**MemGuard 管"记忆不可篡改"，MemPruner 管"记忆不膨胀、不腐烂"**。四支柱：Polaris（漂移诊断）· MemGuard（存证）· **MemPruner（治理）** · SOMA（自治感知）。

## 为什么需要它

智能体长期运行的记忆会**指数膨胀**：
- 对话流水（Q/A、错误日志、工具调用记录）混进主记忆 → 语义噪音
- 检索命中率随体积下降 → 越记越糊涂
- 无温度分层 → 该忘的忘不掉，该记的记不牢

MemPruner 从**写入源头**解决：新流水直接进归档，有效条目进主记忆并带温度标签；冷条目检索命中自动升温（记忆重固化），长期无人问津的条目进入衰减修剪流程（M2）。

## 核心架构

```
写入流 ──→ ┌──────────────────────────┐
           │  M1 classify.js（分类闸门） │  零 LLM · 纯规则 · 失败静默
           └──────────┬───────────────┘
                      │
        ┌─────────────┴─────────────┐
        ▼                           ▼
  MEMORY.flow_archive.md      MEMORY.md（主记忆）
  （流水归档，带标签）          （有效条目，带温度标签）
        │                           │
        └──────────┬────────────────┘
                   ▼
        ┌──────────────────────────┐
        │  M4 indexer.js（倒排索引）  │  中文 bigram + 英文词 · 命中自动升温
        └──────────────────────────┘
```

## 模块

| 模块 | 状态 | 说明 |
|------|------|------|
| **M1 classify.js** | ✅ v0.1.1 | 写入端分类器：flow/identity/token/rule/task/keep 六型判定，强/弱两级规则库，温度标签（🧊冻/🌤️温/🔥热） |
| **M4 indexer.js** | ✅ v0.1.0 | 索引器：零依赖倒排索引，中文 bigram 分词，检索命中自动升温（可逆） |
| **M2 pruner.js** | ⏳ 排期中 | 三因子衰减修剪器（时间/访问频率/温度），依赖 M1 分流数据 |
| **M3 consolidation_daemon.js** | ⏳ 排期中 | 动态低谷窗口巩固守护 |
| **M5 跨节点写锁** | ⏳ 排期中 | 多终端记忆写入一致性 |

## 快速开始

```bash
# M1 分类一条条目
node classify.js < input.json
# {"entry": "Q: 今天部署了什么？", "meta": {"source": "llm:chat", "node": "kronos-heng"}}
# → {"ok":true,"type":"flow","temp":"热","route":"flow_archive",...}

# 分流模式（分类后直接写入目标文件，失败静默）
node classify.js --route MEMORY.md MEMORY.flow_archive.md < input.json

# M4 构建索引
node indexer.js build --memory MEMORY.md

# M4 检索（命中自动升温，--apply 回写源文件标签）
node indexer.js search "记忆治理" --warm --apply

# 运行测试（零依赖，node:test 内置）
node --test test/
```

**模块 API（推荐内嵌写入钩子）：**

```js
const { classifyEntry } = require('./classify.js');
const r = classifyEntry({ entry, meta });   // 永不抛异常，失败静默降级 keep+热
if (r.ok && r.route === 'flow_archive') { /* 写 flow_archive */ }
else { /* 写主记忆（含 label） */ }
```

## 设计哲学

- **零 LLM、零网络依赖**——纯 Node 标准库，不依赖任何外部包
- **永不删除**——只分流 + 打标签 + 归档，修剪是"降级/衰减"，不是销毁
- **失败静默**——分类器挂掉不影响写入（降级放行 keep+热直写主记忆）
- **可回滚**——归档带标签可追溯，索引可重建
- **温度即生死**——🧊冻（身份锚点，永久保活）/ 🌤️温（规则令牌，保活）/ 🔥热（普通，新写入默认）

## 测试

```bash
node --test test/classify.test.js   # 10 用例
node --test test/indexer.test.js    # 9 用例
```

当前 **19 测试全绿**（fixtures 取自真实 `MEMORY.flow_archive.md` 归档 + 全类型样本 + 生成变体）。

## 许可证

Apache 2.0

---

灵元 ANIMA 生态：ANIMA AGENT · AnimaLink · MeshIdentity · MemGuard · Polaris · Argus · SOMA · **MemPruner**

深潭守序，灵元续行。🖤
