/**
 * indexer.test.js — MemPruner M4 indexer.js 回归测试
 * 运行：node --test test/indexer.test.js （零依赖，node:test 内置）
 * 覆盖：索引构建 / 中文+英文检索 / 自动升温（冷→温 + access/ref 刷新）/
 *       --apply 回写源文件 / 失败静默 / CLI 退出码
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const indexer = require('../indexer.js');
const { buildIndex, searchIndex, tokenize } = indexer;

const FIXTURE = path.join(__dirname, 'fixtures', 'memory_sample.md');

// 本机 node 为 Electron-as-node，子进程 CLI 测试用真实 node.exe
const NODE_CANDIDATES = ['C:\\Program Files\\nodejs\\node.exe', process.execPath];
const NODE_BIN = NODE_CANDIDATES.find((p) => fs.existsSync(p));
const CHILD_ENV = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
const CLI = path.join(__dirname, '..', 'indexer.js');

function tempCopy(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexer-test-'));
  const mem = path.join(dir, 'MEMORY.md');
  const idx = path.join(dir, 'memory.index.json');
  fs.copyFileSync(src, mem);
  return { dir, mem, idx };
}

/* ------------------------------------------------------------------ *
 * 1. 索引构建
 * ------------------------------------------------------------------ */
test('build：5 个带标签条目全部入索引，关键词倒排正确', () => {
  const t = tempCopy(FIXTURE);
  const r = buildIndex({ memoryFile: t.mem, indexFile: t.idx });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entries, 5, '应有 5 个条目');

  const data = JSON.parse(fs.readFileSync(t.idx, 'utf-8'));
  assert.strictEqual(data.entries.length, 5);
  // 中文 bigram 关键词存在
  assert.ok(data.index['索引'], '中文 bigram「索引」应在倒排表');
  assert.ok(data.index['indexer'], '英文词「indexer」应在倒排表');
  // 温度类型正确（按码点升序：冷<冻<温<热）
  const temps = data.entries.map((e) => e.temp);
  assert.deepStrictEqual(temps.sort(), ['冷', '冻', '温', '热', '热']);
  fs.rmSync(t.dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 2. 分词（零 LLM）
 * ------------------------------------------------------------------ */
test('tokenize：英文词小写 + 中文 bigram，无重复', () => {
  const tks = tokenize('Indexer 索引器 测试 LING-2026 索引器');
  assert.ok(tks.includes('indexer'));
  assert.ok(tks.includes('ling-2026'));
  assert.ok(tks.includes('索引'));
  const dup = tks.filter((x, i) => tks.indexOf(x) !== i);
  assert.strictEqual(dup.length, 0, '不应有重复 token');
});

/* ------------------------------------------------------------------ *
 * 3. 检索
 * ------------------------------------------------------------------ */
test('search：中文关键词命中冷条目，英文命中规则条目', () => {
  const t = tempCopy(FIXTURE);
  buildIndex({ memoryFile: t.mem, indexFile: t.idx });

  const r1 = searchIndex({ indexFile: t.idx, query: '自持' });
  assert.strictEqual(r1.ok, true);
  assert.ok(r1.hits.length >= 1, '「自持」应命中 SOMA 条目');
  assert.strictEqual(r1.hits[0].temp, '冷');

  const r2 = searchIndex({ indexFile: t.idx, query: 'UTC' });
  assert.ok(r2.hits.length >= 1, '「UTC」应命中规则条目');

  const r3 = searchIndex({ indexFile: t.idx, query: '不存在的词xyz' });
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(r3.hits.length, 0, '未命中应返回空');
  fs.rmSync(t.dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 4. 自动升温（降级可逆验证，验收标准）
 * ------------------------------------------------------------------ */
test('warm：冷条目命中后 temp 冷→温、last_access 刷新、ref_count+1', () => {
  const t = tempCopy(FIXTURE);
  buildIndex({ memoryFile: t.mem, indexFile: t.idx });

  const r = searchIndex({ indexFile: t.idx, query: '自持', warm: true });
  assert.ok(r.warmed.length >= 1);
  const warmed = r.warmed.find((w) => w.temp === '温' && w.ref_count === 1);
  assert.ok(warmed, '应有条目被升温且 ref_count=1');

  // 索引文件已更新
  const data = JSON.parse(fs.readFileSync(t.idx, 'utf-8'));
  const e = data.entries.find((x) => x.text.includes('SOMA'));
  assert.strictEqual(e.temp, '温');
  assert.ok(e.last_access);
  assert.strictEqual(e.ref_count, 1);

  // 再次命中 → ref_count=2
  searchIndex({ indexFile: t.idx, query: '自持', warm: true });
  const data2 = JSON.parse(fs.readFileSync(t.idx, 'utf-8'));
  assert.strictEqual(data2.entries.find((x) => x.text.includes('SOMA')).ref_count, 2);

  // 源文件默认不改（安全）
  const src = fs.readFileSync(t.mem, 'utf-8');
  assert.match(src, /TEMP:冷/, '默认不写回源文件');
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test('warm+apply：源文件标签 TEMP:冷 → TEMP:温 回写', () => {
  const t = tempCopy(FIXTURE);
  buildIndex({ memoryFile: t.mem, indexFile: t.idx });

  const r = searchIndex({ indexFile: t.idx, query: '自持', warm: true, apply: true });
  assert.strictEqual(r.ok, true);

  const src = fs.readFileSync(t.mem, 'utf-8');
  assert.ok(!src.includes('TEMP:冷'), '源文件冷标签应被替换');
  assert.ok(src.includes('TEMP:温'), '源文件应出现温标签');
  fs.rmSync(t.dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 5. 失败静默
 * ------------------------------------------------------------------ */
test('失败静默：无文件/坏索引/空查询不抛出，返回降级结果', () => {
  let r;
  assert.doesNotThrow(() => { r = buildIndex({ memoryFile: 'C:\\nonexistent\\MEMORY.md' }); });
  assert.strictEqual(r.ok, false);

  assert.doesNotThrow(() => { r = searchIndex({ indexFile: 'C:\\nonexistent\\idx.json', query: 'x' }); });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.hits, []);

  assert.doesNotThrow(() => { r = searchIndex({ query: '   ' }); });
  assert.strictEqual(r.ok, false);
});

/* ------------------------------------------------------------------ *
 * 6. CLI 契约
 * ------------------------------------------------------------------ */
test('CLI build：成功退出码 0，stdout JSON 含 entries', () => {
  const t = tempCopy(FIXTURE);
  const out = execFileSync(NODE_BIN, [CLI, 'build', '--memory', t.mem, '--index', t.idx], { encoding: 'utf-8', env: CHILD_ENV });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entries, 5);
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test('CLI search --warm：退出码 0 且输出 warmed', () => {
  const t = tempCopy(FIXTURE);
  execFileSync(NODE_BIN, [CLI, 'build', '--memory', t.mem, '--index', t.idx], { encoding: 'utf-8', env: CHILD_ENV });
  const out = execFileSync(NODE_BIN, [CLI, 'search', '自持', '--index', t.idx, '--warm'], { encoding: 'utf-8', env: CHILD_ENV });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.strictEqual(r.ok, true);
  assert.ok(r.hits.length >= 1);
  assert.ok(Array.isArray(r.warmed) && r.warmed.length >= 1);
  fs.rmSync(t.dir, { recursive: true, force: true });
});

test('CLI 用法错误：缺参数退出码 2', () => {
  assert.throws(() => execFileSync(NODE_BIN, [CLI], { encoding: 'utf-8', env: CHILD_ENV }), (e) => e.status === 2);
  assert.throws(() => execFileSync(NODE_BIN, [CLI, 'build'], { encoding: 'utf-8', env: CHILD_ENV }), (e) => e.status === 2);
  assert.throws(() => execFileSync(NODE_BIN, [CLI, 'search'], { encoding: 'utf-8', env: CHILD_ENV }), (e) => e.status === 2);
});
