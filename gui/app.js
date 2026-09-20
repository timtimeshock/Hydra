const $ = (id) => document.getElementById(id);
const t = (key, vars) => (window.HydraI18n ? window.HydraI18n.t(key, vars) : key);

const DEFAULT_PROMPT = `Ověř opravy v C:\\Hydra. Nic mimo C:\\Hydra. Klíče a hesla nikam nepiš. Neptat se člověka.

1) hydra-council.mjs: publish/handoff jen claude, opus, codex — ne local.
2) Po Council musí být v okně čitelná odpověď.
3) Kritiku dělá Opus (stejné CLI claude), zápis Codex.

Když to v souborech už je, nic nepřepisuj. Ohlas, co jsi ověřil.`;

let requestBusy = false;
let jobBusy = false;
let hasActiveWork = false;

function refreshButtons() {
  const busy = requestBusy || jobBusy;
  ['btn-chat', 'btn-send', 'btn-council', 'btn-clear'].forEach((id) => {
    const btn = $(id);
    if (btn) btn.disabled = busy;
  });
  const stopBtn = $('btn-stop');
  if (stopBtn) stopBtn.disabled = !hasActiveWork || requestBusy;
}

function setBusy(busy) {
  requestBusy = busy;
  refreshButtons();
}

function setHint(text, warn) {
  const el = $('hint');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('warn', Boolean(warn));
}

function formatDurationUi(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return t('durSec', { n: s });
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? t('durMinSec', { n: m, s: r }) : t('durMin', { n: m });
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? t('durHourMin', { n: h, m: rest }) : t('durHour', { n: h });
}

function titleCaseName(name) {
  const s = String(name || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function runStatusCode(rs, level) {
  if (rs.code) return rs.code;
  if (level === 'down') return 'down';
  if (level === 'idle') return 'idle';
  if (level === 'hanging') {
    const title = String(rs.title || '');
    if (/ZASTAVUJI|STOPPING|STOPPE/i.test(title)) return 'stopping';
    return 'hanging';
  }
  if (/PŘEMÝŠLÍ|THINKING|DENKT/i.test(String(rs.title || ''))) return 'thinking';
  return 'running';
}

function localizedRunTitle(code) {
  const map = {
    down: 'statusDown',
    idle: 'statusIdle',
    running: 'statusRunning',
    thinking: 'statusThinking',
    hanging: 'statusHanging',
    stopping: 'statusStopping',
  };
  return t(map[code] || 'statusIdle');
}

function localizedRunDetail(rs, code) {
  if (code === 'down') return t('statusDetailDown');
  if (code === 'idle') return t('statusDetailIdle');

  const who = titleCaseName(rs.agent) || 'Agent';
  const kind = rs.kind || t('statusJob');
  const bits = [kind, who !== 'Agent' ? who : '', rs.phase || ''].filter(Boolean);
  if (rs.round) bits.push(t('statusRound', { n: rs.round }));
  const where = bits.join(' · ');
  const elapsed = formatDurationUi(rs.elapsedMs);
  const silent = formatDurationUi(rs.silentMs);

  if (code === 'stopping') return t('statusDetailStopping', { where });
  if (code === 'hanging') return t('statusDetailHanging', { where, silent, elapsed, who });
  if (code === 'thinking') return t('statusDetailThinking', { where, elapsed, silent, who });
  return t('statusDetailRunning', { where, elapsed, silent });
}

function localizeLogLine(line) {
  const m = String(line || '').match(/^(\[[^\]]+\]\s*)?(.*)$/);
  const prefix = m?.[1] || '';
  const body = m?.[2] || '';
  if (body === 'Log vymazán' || body === 'Log cleared' || body === 'Log geleert') {
    return `${prefix}${t('logCleared')}`;
  }
  return line;
}

function setRunStatus(data) {
  const box = $('run-status');
  const title = $('run-title');
  const detail = $('run-detail');
  if (!box || !title || !detail) return;
  const rs = data.runStatus || {};
  const level = rs.level || (data.daemon ? 'idle' : 'down');
  const code = runStatusCode(rs, level);
  box.className = 'run-status ' + level;
  title.textContent = localizedRunTitle(code);
  detail.textContent = localizedRunDetail(rs, code);
  jobBusy = Boolean(data.job) || level === 'running' || level === 'hanging';
  refreshButtons();
}

function readPrompt() {
  const box = $('prompt');
  let prompt = box.value.trim();
  if (!prompt) {
    box.value = DEFAULT_PROMPT;
    prompt = DEFAULT_PROMPT;
    box.focus();
    setHint(t('filledPrompt'), true);
    return '';
  }
  setHint(t('hintAgents'));
  return prompt;
}

async function snapshot() {
  const res = await fetch('/api/snapshot');
  const data = await res.json();
  const home = data.hydraRoot || 'C:\\Hydra';
  const root = data.projectRoot || '';
  const same = root && home && root.replace(/\\+$/, '').toLowerCase() === home.replace(/\\+$/, '').toLowerCase();
  $('project').textContent = same
    ? t('projectStandalone')
    : (root ? `${t('projectLabel')}: ${data.project}  ·  ${root}` : `${t('projectLabel')}: —`);
  $('daemon').className = 'pill ' + (data.daemon ? 'on' : 'off');
  $('daemon').textContent = data.daemon ? t('daemonOk') : t('daemonOff');
  const net = $('net');
  if (net) {
    if (data.internetOk === true) {
      net.className = 'pill on';
      net.textContent = t('netOnline');
    } else if (data.internetOk === false) {
      net.className = 'pill off';
      net.textContent = t('netOffline');
    } else {
      net.className = 'pill';
      net.textContent = t('netChecking');
    }
  }
  if (data.internetOk === false) {
    setHint(t('netOfflineHint'), true);
  }
  $('job').textContent = data.job ? t('jobRunning', { kind: data.job.kind }) : '';
  setRunStatus(data);

  let agentsWorking = false;
  for (const name of ['claude', 'opus', 'codex']) {
    const status = data.agents?.[name] || 'idle';
    const card = document.querySelector(`[data-agent="${name}"]`);
    if (!card) continue;
    card.className = status;
    $(`s-${name}`).textContent = status === 'working' ? t('agentWorking')
      : status === 'hanging' ? t('agentHanging')
      : status === 'error' ? t('agentError') : t('agentIdle');
    $(`m-${name}`).textContent = data.models?.[name] || '—';
    if (status === 'working' || status === 'hanging') agentsWorking = true;
  }

  cachedTasks = data.tasks || [];
  const activeTasks = cachedTasks.filter((task) =>
    task.status === 'in_progress' || task.status === 'todo'
  );

  $('tasks').innerHTML = cachedTasks.length
    ? cachedTasks.map((task) => `<li><strong>${task.id} · ${task.status}</strong><span>${task.owner || ''} — ${escapeHtml(task.title || '')}</span></li>`).join('')
    : `<li class="empty">${t('noTasks')}</li>`;

  hasActiveWork = Boolean(data.job) || agentsWorking || activeTasks.length > 0;
  refreshButtons();

  renderAnswers(data.answers || []);
  renderLog(data.log || []);
}

function logLineKind(line) {
  const raw = String(line || '').replace(/^\[[^\]]+\]\s*/, '');
  if (!raw.trim()) return '';
  if (/\bPublish error\b/i.test(raw)) return 'err';
  if (/Unknown agent/i.test(raw)) return 'err';
  if (/"ok"\s*:\s*false/.test(raw)) return 'err';
  if (/\b(FAILED|TIMEOUT|ETIMEDOUT)\b/.test(raw)) return 'err';
  if (/Hotovo, ale|není čitelná odpověď|bez čitelné odpovědi/i.test(raw)) return 'err';
  if (/Chat error|GUI error|✗|startup failure/i.test(raw)) return 'err';
  if (/skončil[oa].*\(\s*kód\s+(?!0\b)/i.test(raw)) return 'err';
  if (/Exit [Cc]ode:\s*(?!0\b)/.test(raw)) return 'err';
  if (/\berror:\s+\S/i.test(raw)) return 'err';
  if (/^\s*"error"\s*:\s*"[^"]+/.test(raw)) return 'err';
  if (/\b(WARNING|⚠)\b/.test(raw) || /^\s*[!⚠]/.test(raw)) return 'warn';
  if (/VISÍ|pořád běží|CLI nic nevypisuje|zastaveno|Zastavuji/i.test(raw)) return 'warn';
  return '';
}

let lastLogKey = '';

function renderLog(lines) {
  const lang = window.HydraI18n ? window.HydraI18n.getLang() : 'cs';
  const key = `${lang}\n${lines.join('\n')}`;
  if (key === lastLogKey) return;
  lastLogKey = key;
  const logEl = $('log');
  const stick = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  logEl.innerHTML = lines.length
    ? lines.map((line) => {
      const localized = localizeLogLine(line);
      const kind = logLineKind(line);
      const cls = kind ? ` class="log-${kind}"` : '';
      return `<span${cls}>${escapeHtml(localized)}</span>`;
    }).join('\n')
    : '';
  if (stick) logEl.scrollTop = logEl.scrollHeight;
}

let lastAnswersKey = '';
let cachedAnswers = [];
let cachedTasks = [];

function formatTask(task) {
  return `${task.id || ''} · ${task.status || ''} · ${task.owner || ''} — ${task.title || ''}`;
}

function formatDiagResult(r) {
  const icon = r.skip ? t('diagSkip') : r.ok ? t('diagOk') : t('diagErr');
  const name = r.nameKey ? t(r.nameKey) : (r.name || '?');
  const vars = { ...(r.vars || {}) };
  if (vars.planKey) {
    vars.plan = t(vars.planKey);
    delete vars.planKey;
  }
  const detail = r.detailKey ? t(r.detailKey, vars) : (r.detail || '');
  return `${icon}  ${name}${detail ? `\n   ${detail}` : ''}`;
}

function parseDiagPayload(answer) {
  try {
    const obj = JSON.parse(String(answer || ''));
    if (obj && obj.hydraDiag === 1 && Array.isArray(obj.results)) return obj.results;
  } catch { /* plain text */ }
  return null;
}

function displayAnswerTitle(a) {
  if (parseDiagPayload(a.answer)) return t('diagTitle');
  return a.title || '';
}

function displayAnswerBody(a) {
  const results = parseDiagPayload(a.answer);
  if (results) return results.map(formatDiagResult).join('\n');
  return a.answer || t('noAnswerBody');
}

function formatAnswer(a) {
  const head = `${a.agent || '?'} · ${a.id || ''} · ${a.status || ''}`;
  const title = displayAnswerTitle(a);
  const body = displayAnswerBody(a);
  return title ? `${head}\n${title}\n\n${body}` : `${head}\n\n${body}`;
}

function renderAnswers(answers) {
  const lang = window.HydraI18n ? window.HydraI18n.getLang() : 'cs';
  const key = `${lang}:${JSON.stringify(answers)}`;
  if (key === lastAnswersKey) return;
  lastAnswersKey = key;
  cachedAnswers = answers;
  $('answers').innerHTML = answers.length
    ? answers.map((a, i) => `<article class="answer"><div class="answer-top"><div><strong>${escapeHtml(a.agent || '?')} · ${escapeHtml(a.id || '')} · ${escapeHtml(a.status || '')}</strong><em>${escapeHtml(displayAnswerTitle(a))}</em></div><div class="answer-actions"><button class="ghost copy" type="button" data-copy="${i}">${t('copy')}</button><button class="ghost wipe" type="button" data-hide="${escapeHtml(a.id || '')}">${t('clear')}</button></div></div><p>${escapeHtml(displayAnswerBody(a))}</p></article>`).join('')
    : `<p class="empty">${t('noAnswers')}</p>`;
}

function copyText(text) {
  const value = String(text || '');
  if (!value) return false;
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:8px;left:8px;width:240px;height:64px;opacity:0.01;z-index:2147483647';
  document.body.appendChild(ta);
  ta.focus({ preventScroll: true });
  ta.select();
  ta.setSelectionRange(0, value.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (ok) return true;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(value).then(() => true).catch(() => false);
  }
  return false;
}

function showCopyFallback(text) {
  const old = document.getElementById('copy-fallback');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'copy-fallback';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px';
  overlay.innerHTML = '<div style="background:#171b22;border:1px solid #2a3140;border-radius:12px;padding:16px;max-width:720px;width:100%;max-height:80vh;display:flex;flex-direction:column;gap:10px">'
    + `<p style="margin:0;color:#e8edf5">${escapeHtml(t('copyBlocked'))}</p>`
    + '<textarea id="copy-fallback-text" style="width:100%;min-height:220px;background:#0e1116;color:#e8edf5;border:1px solid #2a3140;border-radius:8px;padding:10px;font:13px/1.4 Consolas,monospace"></textarea>'
    + `<button type="button" id="copy-fallback-close" style="align-self:flex-end;padding:8px 14px;border:0;border-radius:8px;background:#243044;color:#e8edf5;cursor:pointer">${escapeHtml(t('close'))}</button>`
    + '</div>';
  document.body.appendChild(overlay);
  const box = overlay.querySelector('#copy-fallback-text');
  box.value = text;
  box.focus();
  box.select();
  const close = () => overlay.remove();
  overlay.querySelector('#copy-fallback-close').onclick = close;
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
}

async function copyOrShow(text, btn) {
  const ok = await copyText(text);
  flashCopy(btn, ok);
  if (!ok) showCopyFallback(text);
  return ok;
}

function answersCopyText() {
  if (cachedAnswers.length) {
    return cachedAnswers.map(formatAnswer).join('\n\n----\n\n');
  }
  const visible = ($('answers')?.innerText || '').trim();
  if (visible && visible !== t('noAnswers')) return visible;
  return '';
}

function flashCopy(btn, ok) {
  if (!btn) return;
  const prev = btn.textContent;
  btn.textContent = ok ? t('copied') : t('copyFailed');
  setTimeout(() => { btn.textContent = prev; }, 1200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({ ok: false, error: t('invalidResponse') }));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

$('btn-chat').onclick = async () => {
  const prompt = readPrompt();
  if (!prompt) return;
  setBusy(true);
  try {
    const data = await post('/api/chat', { prompt });
    if (data.response) $('prompt').value = '';
  } catch (err) {
    setHint(err.message, true);
  } finally {
    setBusy(false);
    snapshot();
  }
};

$('btn-send').onclick = async () => {
  const prompt = readPrompt();
  if (!prompt) return;
  setBusy(true);
  try {
    await post('/api/run', { prompt, mode: 'auto' });
    setHint(t('sentAgents'));
  } catch (err) {
    setHint(err.message, true);
  } finally {
    setBusy(false);
    snapshot();
  }
};

$('btn-council').onclick = async () => {
  const prompt = readPrompt();
  if (!prompt) return;
  setBusy(true);
  try {
    await post('/api/run', { prompt, mode: 'council' });
    setHint(t('councilRunning'));
  } catch (err) {
    setHint(err.message, true);
  } finally {
    setBusy(false);
    snapshot();
  }
};

if ($('btn-stop')) $('btn-stop').onclick = async () => {
  if (!confirm(t('confirmStop'))) return;
  setBusy(true);
  try {
    const data = await post('/api/stop', {});
    const parts = [];
    if (data.stopped) parts.push(t('jobStopped'));
    if (data.cancelled > 0) parts.push(`${data.cancelled} ${t('tasksCancelled')}`);
    const msg = parts.length > 0 ? parts.join(', ') : t('nothingRunning');
    setHint(t('stoppedMsg', { msg }));
    $('prompt').value = '';
    $('prompt').focus();
  } catch (err) {
    setHint(t('stopError', { msg: err.message }), true);
  } finally {
    setBusy(false);
    snapshot();
  }
};

$('btn-clear').onclick = async () => {
  setBusy(true);
  try {
    await post('/api/clear', {});
  } catch (err) {
    alert(err.message);
  } finally {
    setBusy(false);
    snapshot();
  }
};

$('answers').onclick = async (ev) => {
  const hideBtn = ev.target.closest('[data-hide]');
  if (hideBtn) {
    const id = hideBtn.dataset.hide;
    if (!id) return;
    try { await post('/api/answers/hide', { id }); } catch (err) { alert(err.message); }
    lastAnswersKey = '';
    snapshot();
    return;
  }
  const btn = ev.target.closest('[data-copy]');
  if (!btn) return;
  const item = cachedAnswers[Number(btn.dataset.copy)];
  if (!item) return;
  await copyOrShow(formatAnswer(item), btn);
};

$('btn-copy-all').onclick = async () => {
  const text = answersCopyText();
  if (!text) {
    flashCopy($('btn-copy-all'), false);
    setHint(t('nothingToCopy'), true);
    return;
  }
  await copyOrShow(text, $('btn-copy-all'));
};

$('btn-clear-answers').onclick = async () => {
  if (!cachedAnswers.length) return;
  if (!confirm(t('confirmClearAnswers'))) return;
  try { await post('/api/answers/clear', {}); } catch (err) { alert(err.message); }
  lastAnswersKey = '';
  snapshot();
};

$('btn-copy-prompt').onclick = async () => {
  const text = $('prompt').value || '';
  if (!text.trim()) {
    flashCopy($('btn-copy-prompt'), false);
    return;
  }
  await copyOrShow(text, $('btn-copy-prompt'));
};

if ($('btn-load-prompt') && $('prompt-file')) {
  $('btn-load-prompt').onclick = () => $('prompt-file').click();
  $('prompt-file').onchange = async () => {
    const file = $('prompt-file').files && $('prompt-file').files[0];
    $('prompt-file').value = '';
    if (!file) return;
    try {
      const text = await file.text();
      if (!String(text || '').trim()) {
        setHint(t('emptyFile'), true);
        return;
      }
      $('prompt').value = text;
      $('prompt').focus();
      setHint(t('loadedFile', { name: file.name, n: text.length }));
    } catch (err) {
      setHint(t('loadFileError', { msg: err.message }), true);
    }
  };
}

$('btn-clear-prompt').onclick = () => {
  $('prompt').value = '';
  $('prompt').focus();
  setHint(t('promptCleared'));
};

function bumpPane(id, delta) {
  const pane = $(id);
  const next = Math.max(160, Math.min(720, pane.getBoundingClientRect().height + delta));
  pane.style.height = `${next}px`;
}

$('btn-tasks-grow').onclick = () => bumpPane('pane-tasks', 80);
$('btn-tasks-shrink').onclick = () => bumpPane('pane-tasks', -80);
$('btn-log-grow').onclick = () => bumpPane('pane-log', 80);
$('btn-log-shrink').onclick = () => bumpPane('pane-log', -80);

const splitter = $('split-col');
splitter.onmousedown = (ev) => {
  ev.preventDefault();
  splitter.classList.add('drag');
  const tasks = $('pane-tasks');
  const log = $('pane-log');
  const startX = ev.clientX;
  const startTasks = tasks.getBoundingClientRect().width;
  const startLog = log.getBoundingClientRect().width;
  const move = (e) => {
    const dx = e.clientX - startX;
    const tw = Math.max(180, startTasks + dx);
    const lw = Math.max(180, startLog - dx);
    tasks.style.flex = `0 0 ${tw}px`;
    log.style.flex = `0 0 ${lw}px`;
  };
  const up = () => {
    splitter.classList.remove('drag');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
};

$('btn-copy-tasks').onclick = async () => {
  const text = cachedTasks.length
    ? cachedTasks.map(formatTask).join('\n')
    : ($('tasks')?.innerText || '').trim();
  if (!text || text === t('noTasks')) {
    flashCopy($('btn-copy-tasks'), false);
    return;
  }
  await copyOrShow(text, $('btn-copy-tasks'));
};

$('btn-clear-tasks').onclick = async () => {
  if (!cachedTasks.length) return;
  try {
    await post('/api/clear', {});
    setHint(t('tasksCleared'));
  } catch (err) {
    setHint(err.message, true);
  }
  snapshot();
};

$('btn-copy-log').onclick = async () => {
  const text = ($('log').textContent || '').trim();
  await copyOrShow(text, $('btn-copy-log'));
};

$('btn-clear-log').onclick = async () => {
  if (!confirm(t('confirmClearLog'))) return;
  try { await post('/api/log/clear', {}); } catch (err) { alert(err.message); }
  snapshot();
};

$('btn-diagnostics').onclick = async () => {
  setBusy(true);
  try {
    const res = await fetch('/api/diagnostics');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const results = data.results || [];
    await post('/api/answers/local', {
      title: 'diagnostics',
      agent: 'system',
      answer: JSON.stringify({ hydraDiag: 1, results }),
    });
    lastAnswersKey = '';
    await snapshot();
  } catch (err) {
    setHint(`${t('diagnostics')}: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
};

$('btn-reload').onclick = async () => {
  try {
    await fetch('/api/daemon/ensure', { method: 'POST' });
  } catch { /* GUI may still recover via watchdog */ }
  const url = new URL(location.href);
  url.searchParams.set('v', String(Date.now()));
  location.replace(url.toString());
};

if ($('btn-lang')) {
  $('btn-lang').onclick = () => {
    if (window.HydraI18n) window.HydraI18n.cycleLang();
  };
}

window.onHydraLangChange = () => {
  lastAnswersKey = '';
  lastLogKey = '';
  snapshot();
};

if (window.HydraI18n) window.HydraI18n.applyStatic();
snapshot();
setInterval(snapshot, 2000);
