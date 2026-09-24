// All image data stays in this tab. There are no network requests or external libraries.
(() => {
  'use strict';

  const DEFAULT_MAX = 75_000;
  const SLIDER_MIN = 65;
  const SLIDER_MAX = 85;
  const RELAXED_MAX = 150_000;
  const RELAXED_MIN = 100_000;
  const WIDTHS = [1600, 1536, 1440, 1360, 1280, 1200, 1120, 1080, 1024, 960];
  const MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const $ = (id) => document.getElementById(id);
  const dropzone = $('dropzone');
  const input = $('fileInput');
  const pasteTarget = $('pasteTarget');
  const pasteStatus = $('pasteStatus');
  const pasteStart = $('pasteStart');
  const pasteQueuePanel = $('pasteQueuePanel');
  const pasteQueueList = $('pasteQueueList');
  const list = $('resultList');
  const entries = [];
  const queue = [];
  const pasteQueue = [];
  let working = false;
  const previewUrls = { standard: null, relaxed: null };
  let previewEntry = null;
  let previewTimer = null;
  let previewWorking = false;
  let latestPasteBatch = 0;
  let pasteItemNumber = 0;

  const formatSize = (bytes) => bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(2)} MB`
    : `${(bytes / 1_000).toFixed(1)} KB`;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  pasteTarget.addEventListener('focus', showPasteReady);
  pasteTarget.addEventListener('click', showPasteReady);
  pasteStart.addEventListener('click', startPasteQueue);
  pasteTarget.addEventListener('input', () => {
    pasteTarget.value = '';
    setPasteStatus('这里只接收图片，请复制图片后按 Ctrl + V', 'error');
  });
  document.addEventListener('paste', (event) => {
    const fromItems = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter(Boolean);
    const files = (fromItems.length ? fromItems : [...(event.clipboardData?.files || [])])
      .filter((file) => MIME.has(file.type));
    if (files.length) {
      event.preventDefault();
      pasteTarget.value = '';
      enqueuePasteFiles(files);
    } else if (document.activeElement === pasteTarget) {
      event.preventDefault();
      pasteTarget.value = '';
      setPasteStatus('剪贴板中没有 JPG、PNG 或 WebP 图片', 'error');
    }
  });
  for (const name of ['dragenter', 'dragover']) {
    document.addEventListener(name, (event) => {
      event.preventDefault();
      if ([...(event.dataTransfer?.types || [])].includes('Files')) dropzone.classList.add('dragging');
    });
  }
  for (const name of ['dragleave', 'drop']) {
    document.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.remove('dragging'); });
  }
  document.addEventListener('drop', (event) => addFiles(event.dataTransfer?.files || []));

  function setPasteStatus(message, state = '') {
    pasteStatus.textContent = message;
    pasteStatus.className = `paste-status ${state}`;
  }

  function showPasteReady() {
    const suffix = pasteQueue.length ? `队列已有 ${pasteQueue.length} 张，可继续粘贴` : '可连续粘贴多张图片';
    setPasteStatus(`输入框已选中，按 Ctrl + V；${suffix}`, 'ready');
  }

  function enqueuePasteFiles(files) {
    latestPasteBatch++;
    for (const file of files) {
      const number = ++pasteItemNumber;
      const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
      const rawStem = (file.name || '').replace(/\.(jpe?g|png|webp)$/i, '');
      const stem = !rawStem || /^(image|blob)$/i.test(rawStem) ? '粘贴图片' : rawStem;
      const name = `${stem}_${String(number).padStart(2, '0')}.${ext}`;
      const namedFile = new File([file], name, { type: file.type, lastModified: file.lastModified });
      pasteQueue.push({ id: number, file: namedFile, url: URL.createObjectURL(namedFile) });
    }
    renderPasteQueue();
    setPasteStatus(`已加入 ${files.length} 张图片；队列共 ${pasteQueue.length} 张，点击“开始压缩”后统一处理`, 'success');
  }

  function renderPasteQueue() {
    pasteQueueList.replaceChildren();
    pasteQueuePanel.classList.toggle('hidden', pasteQueue.length === 0);
    $('pasteCount').textContent = `${pasteQueue.length} 张`;
    pasteStart.disabled = pasteQueue.length === 0;
    pasteStart.textContent = `开始压缩 (${pasteQueue.length})`;
    for (const item of pasteQueue) {
      const row = document.createElement('div');
      row.className = 'paste-queue-item';
      const image = document.createElement('img');
      image.src = item.url;
      image.alt = '';
      const info = document.createElement('span');
      info.className = 'paste-queue-name';
      info.textContent = `${item.file.name} · ${formatSize(item.file.size)}`;
      const remove = document.createElement('button');
      remove.className = 'paste-queue-remove';
      remove.type = 'button';
      remove.textContent = '移除';
      remove.setAttribute('aria-label', `从队列移除 ${item.file.name}`);
      remove.addEventListener('click', () => {
        const index = pasteQueue.findIndex((candidate) => candidate.id === item.id);
        if (index < 0) return;
        pasteQueue.splice(index, 1);
        URL.revokeObjectURL(item.url);
        renderPasteQueue();
        setPasteStatus(pasteQueue.length ? `已移除图片，队列还剩 ${pasteQueue.length} 张` : '队列已清空，可继续粘贴图片', 'ready');
      });
      row.append(image, info, remove);
      pasteQueueList.append(row);
    }
  }

  function startPasteQueue() {
    if (!pasteQueue.length) return;
    const files = pasteQueue.map((item) => item.file);
    for (const item of pasteQueue) URL.revokeObjectURL(item.url);
    pasteQueue.length = 0;
    renderPasteQueue();
    const batch = ++latestPasteBatch;
    setPasteStatus(`已提交 ${files.length} 张图片，正在压缩…`, 'working');
    addFiles(files, 'paste', batch);
  }

  function addFiles(files, origin = 'file', pasteBatch = 0) {
    const accepted = [...files].filter((file) => MIME.has(file.type));
    if (!accepted.length) return;
    $('results').classList.remove('hidden');
    document.querySelector('.shell').classList.add('has-results');
    for (const file of accepted) {
      const entry = { file, blob: null, name: null, relaxedBlob: null, origin, pasteBatch,
        targetKb: DEFAULT_MAX / 1000, variants: new Map(), relaxedQueued: false,
        failed: false, sourceUrl: URL.createObjectURL(file) };
      entries.push(entry);
      queue.push({ entry, mode: 'default' });
      renderEntry(entry);
    }
    processQueue();
  }

  function renderEntry(entry) {
    const card = document.createElement('article');
    card.className = 'result-card';
    const image = document.createElement('img');
    image.className = 'thumb';
    image.src = entry.sourceUrl;
    image.alt = '';
    const info = document.createElement('div');
    info.className = 'file-info';
    const filename = document.createElement('p');
    filename.className = 'file-name';
    filename.textContent = entry.file.name || '粘贴的图片';
    const meta = document.createElement('p');
    meta.className = 'file-meta';
    meta.textContent = formatSize(entry.file.size);
    const status = document.createElement('p');
    status.className = 'status';
    status.innerHTML = '<span class="spinner"></span>等待处理';
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const button = document.createElement('button');
    button.className = 'button button-dark';
    button.type = 'button';
    button.textContent = '下载 ≤75KB 版';
    button.disabled = true;
    button.addEventListener('click', () => download(entry.blob, entry.name));
    const previewButton = document.createElement('button');
    previewButton.className = 'button button-outline hidden';
    previewButton.type = 'button';
    previewButton.textContent = '放大对比';
    previewButton.addEventListener('click', () => showPreview(entry));
    actions.append(button, previewButton);
    const qualityBox = document.createElement('div');
    qualityBox.className = 'quality-box hidden';
    const qualityNote = document.createElement('p');
    qualityNote.className = 'quality-note';
    const relaxedButton = document.createElement('button');
    relaxedButton.className = 'button button-soft';
    relaxedButton.type = 'button';
    relaxedButton.textContent = '生成清晰版 · ≤150KB';
    relaxedButton.addEventListener('click', () => queueRelaxed(entry));
    qualityBox.append(qualityNote, relaxedButton);
    const relaxedPanel = document.createElement('div');
    relaxedPanel.className = 'relaxed-panel hidden';
    const relaxedMeta = document.createElement('span');
    const relaxedDownload = document.createElement('button');
    relaxedDownload.className = 'button button-outline';
    relaxedDownload.type = 'button';
    relaxedDownload.textContent = '下载清晰版';
    relaxedDownload.addEventListener('click', () => download(entry.relaxedBlob, entry.relaxedName));
    relaxedPanel.append(relaxedMeta, relaxedDownload);
    info.append(filename, meta, status, actions, qualityBox, relaxedPanel);
    card.append(image, info);
    list.prepend(card);
    entry.ui = { meta, status, button, previewButton, qualityBox, qualityNote, relaxedButton, relaxedPanel, relaxedMeta };
  }

  function setStatus(entry, text, kind = '') {
    entry.ui.status.className = `status ${kind}`;
    entry.ui.status.textContent = text;
    if (!kind) entry.ui.status.insertAdjacentHTML('afterbegin', '<span class="spinner"></span>');
  }

  async function processQueue() {
    if (working) return;
    working = true;
    while (queue.length) {
      const { entry, mode } = queue.shift();
      try {
        if (mode === 'relaxed') {
          await processRelaxed(entry);
          continue;
        }
        setStatus(entry, '正在分析并压缩');
        await pause();
        const result = await compress(entry.file, DEFAULT_MAX);
        entry.variants.set(entry.targetKb, result);
        applyStandardResult(entry, result, entry.targetKb);
      } catch (error) {
        console.error('图片处理失败：', error);
        if (mode === 'relaxed') {
          entry.ui.qualityNote.textContent = '更清晰版本生成失败，可重试。';
          entry.ui.relaxedButton.disabled = false;
          entry.ui.relaxedButton.textContent = '重试生成清晰版';
          entry.relaxedQueued = false;
          if (previewEntry === entry && previewDialog.open) {
            $('previewHigh').disabled = false;
            $('previewHigh').textContent = '重试生成 ≤150KB 版';
            $('previewStatus').textContent = '150KB 版本生成失败，请重试';
          }
        } else {
          entry.failed = true;
          setStatus(entry, `处理失败：${error.message || '请更换图片重试'}`, 'error');
        }
      }
      if (mode === 'default') updatePasteProgress(entry);
      updateAllButton();
    }
    working = false;
  }

  function queueRelaxed(entry) {
    if (entry.relaxedBlob || entry.relaxedQueued) return;
    entry.relaxedQueued = true;
    entry.ui.relaxedButton.disabled = true;
    entry.ui.relaxedButton.textContent = '等待处理…';
    if (previewEntry === entry && previewDialog.open) {
      $('previewHigh').disabled = true;
      $('previewHigh').textContent = '正在生成 ≤150KB 版…';
      $('previewStatus').textContent = '正在生成 150KB 版本，当前版本仍可对比';
    }
    queue.push({ entry, mode: 'relaxed' });
    processQueue();
  }

  function applyStandardResult(entry, result, targetKb) {
    entry.result = result;
    entry.blob = result.blob;
    entry.targetKb = targetKb;
    entry.name = outputName(entry.file.name, result.blob.type);
    entry.ui.meta.innerHTML = '';
    const original = document.createElement('span');
    original.textContent = `${result.originalWidth} × ${result.originalHeight} · ${formatSize(entry.file.size)}`;
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';
    const final = document.createElement('span');
    final.className = 'final';
    final.textContent = `${result.width} × ${result.height} · ${formatSize(result.blob.size)}`;
    entry.ui.meta.append(original, arrow, final);
    entry.ui.button.disabled = false;
    entry.ui.button.textContent = result.kept ? '下载原图' : `下载 ≤${targetKb}KB 版`;
    entry.ui.previewButton.classList.remove('hidden');
    setStatus(entry, result.kept ? '原图已符合大小要求，保留原图' : '压缩完成', 'success');
    entry.ui.qualityNote.textContent = `图片细节可能受 ${targetKb}KB 限制影响`;
    entry.ui.qualityBox.classList.toggle('hidden', !result.qualityConcern || !!entry.relaxedBlob);
    if (previewEntry === entry && previewDialog.open) renderPreviewStandard(entry);
  }

  function updatePasteProgress(entry) {
    if (entry.origin !== 'paste' || entry.pasteBatch !== latestPasteBatch) return;
    const batch = entries.filter((item) => item.pasteBatch === latestPasteBatch);
    if (!batch.every((item) => item.blob || item.failed)) return;
    const succeeded = batch.filter((item) => item.blob).length;
    if (succeeded === batch.length) {
      setPasteStatus(`${succeeded} 张图片已粘贴并处理完成，结果已显示在结果区`, 'success');
    } else {
      setPasteStatus(`${succeeded} 张处理完成，${batch.length - succeeded} 张处理失败，请查看结果区`, 'error');
    }
  }

  async function processRelaxed(entry) {
    entry.ui.relaxedButton.textContent = '正在生成清晰版…';
    const result = await compress(entry.file, RELAXED_MAX);
    if (result.blob.size > RELAXED_MAX) throw new Error('更清晰版本超过 150KB');
    entry.relaxedBlob = result.blob;
    entry.relaxedResult = result;
    entry.relaxedName = outputName(entry.file.name, result.blob.type, 'clear');
    entry.ui.relaxedMeta.textContent = `更清晰版 · ${result.width} × ${result.height} · ${formatSize(result.blob.size)}`;
    entry.ui.relaxedPanel.classList.remove('hidden');
    entry.ui.qualityBox.classList.add('hidden');
    entry.relaxedQueued = false;
    if (previewEntry === entry && previewDialog.open) renderPreviewRelaxed(entry);
  }

  function isClearer(relaxed, standard) {
    if (relaxed.kept) return true;
    return relaxed.qualityScore >= standard.qualityScore + .005 &&
      relaxed.metrics.ssim >= standard.metrics.ssim - .005 &&
      relaxed.metrics.edgeRetention >= standard.metrics.edgeRetention - .02;
  }

  function outputName(filename, type, suffix = 'compressed') {
    const stem = (filename || '粘贴的图片').replace(/\.(jpe?g|png|webp)$/i, '').replace(/[\\/:*?"<>|]/g, '_');
    const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
    return `${stem}_${suffix}.${ext}`;
  }

  const previewDialog = $('previewDialog');
  const previewTarget = $('previewTarget');
  $('previewClose').addEventListener('click', () => previewDialog.close());
  $('previewZoom').addEventListener('click', () => {
    const zoomed = previewDialog.classList.toggle('zoomed');
    $('previewZoom').textContent = zoomed ? '适应窗口' : '按原尺寸查看';
  });
  previewTarget.addEventListener('input', () => {
    if (!previewEntry) return;
    const targetKb = Number(previewTarget.value);
    if (!Number.isInteger(targetKb) || targetKb < SLIDER_MIN || targetKb > SLIDER_MAX) return;
    $('previewTargetValue').textContent = `${targetKb}KB`;
    if (targetKb === previewEntry.targetKb) {
      clearTimeout(previewTimer);
      $('previewDownload').disabled = false;
      $('previewStatus').textContent = '当前版本已生成，可直接对比和下载';
      return;
    }
    $('previewDownload').disabled = true;
    $('previewStatus').textContent = `准备生成 ≤${targetKb}KB 版本…`;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(processPreviewTarget, 180);
  });
  $('previewDownload').addEventListener('click', () => {
    if (previewEntry) download(previewEntry.blob, previewEntry.name);
  });
  $('previewHigh').addEventListener('click', () => {
    if (previewEntry) queueRelaxed(previewEntry);
  });
  $('previewHighDownload').addEventListener('click', () => {
    if (previewEntry) download(previewEntry.relaxedBlob, previewEntry.relaxedName);
  });
  previewDialog.addEventListener('close', () => {
    previewEntry = null;
    clearTimeout(previewTimer);
    $('previewStandard').removeAttribute('src');
    $('previewRelaxed').removeAttribute('src');
    for (const key of ['standard', 'relaxed']) {
      if (previewUrls[key]) URL.revokeObjectURL(previewUrls[key]);
      previewUrls[key] = null;
    }
  });

  function showPreview(entry) {
    if (!entry.blob) return;
    previewEntry = entry;
    clearTimeout(previewTimer);
    previewDialog.classList.add('zoomed');
    $('previewZoom').textContent = '适应窗口';
    $('previewTitle').textContent = entry.file.name || '粘贴的图片';
    $('previewOriginal').src = entry.sourceUrl;
    previewTarget.value = String(entry.targetKb);
    renderPreviewStandard(entry);
    renderPreviewRelaxed(entry);
    previewDialog.showModal();
  }

  function setPreviewImage(key, blob) {
    const image = $(key === 'standard' ? 'previewStandard' : 'previewRelaxed');
    if (previewUrls[key]) URL.revokeObjectURL(previewUrls[key]);
    previewUrls[key] = URL.createObjectURL(blob);
    image.src = previewUrls[key];
  }

  function renderPreviewStandard(entry) {
    $('previewTargetValue').textContent = `${entry.targetKb}KB`;
    $('previewActual').textContent = `实际大小：${formatSize(entry.blob.size)}`;
    $('previewStandardTitle').textContent = `当前版本 · ≤${entry.targetKb}KB · ${formatSize(entry.blob.size)}`;
    $('previewDownload').disabled = false;
    $('previewStatus').textContent = entry.result.kept ? '原图已小于所选上限，直接保留原图' : '已更新当前版本，可直接对比和下载';
    setPreviewImage('standard', entry.blob);
  }

  function renderPreviewRelaxed(entry) {
    $('previewRelaxedColumn').classList.toggle('hidden', !entry.relaxedBlob);
    $('previewHighDownload').classList.toggle('hidden', !entry.relaxedBlob);
    $('previewHigh').disabled = !!entry.relaxedBlob || entry.relaxedQueued;
    $('previewHigh').textContent = entry.relaxedBlob ? '已生成 ≤150KB 版'
      : entry.relaxedQueued ? '正在生成 ≤150KB 版…' : '生成 ≤150KB 版';
    if (!entry.relaxedBlob) return;
    $('previewRelaxedTitle').textContent = `更清晰版 · ≤150KB · ${formatSize(entry.relaxedBlob.size)}`;
    setPreviewImage('relaxed', entry.relaxedBlob);
    $('previewStatus').textContent = isClearer(entry.relaxedResult, entry.result)
      ? '150KB 版本已生成，可在右侧对比和下载'
      : '150KB 版本已生成；指标提升不明显，请放大检查细节';
  }

  async function processPreviewTarget() {
    if (!previewEntry || !previewDialog.open || previewWorking) return;
    const entry = previewEntry;
    const targetKb = Number(previewTarget.value);
    if (targetKb === entry.targetKb) return;
    const cached = entry.variants.get(targetKb);
    if (cached) {
      applyStandardResult(entry, cached, targetKb);
      return;
    }
    previewWorking = true;
    $('previewStatus').textContent = `正在生成 ≤${targetKb}KB 版本…`;
    try {
      const result = await compress(entry.file, targetKb * 1000);
      if (result.blob.size > targetKb * 1000) throw new Error('输出超过所选上限');
      entry.variants.set(targetKb, result);
      if (previewEntry === entry && previewDialog.open && Number(previewTarget.value) === targetKb) {
        applyStandardResult(entry, result, targetKb);
      }
    } catch (error) {
      console.error('调整压缩大小失败：', error);
      if (previewEntry === entry && previewDialog.open && Number(previewTarget.value) === targetKb) {
        previewTarget.value = String(entry.targetKb);
        $('previewTargetValue').textContent = `${entry.targetKb}KB`;
        $('previewDownload').disabled = false;
        $('previewStatus').textContent = `无法生成 ${targetKb}KB 版本：${error.message || '请重试'}`;
      }
    } finally {
      previewWorking = false;
      if (previewEntry && previewDialog.open && Number(previewTarget.value) !== previewEntry.targetKb) {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(processPreviewTarget, 0);
      }
    }
  }

  async function compress(file, limit = DEFAULT_MAX) {
    const relaxed = limit > SLIDER_MAX * 1000;
    const targetMin = relaxed ? RELAXED_MIN : Math.max(0, limit - 5_000);
    const targetMax = relaxed ? limit - 1_000 : limit;
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      const originalWidth = bitmap.width;
      const originalHeight = bitmap.height;
      if (!originalWidth || !originalHeight) throw new Error('无法读取图片尺寸');
      if (file.size <= limit) {
        return { blob: file, width: originalWidth, height: originalHeight, originalWidth, originalHeight, kept: true,
          qualityConcern: false, qualityScore: 1, metrics: { ssim: 1, edgeRetention: 1 }, quality: 100 };
      }

      const analysis = analyze(bitmap);
      const category = classify(analysis);
      const baseWidth = relaxed ? (category === 'TEXT_HEAVY' ? 1600 : 1440)
        : (category === 'TEXT_HEAVY' ? 1440 : 1280);
      const minQuality = category === 'TEXT_HEAVY' ? 72 : category === 'GRAPHIC' ? 70 : 63;
      const maxCanvasWidth = Math.max(1, Math.floor(16000 * originalWidth / originalHeight));
      const allowed = Math.min(originalWidth, baseWidth, maxCanvasWidth);
      const widths = chooseWidths(allowed);
      const reference = sampleBitmap(bitmap, 320);
      const details = makeDetailSamples(bitmap, analysis.detailPoints, category);
      const candidates = [];

      for (const width of widths) {
        const canvas = drawBitmap(bitmap, width);
        try {
          const found = await bestJpegWithin(canvas, 50, 95, limit);
          if (found) {
            const metrics = await measure(reference, details, originalWidth, originalHeight, found.blob, category);
            const resolution = Math.min(1, width / Math.min(baseWidth, originalWidth));
            const qualityPenalty = found.quality < minQuality ? (minQuality - found.quality) / 100 * 0.08 : 0;
            const weights = category === 'TEXT_HEAVY' ? [.38, .40, .22]
              : category === 'GRAPHIC' ? [.51, .27, .22] : [.68, .12, .20];
            const targetBonus = found.blob.size >= targetMin && found.blob.size <= targetMax ? 0.002 : 0;
            const score = weights[0] * metrics.ssim + weights[1] * metrics.edgeRetention
              + weights[2] * resolution - qualityPenalty + targetBonus;
            const commonResolution = Math.min(1, width / Math.min(1600, originalWidth));
            const qualityScore = weights[0] * metrics.ssim + weights[1] * metrics.edgeRetention
              + weights[2] * commonResolution;
            candidates.push({ ...found, width, height: canvas.height, score, qualityScore, metrics });
            // Extra widths rarely improve a candidate already visually very close to the source.
            if (candidates.length >= 3 && score > .982 && found.blob.size >= targetMin) break;
          }
        } finally {
          canvas.width = 0;
          canvas.height = 0;
        }
        await pause();
      }

      if (!candidates.length) {
        // Extremely dense or unusually tall images may need to go below 960 px.
        let width = Math.min(allowed, 900);
        while (width >= 32) {
          const canvas = drawBitmap(bitmap, width);
          try {
            const found = await bestJpegWithin(canvas, 1, 95, limit);
            if (found) {
              const metrics = await measure(reference, details, originalWidth, originalHeight, found.blob, category);
              const weights = category === 'TEXT_HEAVY' ? [.38, .40, .22]
                : category === 'GRAPHIC' ? [.51, .27, .22] : [.68, .12, .20];
              const commonResolution = Math.min(1, width / Math.min(1600, originalWidth));
              const qualityScore = weights[0] * metrics.ssim + weights[1] * metrics.edgeRetention
                + weights[2] * commonResolution;
              candidates.push({ ...found, width, height: canvas.height, score: 0, metrics,
                qualityScore });
              break;
            }
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
          width = Math.floor(width * .75);
          await pause();
        }
      }
      if (!candidates.length) throw new Error(`图片尺寸过大，无法压到 ${limit / 1000}KB 以内`);
      candidates.sort((a, b) => b.score - a.score || b.blob.size - a.blob.size);
      const chosen = candidates[0];
      if (chosen.blob.size > limit) throw new Error(`输出超过 ${limit / 1000}KB`);
      const qualityConcern = !relaxed && needsQualityOption(chosen, category, baseWidth, originalWidth, minQuality);
      return { ...chosen, originalWidth, originalHeight, kept: false, qualityConcern };
    } finally {
      bitmap.close();
    }
  }

  function needsQualityOption(result, category, baseWidth, originalWidth, minQuality) {
    // Small text can need the 150KB option even when a small preview looks fine.
    return category === 'TEXT_HEAVY' ||
      result.metrics.ssim < .965 ||
      (category === 'GRAPHIC' && result.metrics.detailEdgeRetention < .90) ||
      result.quality < minQuality ||
      result.width < Math.min(960, originalWidth) ||
      result.width < Math.min(baseWidth, originalWidth) * .75;
  }

  function chooseWidths(allowed) {
    const pool = [...new Set([allowed, ...WIDTHS.filter((width) => width < allowed)])];
    const targets = [allowed, allowed * .93, allowed * .84, allowed * .75, Math.min(960, allowed)];
    return [...new Set(targets.map((target) => pool.reduce((best, width) =>
      Math.abs(width - target) < Math.abs(best - target) ? width : best, pool[0])))]
      .sort((a, b) => b - a);
  }

  function drawBitmap(bitmap, width) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(bitmap.height * canvas.width / bitmap.width));
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('浏览器无法创建画布');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function jpeg(canvas, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => {
      if (!blob || blob.type !== 'image/jpeg') reject(new Error('浏览器不支持 JPEG 编码'));
      else resolve(blob);
    }, 'image/jpeg', quality / 100));
  }

  async function bestJpegWithin(canvas, low, high, limit = DEFAULT_MAX) {
    let best = null;
    let lo = low;
    let hi = high;
    while (lo <= hi) {
      const quality = Math.floor((lo + hi) / 2);
      const blob = await jpeg(canvas, quality);
      if (blob.size <= limit) {
        best = { blob, quality };
        lo = quality + 1;
      } else hi = quality - 1;
    }
    // Encoders can quantize quality nonlinearly. Check the next setting as well.
    if (best && best.quality < high) {
      const next = await jpeg(canvas, best.quality + 1);
      if (next.size <= limit) best = { blob: next, quality: best.quality + 1 };
    }
    return best;
  }

  function sampleBitmap(source, maxSide) {
    const width = Math.max(1, Math.round(source.width * Math.min(1, maxSide / Math.max(source.width, source.height))));
    const height = Math.max(1, Math.round(source.height * Math.min(1, maxSide / Math.max(source.width, source.height))));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, width, height);
    return { width, height, data: ctx.getImageData(0, 0, width, height).data };
  }

  function analyze(bitmap) {
    const sample = sampleBitmap(bitmap, 384);
    const { width, height, data } = sample;
    const gray = new Float32Array(width * height);
    const bins = new Uint32Array(4096);
    let entropy = 0;
    for (let i = 0; i < gray.length; i++) {
      const k = i * 4;
      gray[i] = .2126 * data[k] + .7152 * data[k + 1] + .0722 * data[k + 2];
      bins[((data[k] >> 4) << 8) | ((data[k + 1] >> 4) << 4) | (data[k + 2] >> 4)]++;
    }
    for (const count of bins) if (count) { const p = count / gray.length; entropy -= p * Math.log2(p); }
    let edge = 0, flat = 0, directional = 0, small = 0, count = 0;
    const tileEdges = new Uint32Array(16);
    for (let y = 1; y < height - 1; y++) {
      let run = 0;
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        const gx = gray[i + 1] - gray[i - 1];
        const gy = gray[i + width] - gray[i - width];
        const strength = Math.abs(gx) + Math.abs(gy);
        const isEdge = strength > 42;
        edge += isEdge;
        flat += strength < 12;
        if (isEdge) {
          directional += Math.max(Math.abs(gx), Math.abs(gy)) > 2.5 * Math.min(Math.abs(gx), Math.abs(gy));
          const tx = Math.min(3, Math.floor(x * 4 / width));
          const ty = Math.min(3, Math.floor(y * 4 / height));
          tileEdges[ty * 4 + tx]++;
          run++;
        } else if (run) {
          if (run <= 5) small += run;
          run = 0;
        }
        count++;
      }
      if (run && run <= 5) small += run;
    }
    const rankedTiles = [...tileEdges.keys()].sort((a, b) => tileEdges[b] - tileEdges[a]);
    const picked = [];
    for (const tile of rankedTiles) {
      const tx = tile % 4, ty = Math.floor(tile / 4);
      if (picked.every((other) => Math.abs(tx - other % 4) + Math.abs(ty - Math.floor(other / 4)) >= 2)) picked.push(tile);
      if (picked.length === 3) break;
    }
    const detailPoints = picked.map((tile) => ({ x: ((tile % 4) + .5) / 4, y: (Math.floor(tile / 4) + .5) / 4 }));
    return { edge: edge / (count || 1), flat: flat / (count || 1), directional: directional / (edge || 1), small: small / (edge || 1), entropy: entropy / 12, detailPoints };
  }

  function classify(a) {
    const text = 1.5 * a.edge + .18 * a.small + .16 * a.directional + .18 * a.flat;
    const graphic = .55 * a.flat + .2 * a.directional + .35 * a.edge;
    const photo = .60 * a.entropy + .40 * (1 - a.flat) - .12 * a.directional;
    if (text > .39 && text > photo * .8 && a.edge > .085) return 'TEXT_HEAVY';
    return graphic > photo ? 'GRAPHIC' : 'PHOTO';
  }

  function makeDetailSamples(bitmap, points, category) {
    const side = Math.min(256, bitmap.width, bitmap.height);
    const count = category === 'TEXT_HEAVY' ? 3 : 2;
    return points.slice(0, count).map((point) => {
      const region = {
        x: Math.max(0, Math.min(bitmap.width - side, Math.round(point.x * bitmap.width - side / 2))),
        y: Math.max(0, Math.min(bitmap.height - side, Math.round(point.y * bitmap.height - side / 2))),
        side
      };
      return { region, sample: sampleRegion(bitmap, region, 1, 1) };
    });
  }

  function sampleRegion(bitmap, region, scaleX, scaleY) {
    const canvas = document.createElement('canvas');
    canvas.width = region.side;
    canvas.height = region.side;
    const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, region.x * scaleX, region.y * scaleY,
      region.side * scaleX, region.side * scaleY, 0, 0, region.side, region.side);
    return ctx.getImageData(0, 0, region.side, region.side).data;
  }

  async function measure(reference, details, originalWidth, originalHeight, blob, category) {
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = reference.width;
      canvas.height = reference.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const candidate = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const global = compareImages(reference.data, candidate, canvas.width, canvas.height);
      if (!details.length) return global;
      let localSsim = 0, localEdges = 0;
      for (const detail of details) {
        const sample = sampleRegion(bitmap, detail.region,
          bitmap.width / originalWidth, bitmap.height / originalHeight);
        const result = compareImages(detail.sample, sample, detail.region.side, detail.region.side);
        localSsim += result.ssim;
        localEdges += result.edgeRetention;
      }
      localSsim /= details.length;
      localEdges /= details.length;
      const focus = category === 'TEXT_HEAVY' ? .65 : category === 'GRAPHIC' ? .45 : .25;
      return {
        ssim: global.ssim * (1 - focus) + localSsim * focus,
        edgeRetention: global.edgeRetention * (1 - focus) + localEdges * focus,
        detailSsim: localSsim,
        detailEdgeRetention: localEdges
      };
    } finally { bitmap.close(); }
  }

  function compareImages(original, candidate, width, height) {
    const n = width * height;
    const a = new Float32Array(n), b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      a[i] = .2126 * original[k] + .7152 * original[k + 1] + .0722 * original[k + 2];
      b[i] = .2126 * candidate[k] + .7152 * candidate[k + 1] + .0722 * candidate[k + 2];
    }
    let ssimSum = 0, blocks = 0;
    const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
    for (let y = 0; y < height; y += 8) for (let x = 0; x < width; x += 8) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, count = 0;
      for (let yy = y; yy < Math.min(y + 8, height); yy++) for (let xx = x; xx < Math.min(x + 8, width); xx++) {
        const i = yy * width + xx, va = a[i], vb = b[i];
        sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; count++;
      }
      const ma = sa / count, mb = sb / count;
      const varianceA = Math.max(0, saa / count - ma * ma);
      const varianceB = Math.max(0, sbb / count - mb * mb);
      const covariance = sab / count - ma * mb;
      ssimSum += ((2 * ma * mb + C1) * (2 * covariance + C2)) /
        ((ma * ma + mb * mb + C1) * (varianceA + varianceB + C2));
      blocks++;
    }
    let referenceEdges = 0, keptEdges = 0;
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const ea = Math.abs(a[i + 1] - a[i - 1]) + Math.abs(a[i + width] - a[i - width]);
      if (ea < 24) continue;
      const eb = Math.abs(b[i + 1] - b[i - 1]) + Math.abs(b[i + width] - b[i - width]);
      referenceEdges += ea;
      keptEdges += Math.min(ea, eb);
    }
    return { ssim: Math.max(0, ssimSum / (blocks || 1)), edgeRetention: referenceEdges ? keptEdges / referenceEdges : 1 };
  }

  function download(blob, name) {
    if (!blob || !name) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function updateAllButton() {
    $('downloadAll').classList.toggle('hidden', entries.filter((entry) => entry.blob).length < 2);
  }

  $('downloadAll').addEventListener('click', async () => {
    const ready = entries.filter((entry) => entry.blob);
    if (!ready.length) return;
    const button = $('downloadAll');
    button.disabled = true;
    button.textContent = '正在打包…';
    try {
      const zip = await createZip(ready);
      download(zip, '压缩图片.zip');
    } catch (error) {
      console.error('打包失败：', error);
      alert('打包失败，请逐张下载。');
    } finally {
      button.disabled = false;
      button.textContent = '下载全部当前版本 ZIP';
    }
  });

  // Minimal uncompressed ZIP writer. JPEG/PNG/WebP data is already compressed.
  async function createZip(items) {
    const encoder = new TextEncoder();
    const names = new Set();
    const pieces = [], directory = [];
    let offset = 0;
    const stamp = new Date();
    const dosTime = ((stamp.getHours() & 31) << 11) | ((stamp.getMinutes() & 63) << 5) | ((stamp.getSeconds() / 2) & 31);
    const dosDate = (((stamp.getFullYear() - 1980) & 127) << 9) | (((stamp.getMonth() + 1) & 15) << 5) | (stamp.getDate() & 31);
    for (const item of items) {
      let name = item.name;
      let suffix = 2;
      while (names.has(name)) name = item.name.replace(/(\.[^.]+)$/, `_${suffix++}$1`);
      names.add(name);
      const filename = encoder.encode(name);
      const bytes = new Uint8Array(await item.blob.arrayBuffer());
      const crc = crc32(bytes);
      const local = new Uint8Array(30 + filename.length);
      const l = new DataView(local.buffer);
      l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true);
      l.setUint16(10, dosTime, true); l.setUint16(12, dosDate, true); l.setUint32(14, crc, true);
      l.setUint32(18, bytes.length, true); l.setUint32(22, bytes.length, true);
      l.setUint16(26, filename.length, true); local.set(filename, 30);
      pieces.push(local, bytes);
      const central = new Uint8Array(46 + filename.length);
      const c = new DataView(central.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
      c.setUint16(8, 0x800, true); c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true);
      c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true);
      c.setUint16(28, filename.length, true); c.setUint32(42, offset, true);
      central.set(filename, 46);
      directory.push(central);
      offset += local.length + bytes.length;
      await pause();
    }
    const centralLength = directory.reduce((sum, block) => sum + block.length, 0);
    const end = new Uint8Array(22);
    const e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, items.length, true);
    e.setUint16(10, items.length, true); e.setUint32(12, centralLength, true);
    e.setUint32(16, offset, true);
    return new Blob([...pieces, ...directory, end], { type: 'application/zip' });
  }

  const CRC_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[i] = c >>> 0;
  }
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const value of bytes) crc = CRC_TABLE[(crc ^ value) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
})();
