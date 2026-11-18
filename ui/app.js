const $ = id => document.getElementById(id);
const session = location.pathname.split('/')[1];
const pending = [];
const entries = [];
let processing = false;
let pasteNumber = 0;

async function request(endpoint, body, signal) {
  const res = await fetch(new URL('api/' + endpoint, location.href), {
    method: 'POST', headers: {'X-WeChat-Session': session}, body, signal,
  });
  if (!res.ok) throw new Error((await res.text()).trim() || '操作失败');
  return res;
}

function node(tag, className, value) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (value) el.textContent = value;
  return el;
}

function button(text, action, label) {
  const el = node('button', label ? 'icon-button' : 'button', text);
  el.type = 'button';
  if (label) {
    el.title = label;
    el.setAttribute('aria-label', label);
  }
  el.addEventListener('click', action);
  return el;
}

function error(id, message = '') {
  const el = $(id);
  el.textContent = message;
  el.hidden = !message;
}

const kb = bytes => (bytes / 1000).toLocaleString('zh-CN', {maximumFractionDigits: 2}) + ' KB';
const choice = value => value + ' KB';
const supported = file => /^image\/(jpeg|png|webp)$/i.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);
const suffix = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp'};

function nameFor(entry, blob, target) {
  const stem = entry.file.name.replace(/\.[^.]+$/, '') || '图片';
  return stem + '_' + target + 'KB' + suffix[blob.type];
}

function save(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = node('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function accept(files, fromPaste = false) {
  let message = '';
  for (const input of files) {
    if (!supported(input)) {
      message = '支持 JPG、PNG、WebP 图片';
      continue;
    }
    if (input.size > 50 * 1024 * 1024) {
      message = '单张图片上限为 50 MB';
      continue;
    }
    if (entries.length + pending.length >= 200) {
      message = '单批最多 200 张图片';
      break;
    }
    const file = fromPaste ? new File([input], '粘贴图片 ' + (++pasteNumber) + (suffix[input.type] || '.png'), {type: input.type}) : input;
    if (fromPaste) pending.push(file);
    else addEntry(file);
  }
  error('input-error', message);
  if (fromPaste) renderPending();
  else processQueue();
}

function renderPending() {
  $('queue').hidden = !pending.length;
  $('start').textContent = '开始压缩 (' + pending.length + ')';
  $('pending').replaceChildren(...pending.map((file, i) => {
    const item = node('li');
    const title = node('span', 'filename', file.name);
    title.title = file.name;
    item.append(title, button('×', () => {
      pending.splice(i, 1);
      renderPending();
    }, '移除 ' + file.name));
    return item;
  }));
}

function addEntry(file) {
  const entry = {file, url: URL.createObjectURL(file), cache: new Map(), target: 75, state: 'waiting'};
  const row = node('li', 'result-row');
  const img = node('img', 'thumb');
  img.alt = '';
  img.loading = 'lazy';
  img.src = entry.url;
  const info = node('div');
  const title = node('div', 'filename', file.name);
  title.title = file.name;
  entry.size = node('div', 'result-size', '等待中');
  info.append(title, entry.size);
  const actions = node('div', 'actions');
  entry.compareButton = button('对比', () => openPreview(entry));
  entry.saveButton = button('保存', () => save(entry.cache.get(entry.target), nameFor(entry, entry.cache.get(entry.target), entry.target)));
  entry.compareButton.disabled = true;
  entry.saveButton.disabled = true;
  actions.append(entry.compareButton, entry.saveButton, button('×', () => {
    entry.removed = true;
    entry.controller?.abort();
    URL.revokeObjectURL(entry.url);
    entries.splice(entries.indexOf(entry), 1);
    row.remove();
    renderResultsPanel();
    updateZip();
  }, '移除 ' + file.name));
  row.append(img, info, actions);
  $('results').append(row);
  entries.push(entry);
  renderResultsPanel();
}

function renderResultsPanel() {
  $('results-panel').hidden = !entries.length;
  $('workspace').classList.toggle('has-results', entries.length > 0);
}

function renderResult(entry) {
  const blob = entry.cache.get(entry.target);
  entry.compareButton.disabled = !blob;
  entry.saveButton.disabled = !blob;
  if (blob) {
    entry.size.classList.remove('error');
    entry.size.textContent = kb(entry.file.size) + ' → ' + kb(blob.size);
  }
  updateZip();
}

async function getVersion(entry, target, signal) {
  if (entry.cache.has(target)) return entry.cache.get(target);
  const res = await request('compress?kb=' + target, entry.file, signal);
  const blob = await res.blob();
  if (!suffix[blob.type] || blob.size > target * 1000) throw new Error('压缩结果无效');
  entry.cache.set(target, blob);
  return blob;
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    for (let entry; (entry = entries.find(item => item.state === 'waiting'));) {
      entry.state = 'working';
      entry.size.textContent = '正在压缩…';
      entry.controller = new AbortController();
      try {
        await getVersion(entry, entry.target, entry.controller.signal);
        entry.state = 'ready';
        if (!entry.removed) renderResult(entry);
      } catch (err) {
        entry.state = 'failed';
        if (!entry.removed) {
          entry.size.classList.add('error');
          entry.size.textContent = err.message;
        }
      }
    }
  } finally {
    processing = false;
  }
}

function updateZip() {
  $('zip').hidden = !entries.some(entry => entry.state === 'ready');
}

$('zip').addEventListener('click', async () => {
  const zipButton = $('zip');
  zipButton.disabled = true;
  error('zip-error');
  try {
    const form = new FormData();
    for (const entry of entries.filter(item => item.state === 'ready')) {
      const blob = entry.cache.get(entry.target);
      form.append('image', blob, nameFor(entry, blob, entry.target));
    }
    const res = await request('zip', form);
    save(await res.blob(), '微信图片轻压缩.zip');
  } catch (err) {
    error('zip-error', err.message);
  } finally {
    zipButton.disabled = false;
  }
});

$('dropzone').addEventListener('click', () => $('files').click());
$('files').addEventListener('change', event => {
  accept(event.target.files);
  event.target.value = '';
});
$('start').addEventListener('click', () => {
  pending.splice(0).forEach(addEntry);
  renderPending();
  processQueue();
});

document.addEventListener('dragover', event => {
  if (event.dataTransfer.types.includes('Files')) {
    event.preventDefault();
    $('dropzone').classList.toggle('dragging', !document.querySelector('dialog[open]'));
  }
});
document.addEventListener('dragleave', event => {
  if (!event.relatedTarget) $('dropzone').classList.remove('dragging');
});
document.addEventListener('drop', event => {
  event.preventDefault();
  $('dropzone').classList.remove('dragging');
  if (event.dataTransfer.files.length && !document.querySelector('dialog[open]')) accept(event.dataTransfer.files);
});

document.addEventListener('paste', event => {
  if (document.querySelector('dialog[open]')) return;
  event.preventDefault();
  const images = Array.from(event.clipboardData.files).filter(supported);
  if (images.length) accept(images, true);
  else error('input-error', '剪贴板中没有图片');
});

$('paste').addEventListener('click', async () => {
  try {
    const files = [];
    for (const item of await navigator.clipboard.read()) {
      const mime = item.types.find(type => type in suffix);
      if (mime) {
        const blob = await item.getType(mime);
        files.push(new File([blob], 'clipboard' + suffix[mime], {type: mime}));
      }
    }
    if (files.length) accept(files, true);
    else error('input-error', '剪贴板中没有图片');
  } catch {
    error('input-error', '无法读取剪贴板，请按 Ctrl+V 粘贴');
  }
});

const compare = $('compare');
const grid = $('compare-grid');
const frames = Array.from(grid.querySelectorAll('.frame'));
const sourceImage = $('original-img');
const compareURLs = new Map();
let preview = null;
let fit = false;
let timer;
let rangeController;
let highController;
let offsets = [0, 0];

function showBlob(img, blob) {
  const previous = compareURLs.get(img);
  if (previous?.blob === blob) return;
  if (previous) URL.revokeObjectURL(previous.url);
  if (blob) {
    const url = URL.createObjectURL(blob);
    compareURLs.set(img, {blob, url});
    img.src = url;
  } else {
    compareURLs.delete(img);
    img.removeAttribute('src');
  }
}

function openPreview(entry) {
  preview = entry;
  fit = false;
  offsets = [0, 0];
  $('compare-title').textContent = entry.file.name;
  $('compare-title').title = entry.file.name;
  $('target').value = entry.target;
  $('target-value').textContent = choice(entry.target);
  $('original-size').textContent = kb(entry.file.size);
  $('original-img').src = entry.url;
  $('save-current').disabled = false;
  $('high').disabled = false;
  $('zoom').textContent = '适应窗口';
  error('compare-error');
  compare.showModal();
  renderPreview();
  frames.forEach(frame => frame.scrollTo(0, 0));
}

function renderPreview() {
  if (!preview) return;
  const current = preview.cache.get(preview.target);
  const high = preview.cache.get(150);
  $('current-size').textContent = kb(current.size);
  $('high-column').hidden = !high;
  $('high-size').textContent = high ? kb(high.size) : '';
  $('high').textContent = high ? '保存 150 KB 版' : '生成 150 KB 版';
  showBlob($('current-img'), current);
  showBlob($('high-img'), high);
  measureFrames();
}

function measureFrames() {
  if (!preview || !sourceImage.naturalWidth) return;
  grid.classList.toggle('fit', fit);
  const visible = frames.filter(frame => !frame.closest('figure').hidden);
  const w = sourceImage.naturalWidth;
  const h = sourceImage.naturalHeight;
  const scale = fit ? Math.min(1, ...visible.map(frame => Math.min(frame.clientWidth / w, frame.clientHeight / h))) : 1;
  for (const frame of visible) {
    const img = frame.firstElementChild;
    img.style.width = Math.max(1, Math.round(w * scale)) + 'px';
    img.style.height = Math.max(1, Math.round(h * scale)) + 'px';
    if (!fit) frame.scrollTo(...offsets);
  }
}

sourceImage.addEventListener('load', measureFrames);
new ResizeObserver(measureFrames).observe(grid);
for (const frame of frames) {
  frame.addEventListener('scroll', () => {
    if (fit || !preview || frame.closest('figure').hidden) return;
    const point = [frame.scrollLeft, frame.scrollTop];
    if (point[0] === offsets[0] && point[1] === offsets[1]) return;
    // Ignore scroll events from a pane clamped to a slightly different viewport width.
    const bounded = [Math.min(offsets[0], frame.scrollWidth - frame.clientWidth), Math.min(offsets[1], frame.scrollHeight - frame.clientHeight)];
    if (point[0] === bounded[0] && point[1] === bounded[1]) return;
    offsets = point;
    frames.filter(other => other !== frame && !other.closest('figure').hidden).forEach(other => other.scrollTo(...offsets));
  });
}

$('zoom').addEventListener('click', () => {
  fit = !fit;
  $('zoom').textContent = fit ? '原尺寸' : '适应窗口';
  measureFrames();
});

$('target').addEventListener('input', () => {
  const entry = preview;
  const target = Number($('target').value);
  $('target-value').textContent = choice(target);
  $('save-current').disabled = true;
  error('compare-error');
  clearTimeout(timer);
  rangeController?.abort();
  const controller = new AbortController();
  rangeController = controller;
  timer = setTimeout(async () => {
    try {
      await getVersion(entry, target, controller.signal);
      if (controller.signal.aborted || preview !== entry) return;
      entry.target = target;
      renderResult(entry);
      renderPreview();
    } catch (err) {
      if (!controller.signal.aborted && preview === entry) {
        error('compare-error', err.message);
        $('target').value = entry.target;
        $('target-value').textContent = choice(entry.target);
      }
    } finally {
      if (!controller.signal.aborted && preview === entry) $('save-current').disabled = false;
    }
  }, 170);
});

$('save-current').addEventListener('click', () => {
  const blob = preview.cache.get(preview.target);
  save(blob, nameFor(preview, blob, preview.target));
});

$('high').addEventListener('click', async () => {
  const entry = preview;
  if (entry.cache.has(150)) {
    const blob = entry.cache.get(150);
    save(blob, nameFor(entry, blob, 150));
    return;
  }
  const controller = new AbortController();
  highController = controller;
  $('high').disabled = true;
  $('high').textContent = '正在生成…';
  error('compare-error');
  try {
    await getVersion(entry, 150, controller.signal);
  } catch (err) {
    if (!controller.signal.aborted && preview === entry) error('compare-error', err.message);
  } finally {
    if (!controller.signal.aborted && preview === entry) {
      $('high').disabled = false;
      renderPreview();
    }
  }
});

compare.addEventListener('close', () => {
  if (compare.open) return;
  clearTimeout(timer);
  rangeController?.abort();
  highController?.abort();
  preview = null;
  sourceImage.removeAttribute('src');
  showBlob($('current-img'), null);
  showBlob($('high-img'), null);
});

const updateDialog = $('update-dialog');
const appMenu = $('app-menu');
let check;
let available;
let installing = false;

function updateMessage(message, {install = false, retry = false} = {}) {
  $('update-status').textContent = message;
  $('install').hidden = !install;
  $('update-retry').hidden = !retry;
}

async function checkUpdate(show) {
  if (show) updateMessage('正在检查…');
  if (!check) {
    check = request('update').then(res => res.json()).finally(() => { check = null; });
  }
  try {
    const result = await check;
    available = result.available;
    appMenu.classList.toggle('has-update', Boolean(available));
    if (available) {
      $('updates').textContent = '更新 ' + available;
      if (show) {
        const warning = entries.length || pending.length ? '。重启会清空本次队列和结果。' : '';
        updateMessage('可更新至 ' + available + warning, {install: true});
      }
    } else if (show) {
      updateMessage(result.published ? '当前版本 ' + result.installed + ' 已是最新。' : '还没有可用的 GitHub 更新包。');
    }
  } catch (err) {
    if (show) updateMessage(err.message, {retry: true});
  }
}

$('updates').addEventListener('click', () => {
  appMenu.open = false;
  updateDialog.showModal();
  checkUpdate(true);
});
document.addEventListener('pointerdown', event => {
  if (!appMenu.contains(event.target)) appMenu.open = false;
});
appMenu.addEventListener('keydown', event => {
  if (event.key === 'Escape' && appMenu.open) {
    appMenu.open = false;
    appMenu.querySelector('summary').focus();
  }
});
$('update-retry').addEventListener('click', () => checkUpdate(true));
$('install').addEventListener('click', async () => {
  if (installing || !available) return;
  installing = true;
  updateDialog.querySelector('[data-close]').disabled = true;
  updateMessage('正在下载并验证…');
  try {
    await request('install?version=' + encodeURIComponent(available));
    updateMessage('正在重启…');
  } catch (err) {
    installing = false;
    updateDialog.querySelector('[data-close]').disabled = false;
    updateMessage(err.message, {install: true});
  }
});
updateDialog.addEventListener('cancel', event => {
  if (installing) event.preventDefault();
});

document.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', () => el.closest('dialog').close());
});

async function quit() {
  try {
    await request('quit');
    document.body.replaceChildren();
    window.close();
  } catch (err) {
    error('input-error', err.message);
  }
}

$('quit').addEventListener('click', () => {
  appMenu.open = false;
  if (entries.length || pending.length) $('exit-dialog').showModal();
  else quit();
});
$('confirm-quit').addEventListener('click', quit);
$('quit').hidden = !new URLSearchParams(location.search).has('tab');
checkUpdate(false);
