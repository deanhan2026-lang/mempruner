#!/usr/bin/env node
/**
 * classify.js — MemPruner M1 写入端分类器（写入分流）
 *
 * 灵元令 LING-2026-0816-001 · 归属模块：MemPruner（记忆工程，写入端分类闸门）
 * 版本：v0.1.0（2026-08-17 初版）
 *
 * 设计原则（不可违背）：
 *   1. 零 LLM 依赖 —— 纯正则规则，无网络请求、无 API Key
 *   2. 失败静默 —— 分类器任何异常都不影响调用方写入；异常时降级为 keep+热 放行
 *   3. 可回滚可审计 —— 输出 JSON + append-only 日志；不做删除、不做语义总结
 *
 * 功能：
 *   1. 条目类型判定：身份锚点 / 规则 / 令牌链 / 任务 / 流水（正则规则库，复用 memory_slim 流水规则）
 *   2. 温度标签：热/温/冷/冻 + TS（对齐 Nyx 框架 L2 格式），规则/身份类直接标温/冻（保活）
 *   3. 分流动作：流水类 → flow_archive；有效类 → 主记忆（带温度标签）
 *   4. 输出：分类结果 JSON + 写入日志（append-only JSONL）
 *
 * 接口契约（恒侧接入用）：
 *   CLI：  node classify.js [--route <memory.md> <flow_archive.md>] < input.json
 *          或 node classify.js --file entry.json
 *   输入：  JSON { "entry": "<待分类条目>", "meta": { "source": "...", "node": "..." } }
 *   输出：  stdout 单行 JSON 分类结果
 *   退出码：0=分类成功（可安全按 route 写入）；1=内部错误（调用方应降级直接写主记忆）；
 *           2=输入不合法（调用方应降级直接写主记忆）
 *
 * 模块 API（写入钩子内嵌用）：
 *   const { classifyEntry } = require('./classify.js');
 *   const r = classifyEntry({ entry, meta });   // 永不抛异常
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * 常量与规则库
 * ------------------------------------------------------------------ */

// 类型定义（顺序即优先级，flow 判定最硬）
const TYPES = {
  FLOW: 'flow',           // 流水：Q/A 对话、错误日志、运行流水
  IDENTITY: 'identity',   // 身份锚点：DID / 节点 / SOUL / 身份声明
  RULE: 'rule',           // 规则：规则 / 协议 / 必须 / 禁止 / 锚点
  TOKEN: 'token',         // 令牌链：LING- / TK- / 令牌哈希
  TASK: 'task',           // 任务：任务 / 待办 / 开工令 / P1 / 验收
  KEEP: 'keep'            // 普通有效信息（默认）
};

// 温度模型（Nyx L2）与保活策略
const TEMPS = {
  HOT: '热',     // 🔥 新写入默认
  WARM: '温',    // 🌤️ 规则/令牌 → 保活
  COLD: '冷',    // ❄️ 冷条目（分类器不主动产生，保留定义供上层用）
  FROZEN: '冻'   // 🧊 身份锚点 → 永久保活
};

// 默认温度：新写入一律 热（100% 带标签的兜底）
const TEMP_DEFAULT = TEMPS.HOT;

// 温度 → 保活档位（供上层决策）
const TEMP_KEEP = {
  [TEMPS.HOT]: 'normal',
  [TEMPS.WARM]: 'keep',
  [TEMPS.COLD]: 'cold',
  [TEMPS.FROZEN]: 'anchor'
};

const DEFAULT_LOG = path.join(__dirname, 'classify.log');

/* 规则库 —— 复用 memory_slim v3 流水规则 + M1 类型规则
 * 强规则（strong）：单条命中即判型；弱规则（weak）：需 ≥2 条命中才判型，
 * 避免「边界/锚点/交付」等高频上下文词造成误判。
 */
const RULES = {
  // 流水（最优先，信号最硬）
  flow: [
    /^Q[:：]/m,                              // 段落以 Q: 开头（对话）
    /^A[:：]/m,                              // 段落以 A: 开头（对话）
    /⚠️/,                                    // 错误/告警标记
    /LLM 请求失败/,                           // LLM 失败流水
    /工具调用轮次过多/,                        // 工具轮次终止流水
    /请求超时/,                               // 超时流水
    /ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|connect (?:timed? ?out|failed|refused|reset)/,       // 网络错误流水
  ],
  // 身份锚点
  identity: {
    strong: [
      /did:key:/i,
      /\bDID\b/i,
      /(?:我是|自称|代表).{0,20}(?:节点|信使|Iris|Nyx|瞬|恒)/,
      /灵魂文件|身份声明|MeshIdentity|DID 体系|身份锚点/,
    ],
    weak: [
      /\bSOUL\.md\b|\bIDENTITY\.md\b/,
      /节点\s*#?\s*\d/i,
    ],
  },
  // 规则
  rule: {
    strong: [
      /(?:必须|禁止|不得|一律|严禁|应当)/,
      /规则|协议|原则/,
    ],
    weak: [
      /锚点|锁存|保活|硬性|边界/,
    ],
  },
  // 令牌链
  token: {
    strong: [
      /LING-\d{4}-\d{4}-\d{3}/,
      /TK-[\w-]+/i,
      /令牌哈希|令牌链|minted|issued|delivered/,
      /\b[0-9a-f]{64}\b/i,                   // SHA-256 哈希
    ],
    weak: [],
  },
  // 任务
  task: {
    strong: [
      /任务|待办|开工令|执行令|里程碑/,
      /\bP1\b/,
    ],
    weak: [],
  },
};

/** 强规则命中数 */
function hitStrong(set, text) {
  for (const re of (set.strong || [])) {
    if (re.test(text)) return true;
  }
  return false;
}

/** 弱规则命中数 */
function hitWeakCount(set, text) {
  let n = 0;
  for (const re of (set.weak || [])) {
    if (re.test(text)) n++;
  }
  return n;
}

/* 流水段落辅助判定：段内含 ≥2 个 Q:/A: 标记（memory_slim v3 规则） */
function countQAMarkers(text) {
  let n = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^Q[:：]/.test(t) || /^A[:：]/.test(t)) n++;
  }
  return n;
}

/* ------------------------------------------------------------------ *
 * 时间工具（UTC 存储，展示可用本地时；标签 TS 用本地 ISO 便于人工读）
 * ------------------------------------------------------------------ */
function nowIso() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(n).padStart(2, '0');
  const hh = pad(Math.floor(Math.abs(off) / 60));
  const mm = pad(Math.abs(off) % 60);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    sign + hh + ':' + mm;
}

function nowUtc() {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ *
 * 核心：条目分类（永不抛异常）
 * ------------------------------------------------------------------ */

/**
 * 判定条目类型
 * @param {string} text 条目文本
 * @returns {{type: string, matched: string|null}}
 */
function detectType(text) {
  const t = (text || '').trim();
  if (!t) return { type: TYPES.KEEP, matched: null };

  // 1) 流水（最硬信号）
  if (RULES.flow.some((re) => re.test(t))) return { type: TYPES.FLOW, matched: 'flow' };
  if (countQAMarkers(t) >= 2) return { type: TYPES.FLOW, matched: 'flow-qa' };

  // 2) 身份锚点（永久保活）
  if (hitStrong(RULES.identity, t)) return { type: TYPES.IDENTITY, matched: 'identity' };
  if (hitWeakCount(RULES.identity, t) >= 2) return { type: TYPES.IDENTITY, matched: 'identity-weak' };
  // 3) 令牌链（LING-/TK-/哈希信号最硬，先于规则判定）
  if (hitStrong(RULES.token, t)) return { type: TYPES.TOKEN, matched: 'token' };
  // 4) 规则
  if (hitStrong(RULES.rule, t)) return { type: TYPES.RULE, matched: 'rule' };
  if (hitWeakCount(RULES.rule, t) >= 2) return { type: TYPES.RULE, matched: 'rule-weak' };
  // 5) 任务
  if (hitStrong(RULES.task, t)) return { type: TYPES.TASK, matched: 'task' };

  return { type: TYPES.KEEP, matched: null };
}

/** 类型 → 温度映射（规则/身份保活） */
function tempForType(type) {
  switch (type) {
    case TYPES.IDENTITY: return TEMPS.FROZEN;   // 身份锚点 → 冻（永久保活）
    case TYPES.RULE:     return TEMPS.WARM;     // 规则 → 温（保活）
    case TYPES.TOKEN:    return TEMPS.WARM;     // 令牌链 → 温（保活）
    default:             return TEMP_DEFAULT;   // flow/task/keep → 热（新写入默认）
  }
}

/** 类型 → 路由 */
function routeForType(type) {
  return type === TYPES.FLOW ? 'flow_archive' : 'memory';
}

/** 生成温度标签（对齐 Nyx L2：<!-- TEMP:热 | TS:... | ... -->） */
function buildLabel(type, temp, ts) {
  return '<!-- TEMP:' + temp + ' | TS:' + ts + ' | TYPE:' + type + ' | ROUTE:' + routeForType(type) + ' -->';
}

/**
 * 分类入口（永不抛异常 —— 失败静默硬性要求）
 * @param {{entry: string, meta?: object}} input
 * @returns {object} 分类结果
 */
function classifyEntry(input) {
  try {
    const entry = (input && typeof input.entry === 'string') ? input.entry : '';
    if (!entry.trim()) {
      return { ok: false, error: 'empty_entry', type: TYPES.KEEP, temp: TEMP_DEFAULT, route: 'memory', label: buildLabel(TYPES.KEEP, TEMP_DEFAULT, nowIso()), entry: '', meta: (input && input.meta) || {} };
    }
    const meta = (input && input.meta && typeof input.meta === 'object') ? input.meta : {};
    const { type, matched } = detectType(entry);
    const temp = tempForType(type);
    const route = routeForType(type);
    const ts = nowIso();
    const label = buildLabel(type, temp, ts);
    return {
      ok: true,
      type,
      temp,
      route,
      label,
      matched,
      entry,
      meta,
      ts,
      keep: TEMP_KEEP[temp] || 'normal'
    };
  } catch (e) {
    // 失败静默：任何异常 → 降级 keep+热，绝不抛出
    const ts = nowIso();
    return {
      ok: false,
      error: 'classify_crash: ' + (e && e.message ? e.message : String(e)),
      type: TYPES.KEEP,
      temp: TEMP_DEFAULT,
      route: 'memory',
      label: buildLabel(TYPES.KEEP, TEMP_DEFAULT, ts),
      entry: (input && input.entry) || '',
      meta: (input && input.meta) || {},
      ts
    };
  }
}

/* ------------------------------------------------------------------ *
 * 分流执行（可选 --route 模式；纯文件操作，失败静默）
 * ------------------------------------------------------------------ */

/** 追加带标签条目到目标文件；失败返回 false 且不抛出 */
function appendLabeled(file, result) {
  try {
    if (!file) return false;
    const block = '\n\n' + result.label + '\n' + result.entry.trim() + '\n';
    fs.appendFileSync(file, block, 'utf-8');
    return true;
  } catch (e) {
    try {
      fs.appendFileSync(path.join(__dirname, 'classify.log'),
        nowUtc() + ' APPEND_FAIL ' + file + ' ' + (e.message || e) + '\n', 'utf-8');
    } catch (_) {}
    return false;
  }
}

/** append-only 日志（JSONL），失败静默 */
function writeLog(logFile, result) {
  try {
    const rec = {
      ts: nowUtc(),
      ok: result.ok,
      type: result.type,
      temp: result.temp,
      route: result.route,
      source: (result.meta && result.meta.source) || '',
      node: (result.meta && result.meta.node) || ''
    };
    fs.appendFileSync(logFile || DEFAULT_LOG, JSON.stringify(rec) + '\n', 'utf-8');
  } catch (_) {}
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function usage() {
  process.stderr.write(
    'MemPruner M1 classify.js v0.1.0\n' +
    '用法:\n' +
    '  node classify.js < input.json\n' +
    '  node classify.js --file entry.json\n' +
    '  node classify.js --route <memory.md> <flow_archive.md> < input.json\n' +
    '输入 JSON: {"entry":"...","meta":{"source":"...","node":"..."}}\n' +
    '退出码: 0=成功 1=内部错误(降级直写主记忆) 2=输入不合法(降级直写主记忆)\n'
  );
}

function parseStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

async function main(argv) {
  let inputRaw;
  let memoryFile = null;
  let flowFile = null;

  try {
    // 解析参数
    const args = argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--route') {
        memoryFile = args[i + 1] || null;
        flowFile = args[i + 2] || null;
        i += 2;
      } else if (args[i] === '--file') {
        const f = args[i + 1];
        if (!f) { usage(); process.exit(2); }
        inputRaw = fs.readFileSync(f, 'utf-8');
        i += 1;
      } else if (args[i] === '--help' || args[i] === '-h') {
        usage();
        process.exit(0);
      } else {
        usage();
        process.exit(2);
      }
    }

    // 读输入
    if (inputRaw === undefined) inputRaw = await parseStdin();
    let input;
    try {
      input = JSON.parse(inputRaw || '{}');
    } catch (e) {
      process.stderr.write('ERR 输入不合法: JSON 解析失败 ' + (e && e.message ? e.message : String(e)) + '\n');
      process.exit(2);
    }
    if (!input || typeof input !== 'object' || typeof input.entry !== 'string') {
      process.stderr.write('ERR 输入不合法: 需要 {"entry":"..."}\n');
      process.exit(2);
    }

    // 分类
    const result = classifyEntry(input);

    // 分流（仅 --route 模式，失败静默不影响输出）
    if (memoryFile || flowFile) {
      if (result.type === TYPES.FLOW && flowFile) {
        result.appended = appendLabeled(flowFile, result) ? 'flow_archive' : null;
      } else if (memoryFile) {
        result.appended = appendLabeled(memoryFile, result) ? 'memory' : null;
      }
    }

    // 日志 + 输出
    writeLog(DEFAULT_LOG, result);
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    // 失败静默：内部错误 → 输出降级结果，退出码 1，调用方直接写主记忆
    const ts = nowIso();
    const fallback = {
      ok: false,
      error: 'classify_crash: ' + (e && e.message ? e.message : String(e)),
      type: TYPES.KEEP,
      temp: TEMP_DEFAULT,
      route: 'memory',
      label: buildLabel(TYPES.KEEP, TEMP_DEFAULT, ts),
      entry: '',
      meta: {},
      ts
    };
    try { process.stdout.write(JSON.stringify(fallback) + '\n'); } catch (_) {}
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { classifyEntry, detectType, tempForType, routeForType, buildLabel, TYPES, TEMPS, TEMP_DEFAULT, RULES };
