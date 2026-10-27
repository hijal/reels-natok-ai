'use strict';
const $ = id => document.getElementById(id);
let references = [], plans = [], busy = false, uploading = false, requestPending = false;
let lastPlanned = '', videoSignature = '', authenticated = false;
function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').className = 'notice' + (error ? ' error' : '') + (text ? '' : ' hidden');
}
function signedIn(value) {
  authenticated = value;
  $('login').classList.toggle('hidden', value);
  $('studio').classList.toggle('hidden', !value);
  $('logout').classList.toggle('hidden', !value);
}
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {cache: 'no-store'} : {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-Reels-Request': '1'}, body: JSON.stringify(body)
  });
  const data = await response.json();
  if (response.status === 401) signedIn(false);
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function settings() {
  return {mode: $('mode').value, target: Number($('target').value), scene_seconds: Number($('scene-seconds').value),
    context: $('context').value, preset: $('preset').value, fit: $('fit').value, seed: Number($('seed').value)};
}
function updateButtons() {
  document.querySelectorAll('[data-job]').forEach(el => el.disabled = busy || uploading || requestPending);
  $('cancel').disabled = !busy || requestPending;
  $('images').disabled = uploading || busy;
  $('clear-refs').disabled = uploading || busy;
}
function showRefs() {
  $('refs').textContent = references.length ? references.map((r, i) => `<Picture ${i + 1}> = ${r}`).join(' · ') : 'No references uploaded.';
}
function renderPlans() {
  const container = $('plans'); container.replaceChildren();
  plans.forEach((plan, index) => {
    const episode = document.createElement('div'); episode.className = 'episode';
    const title = document.createElement('input'); title.value = plan.title;
    title.setAttribute('aria-label', `Episode ${index + 1} title`);
    title.addEventListener('input', () => plan.title = title.value); episode.append(title);
    const contextLabel = document.createElement('label'); contextLabel.textContent = 'Episode continuity context';
    const context = document.createElement('textarea'); context.value = plan.context || '';
    context.addEventListener('input', () => plan.context = context.value); episode.append(contextLabel, context);
    (plan.warnings || []).forEach(text => {const p = document.createElement('p'); p.textContent = text; episode.append(p);});
    plan.scenes.forEach((scene, i) => {
      const div = document.createElement('div'); div.className = 'scene';
      const label = document.createElement('label'); label.textContent = `Scene ${i + 1} · duration (seconds)`;
      const duration = document.createElement('input'); duration.type = 'number'; duration.min = '5'; duration.max = '15'; duration.step = 'any'; duration.value = scene.duration;
      duration.addEventListener('input', () => scene.duration = Number(duration.value));
      const prompt = document.createElement('textarea'); prompt.value = scene.prompt;
      prompt.setAttribute('aria-label', `Scene ${i + 1} prompt`);
      prompt.addEventListener('input', () => scene.prompt = prompt.value);
      div.append(label, duration, prompt); episode.append(div);
    });
    container.append(episode);
  });
}
async function restore() {
  const saved = await api('/api/plan');
  plans = saved.plans || []; references = saved.references || [];
  for (const [key, id] of Object.entries({mode: 'mode', target: 'target', scene_seconds: 'scene-seconds', context: 'context', preset: 'preset', fit: 'fit', seed: 'seed'})) {
    if (saved.settings && saved.settings[key] !== undefined) $(id).value = saved.settings[key];
  }
  renderPlans(); showRefs();
  if (!plans.length) notice('No saved plan yet. Build a scene plan first.');
}
function renderVideos(videos) {
  const signature = JSON.stringify(videos);
  if (signature === videoSignature) return;
  videoSignature = signature; $('videos').replaceChildren();
  for (const file of videos) {
    const article = document.createElement('article'), video = document.createElement('video');
    const src = '/api/media?path=' + encodeURIComponent(file.path);
    video.src = src; video.controls = true; video.preload = 'none'; video.playsInline = true;
    const caption = document.createElement('p'); caption.textContent = file.episode + ' / ' + file.name;
    const download = document.createElement('a'); download.href = src + '&download=1'; download.className = 'link'; download.textContent = 'Download MP4';
    article.append(video, caption, download); $('videos').append(article);
  }
}
async function poll() {
  try {
    const state = await api('/api/state'); signedIn(true);
    busy = state.busy || state.releasing; updateButtons();
    $('connection').textContent = state.releasing ? 'Saving & releasing GPU…' : 'Connected to Colab';
    const latest = state.jobs[0];
    $('job-status').textContent = latest ? `${latest.action} · ${latest.status}${latest.error ? ' · ' + latest.error : ''}` : 'Ready';
    const pre = $('job-log'), atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 35;
    pre.textContent = latest ? latest.log || 'Worker starting…' : 'No jobs yet.';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
    $('job-history').replaceChildren();
    for (const job of state.jobs.slice(0, 12)) {
      const p = document.createElement('p'); p.textContent = `${new Date(job.created * 1000).toLocaleString()} · ${job.action} · ${job.status}`; $('job-history').append(p);
    }
    renderVideos(state.videos);
    if (latest && latest.action === 'plan' && latest.status === 'done' && latest.id !== lastPlanned) {
      lastPlanned = latest.id; await restore(); notice('Scene plan ready. Review it, render a test, then generate the batch.');
    }
  } catch (error) {
    $('connection').textContent = 'Disconnected';
    if (authenticated) notice('Connection lost. Jobs keep running while the runtime is alive. Reopen the latest tunnel URL to reconnect.', true);
  }
}
async function action(fn) {
  requestPending = true; updateButtons(); notice('');
  try {await fn();} catch (error) {notice(error.message, true);}
  finally {requestPending = false; updateButtons();}
}
$('login-form').addEventListener('submit', event => {event.preventDefault(); void action(async () => {
  await api('/api/login', {password: $('password').value}); $('password').value = ''; signedIn(true); await poll();
});});
$('logout').addEventListener('click', () => void action(async () => {await api('/api/logout', {}); signedIn(false);}));
$('clear-refs').addEventListener('click', () => {references = []; $('images').value = ''; showRefs();});
$('images').addEventListener('change', () => void action(async () => {
  const files = [...$('images').files];
  if (files.length + references.length > 9) throw new Error('Use at most nine reference images.');
  uploading = true; updateButtons();
  try {
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) throw new Error('Each reference must be under 20 MiB.');
      const encoded = await new Promise((resolve, reject) => {const r = new FileReader(); r.onload = () => resolve(r.result.split(',')[1]); r.onerror = () => reject(new Error('Image could not be read')); r.readAsDataURL(file);});
      const result = await api('/api/upload', {name: file.name, data: encoded}); references.push(result.reference); showRefs();
    }
  } finally {uploading = false; $('images').value = ''; updateButtons();}
}));
$('plan').addEventListener('click', () => void action(async () => {
  const sources = [];
  if ($('story').value.trim()) sources.push({title: $('title').value, text: $('story').value});
  for (const file of $('scripts').files) {
    if (file.size > 2 * 1024 * 1024) throw new Error('Each script must be under 2 MiB.');
    sources.push({title: file.name.replace(/\.txt$/i, ''), text: (await file.text()).replace(/^\uFEFF/, '')});
  }
  if (!sources.length) throw new Error('Enter a story or upload a script.');
  await api('/api/plan', {sources, references, settings: settings()}); busy = true; await poll();
}));
$('restore').addEventListener('click', () => void action(restore));
for (const name of ['test', 'generate']) $(name).addEventListener('click', () => void action(async () => {
  if (!plans.length) throw new Error('Build or restore a scene plan first.');
  await api('/api/' + name, {plans, references, settings: settings()}); busy = true; await poll();
}));
$('cancel').addEventListener('click', () => void action(async () => {await api('/api/cancel', {}); await poll();}));
$('release').addEventListener('click', () => void action(async () => {
  if (!window.confirm('Verify saved episodes, sync Drive and release the Colab GPU? This closes the tunnel.')) return;
  await api('/api/release', {}); busy = true; notice('Exports verified. Colab will sync Drive and release the runtime.');
}));
void poll(); setInterval(() => {if (authenticated) void poll();}, 2500);
