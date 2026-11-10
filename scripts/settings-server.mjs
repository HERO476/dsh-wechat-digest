#!/usr/bin/env node
/**
 * 本地设置页：编辑摘要的群聊、私聊（含自定义名字）、模型、定时参数，并可「立即总结」。
 *
 * 只监听 127.0.0.1，不做鉴权（本机自用）。写入 ~/.dsh/wechat-digest/config.json。
 * 与 DSH 设置面板共用 src/settings-api.js，行为一致。
 *
 * 跑法：node scripts/settings-server.mjs   然后打开 http://127.0.0.1:7199
 */
import { createServer } from 'node:http';

import { getState, postConfig, postReset, postRun, resolvePaths } from '../src/settings-api.js';

const PORT = Number(process.env.WECHAT_DIGEST_SETTINGS_PORT ?? 7199);
const PATHS = resolvePaths();

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function createSettingsServer(paths = PATHS) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

    // 只服务本机：Host 必须是回环（挡 DNS rebinding），写操作必须同源。
    const host = String(req.headers.host ?? '').toLowerCase();
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) {
      json(res, 403, { ok: false, reason: 'HOST_NOT_ALLOWED' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (typeof origin !== 'string' || new URL(origin).host.toLowerCase() !== host) {
        json(res, 403, { ok: false, reason: 'CROSS_ORIGIN_DENIED' });
        return;
      }
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }

    // 与 DSH 面板共用同一份实现
    if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, await getState(paths));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/config') {
      let incoming;
      try {
        incoming = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { ok: false, reason: 'BAD_JSON' });
        return;
      }
      try {
        json(res, 200, await postConfig(incoming, paths));
      } catch (err) {
        json(res, 400, { ok: false, reason: err?.message ?? 'CONFIG_INVALID' });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/reset') {
      json(res, 200, postReset(paths));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      try {
        json(res, 200, await postRun(paths));
      } catch (err) {
        json(res, 500, { ok: false, reason: String(err?.code ?? err?.message ?? err) });
      }
      return;
    }

    json(res, 404, { ok: false, reason: 'NOT_FOUND' });
  });
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>微信摘要 · 设置</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;padding:24px;font:14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;background:#12141a;color:#e6e8ee}
  h1{font-size:18px;margin:0 0 4px}
  .sub{color:#8b93a8;font-size:12px;margin-bottom:20px;word-break:break-all}
  section{background:#1a1d26;border:1px solid #262b38;border-radius:10px;padding:16px;margin-bottom:14px}
  h2{font-size:14px;margin:0 0 12px;color:#9fb0d0}
  label.row{display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer}
  input[type=checkbox]{width:16px;height:16px;accent-color:#5b8cff}
  input[type=time],input[type=text],select{background:#0f1218;color:#e6e8ee;border:1px solid #2c3242;border-radius:6px;padding:5px 8px}
  .item{display:flex;align-items:center;gap:8px;padding:5px 0}
  .item .name{min-width:110px}
  .item .key{color:#5f6879;font-size:11px}
  .item input[type=text]{flex:1;min-width:120px}
  .wd{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
  button{background:#2b4a8f;color:#fff;border:0;border-radius:7px;padding:8px 16px;cursor:pointer;font-size:13px}
  button.ghost{background:#252a36}
  #msg{margin-left:12px;font-size:13px}
  .empty{color:#8b93a8}
  .warn{background:#2a2015;border-color:#4a3a1c;color:#e8c887}
  pre{margin:10px 0 0;padding:10px 12px;border:1px solid #262b38;border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,monospace}
  .itemName{font-size:12px;color:#8b93a8;margin-top:10px}
</style></head><body>
<h1>微信摘要 · 设置</h1>
<div class="sub" id="paths"></div>

<section>
  <h2>群聊</h2>
  <label class="row"><input type="checkbox" id="groupsEnabled"> 读取群聊（总开关）</label>
  <div id="groupsBox" style="display:none">
    <div class="sub" style="margin:8px 0 4px">要总结哪些群（取消勾选 = 不读该群）；右边可填自定义名字</div>
    <div id="groups"></div>
  </div>
</section>

<section>
  <h2>私聊</h2>
  <label class="row"><input type="checkbox" id="privateEnabled"> 允许读取私聊（总开关，默认关闭）</label>
  <div id="privatesBox" style="display:none">
    <div class="sub" style="margin:8px 0 4px">允许哪些私聊（没勾的一律不读）</div>
    <div id="privates"></div>
  </div>
  <div class="sub" style="margin-top:8px">总开关关闭时，下面任何勾选都不会生效。</div>
</section>

<section>
  <h2>摘要方式</h2>
  <select id="summarizer">
    <option value="llm">模型摘要</option>
    <option value="heuristic">本地关键词规则（省钱、精度低）</option>
  </select>
  <div id="llmBox" style="display:none;margin-top:12px">
    <div class="sub" style="margin:0 0 6px">提供方</div>
    <select id="provider" style="width:100%"></select>
    <div class="sub" style="margin:10px 0 6px">模型</div>
    <select id="model" style="width:100%"></select>
    <div class="sub" id="llmHint" style="margin-top:8px"></div>
  </div>
</section>

<section>
  <h2>定时</h2>
  <label class="row"><input type="checkbox" id="schedEnabled"> 启用定时总结</label>
  <div style="margin-top:10px">执行时间 <input type="time" id="schedTime"></div>
  <div class="wd" id="weekdays"></div>
</section>

<section>
  <h2>立即总结</h2>
  <div class="sub" style="margin:0">按已保存的设置立刻跑一次，与定时任务共用同一套策略和闸门。</div>
  <div style="margin-top:10px">
    <button id="run">立即总结</button>
    <span id="runMsg" class="sub" style="margin-left:10px"></span>
  </div>
  <div id="runOut"></div>
</section>

<section class="warn">
  <div>定时总结由插件自己在 DSH 内消费（<code>lib/scheduler.mjs</code>），保存后按页面里的时间执行；不需要再同步 DSH 定时任务。同一分钟只会跑一次。</div>
</section>

<div>
  <button id="save">保存</button>
  <button class="ghost" id="reset">恢复默认</button>
  <span id="msg"></span>
</div>

<script>
let state = null;
let draft = null;

const $ = (id) => document.getElementById(id);

async function api(path, options) {
  const res = await fetch('/api/' + path, options);
  const text = await res.text();
  try { return { code: res.status, body: text ? JSON.parse(text) : null }; }
  catch (e) { return { code: res.status, body: { ok: false, reason: 'BAD_RESPONSE' } }; }
}

function cleanMap(map) {
  const out = {};
  for (const [key, value] of Object.entries(map || {})) {
    const entry = { enabled: !value || value.enabled !== false };
    if (value && typeof value.name === 'string' && value.name.trim()) entry.name = value.name.trim();
    out[key] = entry;
  }
  return out;
}

function itemRows(items, configMap, kind, emptyText) {
  if (state.roomsError) return '<div class="empty">读不到导出目录：' + state.roomsError + '</div>';
  if (!items || items.length === 0) return '<div class="empty">' + emptyText + '</div>';
  return items.map((item) => {
    const handle = item.roomHandle || item.key;
    const entry = configMap[handle] || {};
    const checked = entry.enabled !== false ? 'checked' : '';
    const shown = entry.name && entry.name.trim() ? entry.name.trim() : item.name;
    return '<div class="item">' +
      '<input type="checkbox" data-kind="' + kind + '" data-key="' + handle + '" data-field="enabled" ' + checked + '>' +
      '<span class="name">' + shown + '</span>' +
      '<input type="text" data-kind="' + kind + '" data-key="' + handle + '" data-field="name" placeholder="自定义名字（可选）" value="' + (entry.name || '') + '">' +
      '<span class="key">' + handle + '</span>' +
    '</div>';
  }).join('');
}

function render() {
  $('paths').textContent = '配置目录：~/.dsh/' + (state.dataDirName || 'wechat-digest') +
    (state.configError ? '　⚠ 配置有问题：' + state.configError + '（已按全关处理）' : '');

  $('groupsEnabled').checked = draft.groupsEnabled;
  $('groupsBox').style.display = draft.groupsEnabled ? 'block' : 'none';
  $('groups').innerHTML = itemRows(state.groups || [], draft.groups, 'group', '导出目录里还没有群。把导出的群放进 exports/ 后刷新本页。');

  $('privateEnabled').checked = draft.privateEnabled;
  $('privatesBox').style.display = draft.privateEnabled ? 'block' : 'none';
  $('privates').innerHTML = itemRows(state.privates || [], draft.privateChats, 'private', '导出目录里没有私聊记录。');

  $('summarizer').value = draft.summarizer;
  $('llmBox').style.display = draft.summarizer === 'llm' ? 'block' : 'none';
  const providers = state.providers || [];
  $('provider').innerHTML = providers.map((p) =>
    '<option value="' + p.id + '"' + (p.id === draft.provider ? ' selected' : '') + (p.callable ? '' : ' disabled') + '>' +
    p.label + (p.callable ? '' : '（不可直接调用）') + '</option>').join('');
  const cur = providers.find((p) => p.id === draft.provider);
  $('model').innerHTML = ((cur && cur.models) || []).map((m) =>
    '<option value="' + m.id + '"' + (m.id === draft.model ? ' selected' : '') + '>' + m.label + ' — ' + m.id + '</option>').join('');
  $('llmHint').textContent = cur && cur.reason ? '⚠ ' + cur.reason : '密钥从环境变量或 ~/.dsh/.credentials.yaml 读取，不写进仓库。';

  $('schedEnabled').checked = draft.schedEnabled;
  $('schedTime').value = draft.schedTime;
  $('weekdays').innerHTML = (state.weekdays || []).map((d) =>
    '<label class="row"><input type="checkbox" data-day="' + d.id + '"' + (draft.weekdays.includes(d.id) ? ' checked' : '') + '> ' + d.label + '</label>').join('');

  bindItemInputs();
}

function bindItemInputs() {
  document.querySelectorAll('.item input').forEach((el) => {
    el.onchange = () => {
      const key = el.dataset.key;
      const kind = el.dataset.kind;
      const field = el.dataset.field;
      const map = kind === 'group' ? draft.groups : draft.privateChats;
      const entry = Object.assign({}, map[key] || {});
      entry[field] = field === 'enabled' ? el.checked : el.value;
      map[key] = entry;
      if (field === 'name') {
        el.closest('.item').querySelector('.name').textContent = el.value.trim() || el.closest('.item').querySelector('.key').textContent;
      }
    };
  });
}

async function load() {
  const { code, body } = await api('state');
  if (code !== 200 || !body) { $('paths').textContent = '读取设置失败：HTTP ' + code; return; }
  state = body;
  draft = {
    groupsEnabled: body.config.groupsEnabled !== false,
    groups: Object.assign({}, (body.selected && body.selected.groups) || {}),
    privateEnabled: !!body.config.private.enabled,
    privateChats: Object.assign({}, (body.selected && body.selected.privateChats) || {}),
    summarizer: body.config.summarizer,
    provider: (body.config.llm && body.config.llm.provider) || '',
    model: (body.config.llm && body.config.llm.model) || '',
    schedEnabled: !!body.config.schedule.enabled,
    schedTime: body.config.schedule.time,
    weekdays: body.config.schedule.weekdays.slice(),
  };
  render();
}

$('groupsEnabled').onchange = (e) => { draft.groupsEnabled = e.target.checked; render(); };
$('privateEnabled').onchange = (e) => { draft.privateEnabled = e.target.checked; render(); };
$('summarizer').onchange = (e) => { draft.summarizer = e.target.value; render(); };
$('provider').onchange = (e) => {
  draft.provider = e.target.value;
  const cur = (state.providers || []).find((p) => p.id === draft.provider);
  draft.model = cur && cur.models && cur.models[0] ? cur.models[0].id : '';
  render();
};
$('model').onchange = (e) => { draft.model = e.target.value; };
$('schedEnabled').onchange = (e) => { draft.schedEnabled = e.target.checked; };
$('schedTime').onchange = (e) => { draft.schedTime = e.target.value; };
document.addEventListener('change', (e) => {
  if (e.target.dataset && e.target.dataset.day) {
    const day = e.target.dataset.day;
    const set = new Set(draft.weekdays);
    if (e.target.checked) set.add(day); else set.delete(day);
    draft.weekdays = set.size ? [...set] : [day];
  }
});

$('save').onclick = async () => {
  $('msg').textContent = '保存中…';
  const payload = {
    version: 1,
    groupsEnabled: !!draft.groupsEnabled,
    groups: cleanMap(draft.groups),
    private: { enabled: !!draft.privateEnabled, chats: cleanMap(draft.privateChats) },
    summarizer: draft.summarizer,
    llm: { provider: draft.provider, model: draft.model },
    schedule: {
      enabled: !!draft.schedEnabled,
      kind: 'weekly',
      weekdays: draft.weekdays.length ? draft.weekdays : ['MO'],
      time: draft.schedTime || '09:00',
      timeZone: (state.config.schedule && state.config.schedule.timeZone) || 'Asia/Shanghai'
    }
  };
  const { code, body } = await api('config', { method: 'POST', body: JSON.stringify(payload) });
  const ok = code === 200 && body && body.ok;
  $('msg').textContent = ok ? '已保存 · 群聊与开关立即生效' : '保存失败：' + ((body && body.reason) || 'HTTP ' + code);
  $('msg').style.color = ok ? '#7ad17a' : '#ff8080';
};

$('reset').onclick = async () => {
  const { code, body } = await api('reset', { method: 'POST' });
  const ok = code === 200 && body && body.ok;
  $('msg').textContent = ok ? '已恢复默认' : '失败：' + ((body && body.reason) || 'HTTP ' + code);
  if (ok) load();
};

$('run').onclick = async () => {
  $('run').disabled = true;
  $('runMsg').textContent = '总结中…';
  $('runOut').innerHTML = '';
  const { code, body } = await api('run', { method: 'POST' });
  $('run').disabled = false;
  if (code !== 200 || !body) { $('runMsg').textContent = '失败：HTTP ' + code; return; }
  $('runMsg').textContent = body.ok
    ? '完成 · 摘要 ' + body.summarized + ' 个会话 · 跳过 ' + body.skipped + ' · 拒绝 ' + body.denied
    : '失败：' + (body.error || '未知');
  $('runMsg').style.color = body.ok ? '#7ad17a' : '#ff8080';
  $('runOut').innerHTML = (body.items || []).map((item) =>
    '<div class="itemName">' + (item.name || item.roomHandle) + '</div><pre>' + item.text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>'
  ).join('');
};

load();
</script>
</body></html>`;

if (process.argv[1] && process.argv[1].endsWith('settings-server.mjs')) {
  const server = createSettingsServer();
  server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`设置页：http://127.0.0.1:${PORT}\n`);
    process.stdout.write(`配置目录：${PATHS.dataDir}\n`);
    process.stdout.write(`导出目录：${PATHS.exportDir}\n`);
  });
}
