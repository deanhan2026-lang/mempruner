#!/usr/bin/env node
/**
 * indexer.js — MemPruner M4 索引器 + 检索接口
 *
 * 排期：瞬（kronos-shun）2026-08-17 发令 · 归属模块：MemPruner（记忆工程，索引/调取）
 * 版本：v0.1.0（2026-08-17 初版）
 *
 * 设计原则（沿用 M1，不可违背）：
 *   1. 零 LLM 依赖 —— 纯 Node 标准库，无网络请求、无 API Key
 *   2. 失败静默 —— 任何异常不抛出；build/search 失败返回降级结果
 *   3. 可审计可追溯 —— 输出 JSON + append-only 日志；升温不删除条目
 *
 * 功能（对应 v1.1 方案 2.4 索引器）：
 *   1. 索引构建：扫描带温度标签（<!-- TEMP:... -->）的 MEMORY.md 条目，
 *      中文 bigram + 英文词零依赖分词，建倒排索引 → 索引 JSON
 *   2. 检索：关键词查询 → 按命中度排序返回条目（冷条目全量可查）
 *   3. 自动升温（B7 记忆重固化）：检索命中 → last_access 刷新 + ref_count+1；
 *      冷条目命中 → temp 升为 温（降级可逆验证）；--apply 可选回写源文件标签
 *
 * 接口契约（恒侧接入用，沿用 M1 风格）：
 *   CLI：  node indexer.js build --memory <MEMORY.md> [--index <out.json>]
 *          node indexer.js search <query> [--index <index.json>] [--limit N] [--warm] [--apply]
 *   输出：  stdout 单行 JSON
 *   退出码：0=成功；1=内部错误（失败静默，输出降级结果）；2=用法/输入错误
 *
 * 模块 API（内嵌用，永不抛异常）：
 *   const { buildIndex, searchIndex } = require('./indexer.js');
 *   const r = buildIndex({ memoryFile, indexFile });      // {ok, entries, index}
 *   const r = searchIndex({ indexFile, query, warm, apply }); // {ok, hits}
 */
'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = '0.1.0';
const DEFAULT_INDEX = path.join(__dirname, 'memory.index.json');
const DEFAULT_LOG = path.join(__dirname, 'indexer.log');

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function nowIso() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    sign + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60);
}

function nowUtc() {
  return new Date().toISOString();
}

function writeLog(rec) {
  try {
    fs.appendFileSync(DEFAULT_LOG, JSON.stringify(rec) + '\n', 'utf-8');
  } catch (_) {}
}

/* ------------------------------------------------------------------ *
 * 分词（零 LLM）：英文词 + 中文 bigram
 * ------------------------------------------------------------------ */

const STOP_CHARS = new Set('的了是在和与及我你他她它这那有也就都而或被把对从到为以于之其等个'.split(''));

/** 英文/数字 token（≥2 字符，小写） */
function enTokens(text) {
  const out = [];
  const re = /[A-Za-z0-9][A-Za-z0-9_\-]{1,}/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[0].toLowerCase());
  return out;
}

/** 中文 bigram（跳过含停用字的二元组） */
function zhBigrams(text) {
  const out = [];
  const zh = text.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of zh) {
    for (let i = 0; i < run.length - 1; i++) {
      const a = run[i];
      const b = run[i + 1];
      if (STOP_CHARS.has(a) || STOP_CHARS.has(b)) continue;
      out.push(a + b);
    }
  }
  return out;
}

function tokenize(text) {
  const t = (text || '').replace(/\r\n/g, '\n');
  const tokens = enTokens(t).concat(zhBigrams(t));
  const seen = new Set();
  const out = [];
  for (const tk of tokens) {
    if (!seen.has(tk)) { seen.add(tk); out.push(tk); }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 索引构建
 * ------------------------------------------------------------------ */

const LABEL_RE = /<!--\s*TEMP:([热温冷冻])\s*\|\s*TS:([^|]+)\s*\|[^>]*TYPE:(\w+)[^>]*-->/;

/** 段落切分（复用 memory_slim：CRLF 规范化 + 空行切分） */
function parseParas(content) {
  return content.replace(/\r\n/g, '\n').split(/\n{2,}/).filter((p) => p.trim().length > 0);
}

/** 从段落提取带标签条目；无标签段落跳过（M4 只索引已打标签条目，与 M1 100% 带标签衔接） */
function extractEntry(para, idx) {
  const lines = para.split('\n');
  // 标签行：段首或段内独立行
  let labelLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (LABEL_RE.test(lines[i])) { labelLineIdx = i; break; }
  }
  if (labelLineIdx === -1) return null;
  const labelLine = lines[labelLineIdx];
  const m = labelLine.match(LABEL_RE);
  const text = lines.filter((_, i) => i !== labelLineIdx).join('\n').trim();
  if (!text) return null;
  return {
    id: 'e' + idx,
    temp: m[1],
    ts: m[2].trim(),
    type: m[3],
    label: labelLine.trim(),
    text,
    keywords: tokenize(text + ' ' + m[3] + ' ' + m[1]),
    last_access: null,
    ref_count: 0
  };
}

/**
 * 构建索引
 * @param {{memoryFile?: string, indexFile?: string, content?: string}} input
 *   提供 content 时跳过读文件（测试用）；memoryFile 默认本目录 MEMORY.md
 * @returns {{ok:boolean, error?:string, entries:number, indexFile?:string}}
 */
function buildIndex(input) {
  const t0 = Date.now();
  try {
    const inArg = input || {};
    const memoryFile = inArg.memoryFile || path.join(__dirname, 'MEMORY.md');
    const indexFile = inArg.indexFile || DEFAULT_INDEX;
    let content = inArg.content;
    if (content === undefined) {
      if (!fs.existsSync(memoryFile)) {
        const r = { ok: false, error: 'no_memory_file', entries: 0 };
        writeLog({ ts: nowUtc(), op: 'build', ok: false, error: r.error });
        return r;
      }
      content = fs.readFileSync(memoryFile, 'utf-8');
    }
    const paras = parseParas(content);
    const entries = [];
    paras.forEach((p, i) => {
      const e = extractEntry(p, i);
      if (e) entries.push(e);
    });

    // 倒排索引
    const index = {};
    for (const e of entries) {
      for (const kw of e.keywords) {
        if (!index[kw]) index[kw] = [];
        index[kw].push(e.id);
      }
    }

    const out = { version: VERSION, built_at: nowIso(), source: memoryFile, entries, index };
    fs.writeFileSync(indexFile, JSON.stringify(out, null, 2), 'utf-8');
    writeLog({ ts: nowUtc(), op: 'build', ok: true, entries: entries.length, ms: Date.now() - t0 });
    return { ok: true, entries: entries.length, indexFile, keywords: Object.keys(index).length };
  } catch (e) {
    writeLog({ ts: nowUtc(), op: 'build', ok: false, error: e.message });
    return { ok: false, error: 'build_crash: ' + (e.message || String(e)), entries: 0 };
  }
}

/* ------------------------------------------------------------------ *
 * 检索 + 自动升温
 * ------------------------------------------------------------------ */

function loadIndex(indexFile) {
  if (!fs.existsSync(indexFile)) return { ok: false, error: 'no_index_file' };
  try {
    const data = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
    if (!data || !Array.isArray(data.entries) || !data.index) return { ok: false, error: 'bad_index_format' };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: 'bad_index_json' };
  }
}

/**
 * 检索（可选自动升温）
 * @param {{indexFile?: string, query: string, limit?: number, warm?: boolean, apply?: boolean}} input
 * @returns {{ok:boolean, error?:string, hits:Array, warmed?:Array}}
 */
function searchIndex(input) {
  const t0 = Date.now();
  try {
    const inArg = input || {};
    const indexFile = inArg.indexFile || DEFAULT_INDEX;
    const query = (inArg.query || '').trim();
    const limit = inArg.limit || 10;
    if (!query) {
      return { ok: false, error: 'empty_query', hits: [] };
    }

    const loaded = loadIndex(indexFile);
    if (!loaded.ok) {
      writeLog({ ts: nowUtc(), op: 'search', ok: false, error: loaded.error, query });
      return { ok: false, error: loaded.error, hits: [] };
    }
    const { entries, index } = loaded.data;

    const qTokens = tokenize(query);
    if (qTokens.length === 0) {
      return { ok: false, error: 'empty_tokens', hits: [] };
    }

    // 命中度：id -> 命中词数
    const scores = new Map();
    for (const tk of qTokens) {
      const ids = index[tk];
      if (ids) {
        for (const id of ids) scores.set(id, (scores.get(id) || 0) + 1);
      }
    }

    const hits = entries
      .filter((e) => scores.has(e.id))
      .map((e) => ({ id: e.id, temp: e.temp, type: e.type, ts: e.ts, text: e.text.slice(0, 200), score: scores.get(e.id) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const warmed = [];
    if (inArg.warm && hits.length > 0) {
      const now = nowIso();
      const idSet = new Set(hits.map((h) => h.id));
      let changed = false;
      for (const e of entries) {
        if (idSet.has(e.id)) {
          e.last_access = now;
          e.ref_count = (e.ref_count || 0) + 1;
          if (e.temp === '冷') { e.temp = '温'; changed = true; }
          warmed.push({ id: e.id, temp: e.temp, last_access: now, ref_count: e.ref_count });
        }
      }
      // 写回索引
      const out = { version: loaded.data.version || VERSION, built_at: nowIso(), source: loaded.data.source, entries, index };
      fs.writeFileSync(indexFile, JSON.stringify(out, null, 2), 'utf-8');

      // --apply：可选回写源文件标签（冷→温）
      if (inArg.apply && changed && loaded.data.source && fs.existsSync(loaded.data.source)) {
        try {
          let src = fs.readFileSync(loaded.data.source, 'utf-8');
          let replaced = 0;
          for (const e of entries) {
            if (idSet.has(e.id) && e.label) {
              const newLabel = e.label.replace(/TEMP:冷/, 'TEMP:温');
              if (newLabel !== e.label) {
                src = src.split(e.label).join(newLabel);
                e.label = newLabel;
                replaced++;
              }
            }
          }
          if (replaced > 0) {
            fs.writeFileSync(loaded.data.source, src, 'utf-8');
            fs.writeFileSync(indexFile, JSON.stringify({ version: loaded.data.version || VERSION, built_at: nowIso(), source: loaded.data.source, entries, index }, null, 2), 'utf-8');
          }
        } catch (_) {}
      }
    }

    writeLog({ ts: nowUtc(), op: 'search', ok: true, query, hits: hits.length, warm: !!inArg.warm, ms: Date.now() - t0 });
    return { ok: true, hits, warmed, query, limit };
  } catch (e) {
    writeLog({ ts: nowUtc(), op: 'search', ok: false, error: e.message });
    return { ok: false, error: 'search_crash: ' + (e.message || String(e)), hits: [] };
  }
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function usage() {
  process.stderr.write(
    'MemPruner M4 indexer.js v0.1.0\n' +
    '用法:\n' +
    '  node indexer.js build --memory <MEMORY.md> [--index <out.json>]\n' +
    '  node indexer.js search <query> [--index <index.json>] [--limit N] [--warm] [--apply]\n' +
    '输出: stdout 单行 JSON\n' +
    '退出码: 0=成功 1=内部错误(失败静默) 2=用法/输入错误\n'
  );
}

function main(argv) {
  try {
    const args = argv.slice(2);
    const cmd = args[0];
    if (cmd === 'build') {
      let memoryFile;
      let indexFile;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--memory') { memoryFile = args[i + 1]; i++; }
        else if (args[i] === '--index') { indexFile = args[i + 1]; i++; }
        else { usage(); process.exit(2); }
      }
      if (!memoryFile) { usage(); process.exit(2); }
      const r = buildIndex({ memoryFile, indexFile });
      process.stdout.write(JSON.stringify(r) + '\n');
      process.exit(r.ok ? 0 : 1);
    } else if (cmd === 'search') {
      let query;
      let indexFile;
      let limit = 10;
      let warm = false;
      let apply = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--index') { indexFile = args[i + 1]; i++; }
        else if (args[i] === '--limit') { limit = parseInt(args[i + 1], 10) || 10; i++; }
        else if (args[i] === '--warm') warm = true;
        else if (args[i] === '--apply') apply = true;
        else if (args[i].startsWith('--')) { usage(); process.exit(2); }
        else query = args[i];
      }
      if (!query) { usage(); process.exit(2); }
      const r = searchIndex({ indexFile, query, limit, warm, apply });
      process.stdout.write(JSON.stringify(r) + '\n');
      process.exit(r.ok ? 0 : 1);
    } else {
      usage();
      process.exit(2);
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'cli_crash: ' + (e.message || String(e)), hits: [] }) + '\n');
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { buildIndex, searchIndex, tokenize, extractEntry, parseParas, VERSION };
