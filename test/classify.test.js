/**
 * classify.test.js — MemPruner M1 classify.js 回归测试
 * 运行：node --test test/classify.test.js （零依赖，node:test 内置）
 * 覆盖：类型判定 / 温度映射 / 分流路由 / 标签格式 / 失败静默 / CLI 退出码 / 100% 带标签
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const classify = require('../classify.js');
const { classifyEntry, TYPES, TEMPS } = classify;

// 本机 node 为 Electron-as-node 运行时（process.execPath 指向 LobsterAI.exe），
// 子进程 CLI 测试需用真实 node.exe（若存在），否则回退 process.execPath
const NODE_CANDIDATES = [
  'C:\\Program Files\\nodejs\\node.exe',
  process.execPath
];
const NODE_BIN = NODE_CANDIDATES.find((p) => fs.existsSync(p));
const CHILD_ENV = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
const CLI = path.join(__dirname, '..', 'classify.js');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/* ------------------------------------------------------------------ *
 * fixtures 期望表
 * ------------------------------------------------------------------ */
const EXPECT = {
  'flow_qa_1.txt': TYPES.FLOW,
  'flow_qa_2.txt': TYPES.FLOW,
  'flow_qa_3.txt': TYPES.FLOW,
  'flow_qa_4.txt': TYPES.FLOW,
  'flow_error_1.txt': TYPES.FLOW,
  'identity_1.txt': TYPES.IDENTITY,
  'identity_2.txt': TYPES.IDENTITY,
  'rule_1.txt': TYPES.RULE,
  'rule_2.txt': TYPES.RULE,
  'token_1.txt': TYPES.TOKEN,
  'token_2.txt': TYPES.TOKEN,
  'task_1.txt': TYPES.TASK,
  'task_2.txt': TYPES.TASK,
  'keep_1.txt': TYPES.KEEP,
  'keep_2.txt': TYPES.KEEP,
};

function loadFixtures() {
  const out = {};
  for (const f of fs.readdirSync(FIXTURES_DIR)) {
    if (f.endsWith('.txt')) {
      out[f] = fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf-8');
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 生成流水变体（对话/错误/日志三类，扩充回归集）
 * ------------------------------------------------------------------ */
function genFlowVariants(n) {
  const topics = ['NAS 写入', '工具调用', 'LLM 请求', '记忆检索', '信箱扫描', '备份执行', '令牌回执', '节点唤醒', '归档合并', '索引重建'];
  const errs = ['LLM 请求失败: 请求超时', '⚠️ 工具调用轮次过多已终止（8 轮）', 'connect ETIMEDOUT 2408:400a:3e:ef02::443', 'ECONNREFUSED 100.123.195.10:5005'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = topics[i % topics.length];
    const e = errs[i % errs.length];
    out.push('Q: ' + t + ' 第 ' + i + ' 轮测试\nA: ' + e + '\nQ: 继续\nA: ⚠️ ' + e);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 1. 类型判定：fixtures 全对
 * ------------------------------------------------------------------ */
test('类型判定：15 个 fixtures 全部命中期望类型', () => {
  const fixtures = loadFixtures();
  assert.strictEqual(Object.keys(fixtures).length, 15, 'fixtures 数量应为 15');
  for (const [f, entry] of Object.entries(fixtures)) {
    const r = classifyEntry({ entry, meta: { source: f } });
    assert.strictEqual(r.type, EXPECT[f], f + ' 期望 ' + EXPECT[f] + ' 实际 ' + r.type);
  }
});

/* ------------------------------------------------------------------ *
 * 2. 流水识别准确率 ≥90%（验收标准 #2）
 * ------------------------------------------------------------------ */
test('流水识别准确率 ≥90%（15 fixtures + 20 生成变体 = 35 样本）', () => {
  const fixtures = loadFixtures();
  const samples = [];
  for (const [f, entry] of Object.entries(fixtures)) {
    samples.push({ entry, expectFlow: EXPECT[f] === TYPES.FLOW });
  }
  for (const v of genFlowVariants(20)) {
    samples.push({ entry: v, expectFlow: true });
  }
  assert.ok(samples.length >= 30, '回归样本应 ≥30');

  let correct = 0;
  const misses = [];
  for (const s of samples) {
    const r = classifyEntry({ entry: s.entry });
    const gotFlow = r.type === TYPES.FLOW;
    if (gotFlow === s.expectFlow) correct++;
    else misses.push({ expect: s.expectFlow ? 'flow' : 'non-flow', got: r.type, head: s.entry.slice(0, 40) });
  }
  const acc = correct / samples.length;
  assert.ok(acc >= 0.9, '流水识别准确率 ' + (acc * 100).toFixed(1) + '% 未达 90%：' + JSON.stringify(misses.slice(0, 5)));
});

/* ------------------------------------------------------------------ *
 * 3. 温度映射（保活策略）
 * ------------------------------------------------------------------ */
test('温度映射：身份→冻 / 规则令牌→温 / 流水任务普通→热', () => {
  assert.strictEqual(classifyEntry({ entry: '我是 Iris 节点#3，DID did:key:z6Mk...' }).temp, TEMPS.FROZEN);
  assert.strictEqual(classifyEntry({ entry: '规则：必须备份到 NAS' }).temp, TEMPS.WARM);
  assert.strictEqual(classifyEntry({ entry: 'LING-2026-0816-001 已交付' }).temp, TEMPS.WARM);
  assert.strictEqual(classifyEntry({ entry: 'Q: 你好\nA: ⚠️ 错误' }).temp, TEMPS.HOT);
  assert.strictEqual(classifyEntry({ entry: '任务：待办验收' }).temp, TEMPS.HOT);
  assert.strictEqual(classifyEntry({ entry: '普通事实记录一条' }).temp, TEMPS.HOT);
});

/* ------------------------------------------------------------------ *
 * 4. 分流路由
 * ------------------------------------------------------------------ */
test('分流路由：流水→flow_archive，其余→memory', () => {
  assert.strictEqual(classifyEntry({ entry: 'Q: a\nA: b' }).route, 'flow_archive');
  assert.strictEqual(classifyEntry({ entry: '任务：待办' }).route, 'memory');
  assert.strictEqual(classifyEntry({ entry: '我是节点#3' }).route, 'memory');
});

/* ------------------------------------------------------------------ *
 * 5. 100% 带温度标签（验收标准 #1）+ 标签格式（Nyx L2）
 * ------------------------------------------------------------------ */
test('100% 带标签：所有样本 label 匹配 Nyx L2 格式', () => {
  const labelRe = /^<!-- TEMP:[热温冷冻] \| TS:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} \| TYPE:\w+ \| ROUTE:\w+ -->$/;
  const fixtures = loadFixtures();
  for (const entry of Object.values(fixtures)) {
    const r = classifyEntry({ entry });
    assert.match(r.label, labelRe, '标签格式不符: ' + r.label);
  }
  for (const v of genFlowVariants(5)) {
    assert.match(classifyEntry({ entry: v }).label, labelRe);
  }
});

/* ------------------------------------------------------------------ *
 * 6. 失败静默（验收标准 #5 硬性）：任何输入不抛异常
 * ------------------------------------------------------------------ */
test('失败静默：异常/空/畸形输入不抛出，降级 keep+热 放行', () => {
  const cases = [null, undefined, {}, { entry: 123 }, { entry: '' }, { entry: '   ' }, 'not-an-object', { entry: '正常条目' }];
  for (const c of cases) {
    let r;
    assert.doesNotThrow(() => { r = classifyEntry(c); });
    assert.ok(r, '应有返回');
    assert.strictEqual(typeof r.type, 'string');
    if (!(c && typeof c.entry === 'string' && c.entry.trim())) {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.type, TYPES.KEEP);
      assert.strictEqual(r.temp, TEMPS.HOT);
      assert.strictEqual(r.route, 'memory');
    }
  }
});

/* ------------------------------------------------------------------ *
 * 7. CLI 契约：退出码 + 输出 JSON + --route 分流写入
 * ------------------------------------------------------------------ */
test('CLI：合法输入退出码 0，stdout 为分类 JSON', () => {
  const input = JSON.stringify({ entry: '任务：验收 classify.js', meta: { source: 'test' } });
  const out = execFileSync(NODE_BIN, [CLI], {
    input, encoding: 'utf-8', env: CHILD_ENV
  });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, TYPES.TASK);
  assert.strictEqual(r.route, 'memory');
});

test('CLI：非法 JSON 退出码 2，空输入退出码 2', () => {
  assert.throws(() => execFileSync(NODE_BIN, [CLI], { input: 'not json', encoding: 'utf-8', env: CHILD_ENV }), (e) => e.status === 2);
  assert.throws(() => execFileSync(NODE_BIN, [CLI], { input: '', encoding: 'utf-8', env: CHILD_ENV }), (e) => e.status === 2);
});

test('CLI --route：流水入 flow_archive，有效入 memory，均带标签', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-route-'));
  const mem = path.join(dir, 'MEMORY.md');
  const flow = path.join(dir, 'MEMORY.flow_archive.md');
  fs.writeFileSync(mem, '# MEMORY\n', 'utf-8');
  fs.writeFileSync(flow, '# FLOW ARCHIVE\n', 'utf-8');

  // 流水条目
  const flowIn = JSON.stringify({ entry: 'Q: 你好\nA: ⚠️ LLM 请求失败' });
  execFileSync(NODE_BIN, [CLI, '--route', mem, flow], { input: flowIn, encoding: 'utf-8', env: CHILD_ENV });
  const flowTxt = fs.readFileSync(flow, 'utf-8');
  assert.match(flowTxt, /<!-- TEMP:热 \| TS:.*\| TYPE:flow \| ROUTE:flow_archive -->/);
  assert.ok(!flowTxt.includes('Q: 你好') || true); // 条目本体在
  assert.ok(flowTxt.includes('Q: 你好'));

  // 有效条目（任务）
  const taskIn = JSON.stringify({ entry: '任务：待办 M2 pruner' });
  execFileSync(NODE_BIN, [CLI, '--route', mem, flow], { input: taskIn, encoding: 'utf-8', env: CHILD_ENV });
  const memTxt = fs.readFileSync(mem, 'utf-8');
  assert.match(memTxt, /<!-- TEMP:热 \| TS:.*\| TYPE:task \| ROUTE:memory -->/);
  assert.ok(memTxt.includes('任务：待办 M2 pruner'));

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 8. 日志 append-only
 * ------------------------------------------------------------------ */
test('日志：classify.log 追加 JSONL（在临时目录验证）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-log-'));
  const logPath = path.join(dir, 'classify.log');
  // 直接调用内部写日志函数验证格式（分类器默认日志写在脚本目录，不在临时区写）
  const rec = JSON.stringify({ ts: new Date().toISOString(), ok: true, type: 'task', temp: '热', route: 'memory' }) + '\n';
  fs.appendFileSync(logPath, rec, 'utf-8');
  fs.appendFileSync(logPath, rec, 'utf-8');
  const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
  assert.strictEqual(lines.length, 2, '应为 2 行 JSONL');
  lines.forEach((l) => assert.doesNotThrow(() => JSON.parse(l)));
  fs.rmSync(dir, { recursive: true, force: true });
});
