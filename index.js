import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export const name = 'agent-workflow';
export const inject = ['tools', 'systemPrompt'];

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const STAGE_RE = /^[a-zA-Z0-9_.-]+$/;

function text(items) { return items.map((x) => ({ type: 'text', text: x })); }

/**
* 当前会话的工作区根目录：
* 1) 显式 DSH_PROJECT_ROOT 优先（临时调试用）
* 2) 工具执行上下文里的 session cwd（多工作区下才是对的）
* 3) 兜底 process.cwd()
*/
function rootFor(exec) {
  if (process.env.DSH_PROJECT_ROOT) return resolve(process.env.DSH_PROJECT_ROOT);
  const cwd = exec?.agent?.session?.header?.cwd;
  if (cwd) return resolve(cwd);
  return process.cwd();
}

/** 多帧 zstd 解码（与 harness 自身一致，不再依赖外部 zstd 可执行文件）。 */
const ZSTD_MAGIC = 4247762216;
function decompressZstd(raw) {
  let out = '';
  let offset = 0;
  while (offset < raw.length) {
    if (raw.length - offset < 4 || raw.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('corrupt zstd session log');
    const start = offset;
    offset += 4;
    const descriptor = raw.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      if (raw.length - offset < 3) throw new Error('truncated zstd frame');
      const blockHeader = raw.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      offset += blockType === 1 ? 1 : blockSize;
      if (lastBlock) break;
    }
    if (checksum) offset += 4;
    out += zstdDecompressSync(raw.subarray(start, offset)).toString('utf8');
  }
  return out;
}

// ===== new_ticket =====
const newTicket = defineTool({
  name: 'workflow_new_ticket',
  description: '生成一个 ticket spec 文件到 .agents/tickets/<name>.md（审计用，不派发）。',
  parameters: {
    name: { type: 'string', required: true, description: '任务名（小写字母/数字/下划线）' },
    goal: { type: 'string', description: '任务目标' },
    outputs: { type: 'string', description: '输出路径' },
    acceptance: { type: 'string', description: '验收标准' },
    role: { type: 'string', description: '角色，默认 implementer' },
    depends: { type: 'string', description: '依赖的上游任务名（逗号分隔），无则留空' },
    tier: { type: 'string', description: '档位 lite/standard/heavy，默认 lite' }
  },
  output: { schema: { type: 'object', additionalProperties: false, properties: { file: { type: 'string' }, taskId: { type: 'string' } } }, render: (a, v) => text(['已生成 ticket: ' + v.file + '（任务ID ' + v.taskId + '）']) },
  execute: async (a, exec) => {
    if (!NAME_RE.test(a.name)) throw new Error('无效任务名: 仅允许字母/数字/下划线/连字符');
    const r = rootFor(exec);
    const tier = ['lite', 'standard', 'heavy'].includes(a.tier) ? a.tier : 'lite';
    const stamp = Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 6);
    const taskId = a.name + '_' + stamp;
    const lines = ['# 任务：' + a.name, '', '- 任务ID：' + taskId, '- 档位：' + tier,
      '- 角色：' + (a.role || 'implementer'), '- 目标：' + (a.goal || ''),
      '- 输出：' + (a.outputs || ''), '- 验收：' + (a.acceptance || '')];
    if (tier !== 'lite') lines.push('- 依赖：' + (a.depends || '无'));
    lines.push('- 汇报：完成后写 .agents/reports/' + a.name + '.md（含执行轨迹）', '');
    const d = join(r, '.agents', 'tickets'); mkdirSync(d, { recursive: true });
    const file = join(d, a.name + '.md');
    writeFileSync(file, lines.join('\n'), 'utf8');
    return { file, taskId };
  }
});

// ===== check_report =====
const checkReport = defineTool({
  name: 'workflow_check_report',
  description: '校验 .agents/reports/<name>.md 格式；审查报告（文件名 -review 结尾或首行 审查结论:）额外校验首行机器可读结论与双轴。',
  parameters: { name: { type: 'string', required: true, description: '报告名（任务名）' } },
  output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } } } }, render: (a, v) => text(v.ok ? ['PASS: ' + a.name] : ['FAIL: ' + a.name + '\n - ' + v.problems.join('\n - ')]) },
  execute: async (a, exec) => {
    if (!NAME_RE.test(a.name)) throw new Error('无效任务名: 仅允许字母/数字/下划线/连字符');
    const file = join(rootFor(exec), '.agents', 'reports', a.name + '.md');
    if (!existsSync(file)) return { ok: false, problems: ['报告不存在 ' + file] };
    let t;
    try { t = readFileSync(file, 'utf8'); } catch (e) { return { ok: false, problems: ['无法读取报告 ' + file + ': ' + e.message] }; }
    const problems = [];
    const first = t.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
    const isReview = a.name.endsWith('-review') || /^审查结论[：:]/.test(first);
    if (!isReview) {
      for (const s of ['产出清单', '疑点清单', '合规红旗']) if (!t.includes('## ' + s)) problems.push('缺少章节: ' + s);
    } else {
      if (!/^审查结论[：:]\s*(PASS|FAIL)/i.test(first)) problems.push('审查报告首行必须是 审查结论: PASS/FAIL');
      for (const ax of ['Spec 轴', 'Standards 轴']) if (!t.includes(ax + ':') && !t.includes(ax + '：')) problems.push('缺少双轴结论: ' + ax);
    }
    return { ok: problems.length === 0, problems };
  }
});

// ===== smoke_test =====
const smokeTest = defineTool({
  name: 'workflow_smoke_test',
  description: '整体冒烟门禁：校验所有报告格式；strict 时要求每个 ticket 有报告且审查结论全 PASS。',
  parameters: { strict: { type: 'boolean', description: '严格模式' } },
  output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, failures: { type: 'array', items: { type: 'string' } } } }, render: (a, v) => text(v.ok ? ['PASS: smoke-test'] : ['FAIL: smoke-test\n - ' + v.failures.join('\n - ')]) },
  execute: async (a, exec) => {
    const r = rootFor(exec);
    const reportsDir = join(r, '.agents', 'reports');
    const ticketsDir = join(r, '.agents', 'tickets');
    const failures = [];
    if (!existsSync(reportsDir)) return { ok: false, failures: ['没有 .agents/reports/'] };
    const reportFiles = readdirSync(reportsDir).filter((f) => f.endsWith('.md') && f !== 'TEMPLATE.md' && f !== 'README.md');
    for (const f of reportFiles) {
      const name = f.slice(0, -3);
      let t;
      try { t = readFileSync(join(reportsDir, f), 'utf8'); } catch (e) { failures.push('无法读取报告: ' + f + '（' + e.message + '）'); continue; }
      const first = t.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
      const isReview = name.endsWith('-review') || /^审查结论[：:]/.test(first);
      if (isReview && !/^审查结论[：:]\s*PASS/i.test(first)) failures.push('审查结论未通过: ' + name);
    }
    if (a.strict && existsSync(ticketsDir)) {
      const reportNames = new Set(reportFiles.map((f) => f.slice(0, -3)));
      for (const f of readdirSync(ticketsDir)) {
        if (!f.endsWith('.md') || f === 'TEMPLATE.md' || f === 'README.md') continue;
        if (!reportNames.has(f.slice(0, -3))) failures.push('ticket 无报告: ' + f.slice(0, -3));
      }
    }
    return { ok: failures.length === 0, failures };
  }
});

// ===== trace =====
const trace = defineTool({
  name: 'workflow_trace',
  description: '提取子代理 ground-truth 执行轨迹（内置 node:zlib 多帧解压 zstd）。用法 list / session=<id> / latest-subagent。',
  parameters: { mode: { type: 'string', description: 'list | session | latest-subagent' }, sessionId: { type: 'string', description: 'mode=session 时的会话 id' } },
  output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } }, render: (a, v) => text([v.text]) },
  execute: async (a) => {
    const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
    const env = process.env.DSH_SESSION_JSONL;
    const sessionsDir = env ? resolve(env, '..', '..') : join(home, 'sessions');
    if (!existsSync(sessionsDir)) return { text: 'FAIL: 无法定位 sessions 目录' };
    const z = (f) => decompressZstd(readFileSync(f));
    const header = (id) => { const p = join(sessionsDir, id, 'session.jsonl.zstd'); if (!existsSync(p)) return null; try { return JSON.parse(z(p).split('\n')[0]); } catch (e) { return null; } };
    if (a.mode === 'list') {
      const rows = [];
      for (const id of readdirSync(sessionsDir)) { const h = header(id); if (h) rows.push('depth=' + (h.delegationDepth ?? 0) + ' ' + id); }
      return { text: rows.join('\n') || '(无会话)' };
    }
    if (a.mode === 'latest-subagent') {
      let latest = null;
      for (const id of readdirSync(sessionsDir)) { const h = header(id); if (h && (h.delegationDepth ?? 0) >= 1 && (!latest || h.createdAt > latest.createdAt)) latest = { id, h }; }
      if (!latest) return { text: '没有子代理会话' };
      a.sessionId = latest.id;
    }
    const id = a.sessionId; if (!id) return { text: 'FAIL: 需要 sessionId 或 mode=list' };
    const p = join(sessionsDir, id, 'session.jsonl.zstd'); if (!existsSync(p)) return { text: 'FAIL: 会话不存在 ' + id };
    let raw;
    try { raw = z(p); } catch (e) { return { text: 'FAIL: 解压失败 ' + id + '（' + e.message + '）' }; }
    const evs = raw.split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0));
    const out = [];
    for (const e of evs) {
      if (e.type === 'step/start') out.push('## turn ' + e.data.turn + ' / step ' + e.data.step);
      else if (e.type === 'tool/call') { let d = ''; try { const j = JSON.parse(e.data.arguments || '{}'); d = j.description || Object.keys(j).join(','); } catch (x) {} out.push('- [' + e.data.name + '] ' + String(d).slice(0, 100)); }
      else if (e.type === 'assistant/message') { const c = (e.data.message?.content || []).filter((b) => b.type !== 'reasoning').map((b) => b.text).join(' '); if (c) out.push('### 输出\n' + c.slice(0, 300)); }
    }
    return { text: out.join('\n') || '(空)' };
  }
});

// ===== archive =====
const archive = defineTool({
  name: 'workflow_archive',
  description: '归档 .agents/tickets + .agents/reports 到 .agents/archive/<stage>/，写 MANIFEST 保留依赖与结论。',
  parameters: { stage: { type: 'string', description: '阶段名，默认当日日期' } },
  output: { schema: { type: 'object', additionalProperties: false, properties: { moved: { type: 'number' }, manifest: { type: 'string' } } }, render: (a, v) => text(['归档 ' + v.moved + ' 个文件 → ' + v.manifest]) },
  execute: async (a, exec) => {
    const r = rootFor(exec);
    const stage = a.stage || new Date().toISOString().slice(0, 10);
    if (!STAGE_RE.test(stage)) throw new Error('无效阶段名: 仅允许字母/数字/下划线/点/连字符');
    const dest = join(r, '.agents', 'archive', stage);
    const moveDir = (src, sub) => { const d = join(dest, sub); mkdirSync(d, { recursive: true }); if (!existsSync(src)) return []; const moved = []; for (const f of readdirSync(src)) { if (!f.endsWith('.md')) continue; renameSync(join(src, f), join(d, f)); moved.push(f); } return moved; };
    const tickets = moveDir(join(r, '.agents', 'tickets'), 'tickets');
    const reports = moveDir(join(r, '.agents', 'reports'), 'reports');
    const lines = ['# MANIFEST ' + stage, '', '## tickets'];
    for (const f of tickets) { let t; try { t = readFileSync(join(dest, 'tickets', f), 'utf8'); } catch (e) { t = ''; } const m = t.split('\n').find((l) => l.includes('- 依赖')); lines.push('- ' + f + (m ? '（' + m.trim() + '）' : '')); }
    lines.push('## reports'); for (const f of reports) { let t; try { t = readFileSync(join(dest, 'reports', f), 'utf8'); } catch (e) { t = ''; } const first = t.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || ''; lines.push('- ' + f + (first.includes('审查结论') ? ' → ' + first : '')); }
    const manifest = join(dest, 'MANIFEST.md'); writeFileSync(manifest, lines.join('\n'), 'utf8');
    return { moved: tickets.length + reports.length, manifest };
  }
});

// ===== capability_check =====
/** 查找 skill：$DSH_HOME/skills/<name>，或插件自带的 vendor skills 目录。 */
function findSkill(home, name) {
  const direct = join(home, 'skills', name, 'SKILL.md');
  if (existsSync(direct)) return true;
  const profilesNm = join(home, 'profiles', 'node_modules');
  if (!existsSync(profilesNm)) return false;
  return scanForSkill(profilesNm, name, 0);
}
function scanForSkill(dir, name, depth) {
  if (depth > 7 || !existsSync(dir)) return false;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.name === name && basename(dir) === 'skills' && existsSync(join(full, 'SKILL.md'))) return true;
    if (e.name === 'skills' && existsSync(join(full, name, 'SKILL.md'))) return true;
    if (scanForSkill(full, name, depth + 1)) return true;
  }
  return false;
}

const capabilityCheck = defineTool({
  name: 'workflow_capability_check',
  description: '能力预检：扫描任务书+tickets 所需 skill/MCP，核对本地是否齐备，生成 docs/capabilities.md。',
  parameters: { taskbook: { type: 'string', description: '任务书路径，默认 docs/TASKBOOK.md' } },
  output: { schema: { type: 'object', additionalProperties: false, properties: { detected: { type: 'number' }, missing: { type: 'array', items: { type: 'string' } } } }, render: (a, v) => text(['预检: ' + v.detected + ' 项所需，' + v.missing.length + ' 项缺失' + (v.missing.length ? '\n缺失: ' + v.missing.join(', ') : '')]) },
  execute: async (a, exec) => {
    const r = rootFor(exec);
    const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
    const CAPS = [
      { kw: ['pdf'], res: 'skill:pdf-reader', desc: 'PDF' },
      { kw: ['ppt', 'pptx', '幻灯片'], res: 'skill:ppt-reader', desc: 'PPT' },
      { kw: ['图像', '截图', 'ocr', '视觉', '图片'], res: 'skill:vision-tools', desc: '视觉/OCR' },
      { kw: ['wsl', 'linux', 'ubuntu', 'bash', '编译'], res: 'skill:wsl2', desc: 'Linux' },
      { kw: ['matlab', 'simulink', '仿真'], res: 'mcp:simulink', desc: 'MATLAB/Simulink' },
      { kw: ['bilibili', '视频', '字幕'], res: 'mcp:bilibili', desc: 'B站视频' },
      { kw: ['网页', '爬虫', '抓取'], res: 'builtin:web_search', desc: '网页检索' },
      { kw: ['数据库', 'mysql', 'postgres', 'sql'], res: 'unknown:database', desc: '数据库' }
    ];
    let txt = '';
    const tb = a.taskbook || join(r, 'docs', 'TASKBOOK.md');
    if (existsSync(tb)) txt += readFileSync(tb, 'utf8') + '\n';
    const tdir = join(r, '.agents', 'tickets');
    if (existsSync(tdir)) for (const f of readdirSync(tdir)) if (f.endsWith('.md')) txt += readFileSync(join(tdir, f), 'utf8') + '\n';
    txt = txt.toLowerCase();
    const avail = (res) => { const [k, n] = res.split(':'); if (k === 'builtin') return true; if (k === 'skill') return findSkill(home, n); if (k === 'mcp') { const pd = join(home, 'profiles'); if (!existsSync(pd)) return false; for (const p of readdirSync(pd)) { const pf = join(pd, p, 'cordis.patch.yml'); if (existsSync(pf) && readFileSync(pf, 'utf8').includes(n)) return true; } return false; } return false; };
    const detected = CAPS.filter((c) => c.kw.some((k) => txt.includes(k)));
    const missing = detected.filter((c) => !avail(c.res));
    const lines = ['# 能力预检', '', '## 所需能力']; for (const c of detected) lines.push('- ' + c.desc + ' → ' + c.res + (avail(c.res) ? ' ✅' : ' ❌'));
    lines.push('## 缺失'); for (const c of missing) lines.push('- ' + c.desc + '（' + c.res + '）'); if (!missing.length) lines.push('- 无');
    mkdirSync(join(r, 'docs'), { recursive: true });
    writeFileSync(join(r, 'docs', 'capabilities.md'), lines.join('\n'), 'utf8');
    return { detected: detected.length, missing: missing.map((c) => c.desc) };
  }
});

// ===== 系统提示 SOP =====
const SOP = [
  '多代理工程流程（agent-workflow）：主 Agent 拷问拆解，子代理只执行不规划，reviewer 机器可读审查 + 打回循环。',
  '1. 拷问（grill）目标/边界/交付物/验收 → 2. 任务书 docs/TASKBOOK.md → 3. 能力预检 workflow_capability_check（缺失→市场找→需求规格→阻塞）',
  '4. 拆票 workflow_new_ticket → 5. 派发 subagent/subagent_fork/workflow（员工 flash/审查 pro）→ 6. 子代理写报告含执行轨迹',
  '7. 审查：reviewer 双轴 + 首行「审查结论: PASS/FAIL (第N轮)」+ 失败类型(执行偏差/设计偏差) + workflow_trace 交叉核对 + 打回(默认2轮)',
  '8. 集成 workflow_smoke_test strict → 9. workflow_archive 归档。三档：lite 直行 / standard 加审查 / heavy 完整校验。'
].join('\n');

export function apply(ctx) {
  for (const t of [newTicket, checkReport, smokeTest, trace, archive, capabilityCheck]) ctx.tools.register(t);
  ctx.systemPrompt.section({ name: 'agent-workflow', text: SOP, order: 117 });
}
