let pdfjsLib = null;

async function ensurePdfJs() {
  if (!pdfjsLib) {
    pdfjsLib = await import('./vendor/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjsLib;
}

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const els = {
  openBtn: $('openBtn'),
  dropOpenBtn: $('dropOpenBtn'),
  demoBtn: $('demoBtn'),
  fileInput: $('fileInput'),
  clearBtn: $('clearBtn'),
  docName: $('docName'),
  pageCountLabel: $('pageCountLabel'),
  pageList: $('pageList'),
  dropZone: $('dropZone'),
  loading: $('loading'),
  loadingText: $('loadingText'),
  scroller: $('scroller'),
  pages: $('pages'),
  playhead: $('playhead'),
  countdown: $('countdown'),
  progressRail: $('progressRail'),
  progressFill: $('progressFill'),
  progressThumb: $('progressThumb'),
  loopRange: $('loopRange'),
  playBtn: $('playBtn'),
  speedSlider: $('speedSlider'),
  speedValue: $('speedValue'),
  speedLabel: $('speedLabel'),
  speedUnit: $('speedUnit'),
  beatModeBtn: $('beatModeBtn'),
  lineBeatsSelect: $('lineBeatsSelect'),
  metroBtn: $('metroBtn'),
  bpmSlider: $('bpmSlider'),
  bpmValue: $('bpmValue'),
  countInSelect: $('countInSelect'),
  beatDots: [...document.querySelectorAll('#beatDots span')],
  setABtn: $('setABtn'),
  setBBtn: $('setBBtn'),
  loopBtn: $('loopBtn'),
  clearLoopBtn: $('clearLoopBtn'),
  loopLabel: $('loopLabel'),
  zoomOutBtn: $('zoomOutBtn'),
  zoomInBtn: $('zoomInBtn'),
  zoomValue: $('zoomValue'),
  rotateBtn: $('rotateBtn'),
  fullscreenBtn: $('fullscreenBtn'),
  helpBtn: $('helpBtn'),
  helpModal: $('helpModal'),
  helpClose: $('helpClose'),
  toast: $('toast'),
  debugPanel: $('debugPanel'),
  focusOverlay: $('focusOverlay'),
  focusBtn: $('focusBtn'),
  vScroll: $('vScroll'),
  vThumb: $('vThumb'),
};

/* ---------- State ---------- */
const SETTINGS_KEY = 'tabflow.settings.v2';

const state = {
  pages: [],
  docName: '',
  playing: false,
  speed: 40,
  scrollMode: 'line',   // 'free' = 匀速；'line' = 逐行
  lineStep: 110,
  lineBeats: 2,
  lineTimer: 0,
  lineRaf: 0,
  focus: true,
  zoom: 1,
  rotation: 0,
  bpm: 80,
  countIn: 0,
  metroOn: false,
  audioCtx: null,
  metroRunning: false,
  metroTimer: null,
  metroBeat: 0,
  nextNoteTime: 0,
  dotTimeouts: [],
  countInToken: 0,
  loop: { a: null, b: null, active: false },
  raf: 0,
  lastTs: 0,
  currentPage: -1,
  loading: false,
  counting: false,
  toastTimer: null,
  scrollRaf: 0,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

/* ---------- Settings ---------- */
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (Number.isFinite(s.speed)) state.speed = clamp(s.speed, 5, 200);
    if (Number.isFinite(s.lineStep)) state.lineStep = clamp(s.lineStep, 40, 240);
    if (Number.isFinite(s.lineBeats)) state.lineBeats = clamp(s.lineBeats, 1, 8);
    if (s.scrollMode === 'line' || s.scrollMode === 'free') state.scrollMode = s.scrollMode;
    if (typeof s.focus === 'boolean') state.focus = s.focus;
    if (Number.isFinite(s.bpm)) state.bpm = clamp(s.bpm, 40, 200);
    if (Number.isFinite(s.countIn)) state.countIn = s.countIn;
    if (Number.isFinite(s.zoom)) state.zoom = clamp(s.zoom, 0.5, 2);
  } catch { /* ignore */ }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      speed: state.speed,
      lineStep: state.lineStep,
      lineBeats: state.lineBeats,
      scrollMode: state.scrollMode,
      focus: state.focus,
      bpm: state.bpm,
      countIn: state.countIn,
      zoom: state.zoom,
    }));
  } catch { /* ignore */ }
}

/* ---------- Toast / Loading ---------- */
function toast(message, ms = 2600) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.hidden = false;
  state.toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function showLoading(text = '正在解析…') {
  els.loadingText.textContent = text;
  els.loading.hidden = false;
}

function setLoadingText(text) {
  els.loadingText.textContent = text;
}

function hideLoading() {
  els.loading.hidden = true;
}

/* ---------- Document lifecycle ---------- */
function resetDocument() {
  pause(true);
  stopMetronome();

  for (const page of state.pages) {
    if (page.objectUrl) URL.revokeObjectURL(page.objectUrl);
  }

  state.pages = [];
  state.docName = '';
  state.currentPage = -1;
  state.loop = { a: null, b: null, active: false };
  state.rotation = 0;
  state.metroOn = false;
  state.counting = false;

  els.pages.innerHTML = '';
  els.pageList.innerHTML = '';
  els.docName.textContent = '未打开文件';
  els.pageCountLabel.textContent = '0';
  els.scroller.scrollTop = 0;
  els.pages.style.zoom = String(state.zoom);
  els.progressFill.style.width = '0%';
  els.progressThumb.style.left = '0%';
  els.playhead.hidden = true;
  updateLoopUI();
  setDocumentVisible(false);
  syncFocusUI();
  updateVScroll();
}

function setDocumentVisible(hasDoc) {
  els.dropZone.hidden = hasDoc;
  els.scroller.hidden = !hasDoc;
  els.progressRail.hidden = !hasDoc;
}

async function handleFiles(fileList) {
  if (state.loading) {
    toast('正在解析，请稍候');
    return;
  }

  const files = [...fileList].filter(
    (f) => f.type === 'application/pdf'
      || f.type.startsWith('image/')
      || /\.(pdf|png|jpe?g|webp|gif|bmp)$/i.test(f.name)
  );
  if (!files.length) {
    toast('请选择图片或 PDF 文件');
    return;
  }

  resetDocument();
  state.loading = true;
  state.docName = files.length === 1 ? files[0].name : `${files.length} 个文件`;
  els.docName.textContent = state.docName;
  showLoading('正在读取文件…');

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        await loadPDF(file);
      } else {
        await loadImage(file);
      }
      await nextFrame();
    }

    if (!state.pages.length) throw new Error('没有可用页面');

    finishDocument();
    toast(`已打开 ${state.pages.length} 页`);
  } catch (err) {
    console.error(err);
    resetDocument();
    toast(`打开失败：${err?.message || '文件无法解析'}`, 4200);
  } finally {
    state.loading = false;
    hideLoading();
  }
}

async function loadPDF(file) {
  const data = await file.arrayBuffer();
  const lib = await ensurePdfJs();
  const pdf = await lib.getDocument({ data }).promise;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  for (let n = 1; n <= pdf.numPages; n++) {
    setLoadingText(`正在解析 PDF… ${n}/${pdf.numPages}`);
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1.6 });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;

    addPage({
      type: 'pdf',
      canvas,
      natW: viewport.width,
      natH: viewport.height,
      label: `PDF 第 ${n} 页`,
    });

    await sleep(0);
  }
}

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  addPage({
    type: 'image',
    img,
    natW: img.naturalWidth,
    natH: img.naturalHeight,
    objectUrl: url,
    label: file.name,
  });
}

async function loadDemo() {
  if (state.loading) return;
  resetDocument();
  state.loading = true;
  state.docName = 'TabFlow 示例谱';
  els.docName.textContent = state.docName;
  showLoading('正在加载示例…');

  try {
    const img = new Image();
    img.src = 'demo.svg';
    await img.decode();
    addPage({
      type: 'image',
      img,
      natW: img.naturalWidth,
      natH: img.naturalHeight,
      label: '示例',
    });
    finishDocument();
    toast('示例已加载，按空格开始自动滚动');
  } catch (err) {
    console.error(err);
    resetDocument();
    toast('示例加载失败');
  } finally {
    state.loading = false;
    hideLoading();
  }
}

function addPage(page) {
  const article = document.createElement('article');
  article.className = 'page';

  const content = document.createElement('div');
  content.className = 'page-content';
  if (page.type === 'pdf') {
    content.appendChild(page.canvas);
  } else {
    page.img.draggable = false;
    content.appendChild(page.img);
  }

  const num = document.createElement('div');
  num.className = 'page-num';
  num.textContent = String(state.pages.length + 1);

  article.appendChild(content);
  article.appendChild(num);
  els.pages.appendChild(article);

  page.el = article;
  page.inner = content;
  page.baseW = 0;
  page.baseH = 0;

  const index = state.pages.length;
  state.pages.push(page);

  const btn = document.createElement('button');
  btn.className = 'page-btn';
  btn.type = 'button';
  btn.title = page.label || `第 ${index + 1} 页`;

  const thumb = document.createElement('span');
  thumb.className = 'page-thumb';
  thumb.style.backgroundImage = `url(${makeThumb(page)})`;

  const label = document.createElement('span');
  label.textContent = `第 ${index + 1} 页`;

  btn.appendChild(thumb);
  btn.appendChild(label);
  btn.addEventListener('click', () => scrollToPage(index));
  els.pageList.appendChild(btn);
  page.btn = btn;

  els.pageCountLabel.textContent = String(state.pages.length);
}

function makeThumb(page) {
  const tw = 84;
  const th = 112;
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, tw, th);

  const src = page.type === 'pdf' ? page.canvas : page.img;
  const sw = page.type === 'pdf' ? page.canvas.width : page.img.naturalWidth;
  const sh = page.type === 'pdf' ? page.canvas.height : page.img.naturalHeight;
  const scale = Math.min(tw / sw, th / sh);
  const w = sw * scale;
  const h = sh * scale;
  try {
    ctx.drawImage(src, (tw - w) / 2, (th - h) / 2, w, h);
  } catch { /* ignore */ }
  return canvas.toDataURL('image/jpeg', 0.72);
}

function finishDocument() {
  setDocumentVisible(true);
  els.pageCountLabel.textContent = String(state.pages.length);
  syncFocusUI();
  requestAnimationFrame(() => {
    layoutPages();
    els.scroller.scrollTop = 0;
    updateProgress();
    updateActivePage();
  });
}

/* ---------- Layout ---------- */
function layoutPages() {
  if (!state.pages.length) return;

  const available = Math.max(280, els.scroller.clientWidth - 76);
  const maxH = Math.max(260, els.scroller.clientHeight - 140);
  const rotated = state.rotation % 180 !== 0;

  for (const page of state.pages) {
    const natW = Math.max(1, page.natW);
    const natH = Math.max(1, page.natH);

    let scale;
    if (rotated) {
      scale = Math.min(1, available / natH, maxH / natW);
    } else {
      scale = Math.min(1, available / natW);
    }

    const baseW = Math.max(40, natW * scale);
    const baseH = Math.max(40, natH * scale);
    page.baseW = baseW;
    page.baseH = baseH;

    page.el.style.width = `${rotated ? baseH : baseW}px`;
    page.el.style.height = `${rotated ? baseW : baseH}px`;
    page.inner.style.width = `${baseW}px`;
    page.inner.style.height = `${baseH}px`;
    page.inner.style.transform = `rotate(${state.rotation}deg)`;
  }

  els.pages.style.zoom = String(state.zoom);
  updateProgress();
}

function captureRatio() {
  const max = maxScroll();
  return max > 0 ? clamp(els.scroller.scrollTop / max, 0, 1) : 0;
}

function restoreRatio(ratio) {
  const max = maxScroll();
  els.scroller.scrollTop = clamp(ratio, 0, 1) * Math.max(0, max);
  updateProgress();
}

function withPreservedScroll(fn) {
  const ratio = captureRatio();
  fn();
  requestAnimationFrame(() => restoreRatio(ratio));
}

function maxScroll() {
  return Math.max(0, els.scroller.scrollHeight - els.scroller.clientHeight);
}

function currentRatio() {
  const max = maxScroll();
  return max > 0 ? clamp(els.scroller.scrollTop / max, 0, 1) : 0;
}

/* ---------- Zoom / rotate ---------- */
function setZoom(value) {
  const next = clamp(Math.round(value * 20) / 20, 0.5, 2);
  if (Math.abs(next - state.zoom) < 0.001) return;

  const ratio = captureRatio();
  state.zoom = next;
  els.pages.style.zoom = String(state.zoom);
  els.zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;
  requestAnimationFrame(() => restoreRatio(ratio));
  saveSettings();
}

function rotatePage() {
  withPreservedScroll(() => {
    state.rotation = (state.rotation + 90) % 360;
    layoutPages();
  });
}

/* ---------- Scroll / progress ---------- */
function updateProgress() {
  const max = maxScroll();
  const ratio = max > 0 ? clamp(els.scroller.scrollTop / max, 0, 1) : 0;
  els.progressFill.style.width = `${ratio * 100}%`;
  els.progressThumb.style.left = `${ratio * 100}%`;
  updateVScroll();
  updateLoopRange();
  updateActivePage();
}

function updateVScroll() {
  if (!state.pages.length) {
    els.vScroll.hidden = true;
    return;
  }

  const max = maxScroll();
  if (max <= 1) {
    els.vScroll.hidden = true;
    return;
  }

  els.vScroll.hidden = false;

  const trackH = els.vScroll.clientHeight;
  const clientH = els.scroller.clientHeight;
  const scrollH = els.scroller.scrollHeight;
  const thumbH = Math.max(24, Math.min(trackH, (clientH / scrollH) * trackH));
  const top = (els.scroller.scrollTop / max) * Math.max(0, trackH - thumbH);

  els.vThumb.style.height = `${thumbH}px`;
  els.vThumb.style.top = `${top}px`;
}

function updateActivePage() {
  if (!state.pages.length) return;

  const probe = els.scroller.scrollTop + Math.min(140, els.scroller.clientHeight * 0.3);
  let active = 0;

  for (let i = 0; i < state.pages.length; i++) {
    const page = state.pages[i];
    const top = page.el.offsetTop;
    const bottom = top + page.el.offsetHeight;
    if (probe >= top && probe < bottom) {
      active = i;
      break;
    }
    if (top <= probe) active = i;
  }

  if (active !== state.currentPage) {
    state.currentPage = active;
    state.pages.forEach((page, i) => {
      page.btn?.classList.toggle('active', i === active);
    });
  }
}

function scrollToPage(index) {
  const page = state.pages[index];
  if (!page) return;
  const top = page.el.offsetTop + els.pages.offsetTop - 8;
  els.scroller.scrollTo({ top, behavior: 'smooth' });
}

/* ---------- Line-by-line scroll ---------- */
function stopLineScroll() {
  if (state.lineTimer) {
    clearTimeout(state.lineTimer);
    state.lineTimer = 0;
  }

  if (state.lineRaf) {
    cancelAnimationFrame(state.lineRaf);
    state.lineRaf = 0;
  }
}

function animateLineStep(from, to, duration, done) {
  cancelAnimationFrame(state.lineRaf);
  const start = performance.now();
  const ms = Math.max(80, duration);

  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = t * t * (3 - 2 * t);
    els.scroller.scrollTop = from + (to - from) * eased;

    if (t < 1) {
      state.lineRaf = requestAnimationFrame(step);
    } else {
      state.lineRaf = 0;
      if (done) done();
    }
  };

  state.lineRaf = requestAnimationFrame(step);
}

function lineStepTick() {
  if (!state.playing || state.scrollMode !== 'line') return;

  const max = maxScroll();
  if (max <= 1) {
    pause();
    toast('当前谱面已完整显示，没有可滚动空间');
    return;
  }

  const interval = (60000 / state.bpm) * state.lineBeats;
  const duration = Math.min(260, interval * 0.45);

  let from = els.scroller.scrollTop;
  let to = from + state.lineStep;

  if (state.loop.active && state.loop.a != null && state.loop.b != null) {
    const a = state.loop.a * max;
    const b = state.loop.b * max;
    if (b > a + 2 && to >= b) {
      from = a;
      els.scroller.scrollTop = a;
      to = a + state.lineStep;
    }
  }

  const atEnd = to >= max - 0.5;
  if (atEnd) to = max;

  animateLineStep(from, to, duration, () => {
    if (!state.playing || state.scrollMode !== 'line') return;

    if (atEnd) {
      pause();
      toast('已到谱面末尾');
      return;
    }

    const wait = Math.max(60, interval - duration);
    state.lineTimer = setTimeout(lineStepTick, wait);
  });
}

function startLineScroll() {
  stopLineScroll();
  state.lineTimer = setTimeout(lineStepTick, 80);
}

/* ---------- Auto-scroll ---------- */
async function togglePlay() {
  if (state.playing || state.counting) {
    pause();
    return;
  }

  if (!state.pages.length) {
    toast('请先打开谱面');
    return;
  }

  if (maxScroll() <= 1) {
    toast('当前谱面已完整显示，没有可滚动空间；请放大（+）或打开多页 PDF');
    return;
  }

  const lineMode = state.scrollMode === 'line';
  let audioReady = true;

  if (state.metroOn) {
    try {
      audioReady = false;
      await Promise.race([
        ensureAudio()
          .then(() => { audioReady = true; })
          .catch(() => { audioReady = false; }),
        sleep(900),
      ]);
    } catch {
      audioReady = false;
    }
  }

  if (!audioReady) {
    state.metroOn = false;
    stopMetronome();
  }
  if (state.metroOn) stopMetronome();

  if (state.metroOn && state.countIn > 0) {
    const ok = await runCountIn(state.countIn);
    if (!ok) return;
  }

  if (els.scroller.scrollTop >= maxScroll() - 2) {
    els.scroller.scrollTop = 0;
  }

  state.playing = true;
  state.lastTs = 0;
  els.playBtn.textContent = '❚❚';
  els.playBtn.classList.add('playing');
  els.playhead.hidden = state.focus;

  if (lineMode) {
    toast(`逐行开始：每 ${state.lineBeats} 拍滚动 ${state.lineStep} px`);
    startLineScroll();
  } else {
    state.raf = requestAnimationFrame(tick);
  }

  if (state.metroOn) startMetronome();
}

function pause(silent = false) {
  state.playing = false;
  state.counting = false;
  state.countInToken++;
  state.lastTs = 0;
  stopLineScroll();

  if (state.raf) {
    cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  els.playBtn.textContent = '▶';
  els.playBtn.classList.remove('playing');
  els.playhead.hidden = true;
  hideCountdown();
  state.metroOn = false;
  stopMetronome();
}

function tick(ts) {
  if (!state.playing || state.scrollMode === 'line') return;

  if (!state.lastTs) state.lastTs = ts;
  const dt = Math.min(0.06, (ts - state.lastTs) / 1000);
  state.lastTs = ts;

  const max = maxScroll();
  if (max <= 1) {
    pause();
    return;
  }

  let next = els.scroller.scrollTop + state.speed * dt;

  if (state.loop.active && state.loop.a != null && state.loop.b != null) {
    const a = state.loop.a * max;
    const b = state.loop.b * max;
    if (b > a + 2 && next >= b) {
      next = a;
    }
  }

  if (next >= max - 0.5) {
    els.scroller.scrollTop = max;
    pause();
    toast('已到谱面末尾');
    return;
  }

  els.scroller.scrollTop = next;
  state.raf = requestAnimationFrame(tick);
}

/* ---------- Metronome ---------- */
async function ensureAudio() {
  if (!state.audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('浏览器不支持 Web Audio');
    state.audioCtx = new Ctx();
  }
  if (state.audioCtx.state === 'suspended') {
    await state.audioCtx.resume();
  }
}

function clickAt(time, accent) {
  const ctx = state.audioCtx;
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(accent ? 1400 : 920, time);

  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(accent ? 0.30 : 0.20, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.07);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(time);
  osc.stop(time + 0.09);
}

function metroScheduler() {
  if (!state.metroRunning || !state.audioCtx) return;

  while (state.nextNoteTime < state.audioCtx.currentTime + 0.12) {
    const beat = state.metroBeat % 4;
    const beatTime = state.nextNoteTime;

    clickAt(beatTime, beat === 0);
    scheduleDot(beat, beatTime);

    state.nextNoteTime += 60 / state.bpm;
    state.metroBeat++;
  }
}

function scheduleDot(index, time) {
  const delay = Math.max(0, (time - state.audioCtx.currentTime) * 1000);
  const timer = setTimeout(() => flashDot(index), delay);
  state.dotTimeouts.push(timer);
  if (state.dotTimeouts.length > 48) {
    clearTimeout(state.dotTimeouts.shift());
  }
}

function flashDot(index) {
  els.beatDots.forEach((dot, i) => dot.classList.toggle('active', i === index));
  const timer = setTimeout(() => {
    els.beatDots[index]?.classList.remove('active');
  }, 110);
  state.dotTimeouts.push(timer);
}

function clearDots() {
  els.beatDots.forEach((dot) => dot.classList.remove('active'));
}

function startMetronome() {
  if (!state.audioCtx) return;
  stopMetronome();

  state.metroRunning = true;
  state.metroBeat = 0;
  state.nextNoteTime = state.audioCtx.currentTime + 0.06;
  state.metroTimer = setInterval(metroScheduler, 25);

  els.metroBtn.classList.add('active');
  els.metroBtn.textContent = '节拍器 · 开';
}

function stopMetronome() {
  state.metroRunning = false;

  if (state.metroTimer) {
    clearInterval(state.metroTimer);
    state.metroTimer = null;
  }

  state.dotTimeouts.forEach((t) => clearTimeout(t));
  state.dotTimeouts = [];
  clearDots();

  els.metroBtn.classList.remove('active');
  els.metroBtn.textContent = '节拍器';
}

async function toggleMetronome() {
  try {
    await ensureAudio();
  } catch (err) {
    toast(`无法启动音频：${err?.message || '浏览器限制'}`);
    return;
  }

  state.metroOn = !state.metroOn;

  if (state.metroOn) {
    startMetronome();
  } else {
    stopMetronome();
  }
}

async function runCountIn(beats) {
  const token = ++state.countInToken;
  state.counting = true;

  for (let i = 0; i < beats; i++) {
    if (token !== state.countInToken) {
      state.counting = false;
      hideCountdown();
      clearDots();
      return false;
    }

    showCountdown(beats - i);
    clickAt(state.audioCtx.currentTime + 0.02, i % 4 === 0);
    flashDot(i % 4);

    await sleep(60000 / state.bpm);
  }

  state.counting = false;

  if (token !== state.countInToken) {
    hideCountdown();
    clearDots();
    return false;
  }

  hideCountdown();
  clearDots();
  return true;
}

function showCountdown(n) {
  els.countdown.textContent = String(n);
  els.countdown.hidden = false;
  els.countdown.style.animation = 'none';
  void els.countdown.offsetWidth;
  els.countdown.style.animation = '';
}

function hideCountdown() {
  els.countdown.hidden = true;
}

/* ---------- A-B loop ---------- */
function setLoopA() {
  if (!state.pages.length) return toast('请先打开谱面');

  const ratio = currentRatio();
  if (state.loop.b != null && ratio >= state.loop.b - 0.002) {
    toast('A 必须在 B 之前');
    return;
  }

  state.loop.a = ratio;
  state.loop.active = false;
  updateLoopUI();
  toast(`循环起点 A：${Math.round(ratio * 100)}%`);
}

function setLoopB() {
  if (!state.pages.length) return toast('请先打开谱面');

  const ratio = currentRatio();
  if (state.loop.a != null && ratio <= state.loop.a + 0.002) {
    toast('B 必须在 A 之后');
    return;
  }

  state.loop.b = ratio;
  state.loop.active = false;
  updateLoopUI();
  toast(`循环终点 B：${Math.round(ratio * 100)}%`);
}

function toggleLoop() {
  if (state.loop.a == null || state.loop.b == null) {
    toast('请先设置 A 和 B');
    return;
  }

  if (state.loop.b <= state.loop.a + 0.002) {
    toast('B 必须在 A 之后');
    return;
  }

  state.loop.active = !state.loop.active;
  updateLoopUI();
  toast(state.loop.active ? 'A-B 循环已开启' : 'A-B 循环已关闭');
}

function clearLoop() {
  state.loop = { a: null, b: null, active: false };
  updateLoopUI();
  toast('已清除 A-B');
}

function updateLoopUI() {
  const { a, b, active } = state.loop;

  const fmt = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
  els.loopLabel.textContent = `A ${fmt(a)} · B ${fmt(b)}`;

  els.loopBtn.classList.toggle('active', active);
  els.loopBtn.textContent = active ? '循环中' : '循环';

  if (a != null && b != null && b > a) {
    els.loopRange.hidden = false;
    els.loopRange.style.left = `${a * 100}%`;
    els.loopRange.style.width = `${(b - a) * 100}%`;
  } else {
    els.loopRange.hidden = true;
  }
}

function updateLoopRange() {
  const { a, b } = state.loop;
  if (a != null && b != null && b > a) {
    els.loopRange.style.left = `${a * 100}%`;
    els.loopRange.style.width = `${(b - a) * 100}%`;
  }
}

/* ---------- Fullscreen / help ---------- */
async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch {
    toast('当前浏览器不支持全屏');
  }
}

function openHelp() {
  els.helpModal.hidden = false;
}

function closeHelp() {
  els.helpModal.hidden = true;
}

/* ---------- UI sync ---------- */
function syncSpeedUI() {
  const line = state.scrollMode === 'line';

  els.speedSlider.min = line ? '40' : '5';
  els.speedSlider.max = line ? '240' : '200';
  els.speedSlider.step = '5';

  const value = line ? state.lineStep : state.speed;
  els.speedSlider.value = String(value);
  els.speedValue.textContent = String(value);
  els.speedLabel.textContent = line ? '每行高度' : '滚动速度';
  els.speedUnit.textContent = line ? 'px/行' : 'px/s';

  els.beatModeBtn.classList.toggle('active', line);
  els.beatModeBtn.textContent = line ? '逐行中' : '逐行';
  els.lineBeatsSelect.hidden = !line;
  els.lineBeatsSelect.value = String(state.lineBeats);
  syncFocusUI();
}

function syncFocusUI() {
  const show = state.focus && state.pages.length > 0;
  els.focusOverlay.hidden = !show;
  els.focusOverlay.style.setProperty('--focus-h', `${clamp(state.lineStep, 60, 260)}px`);
  els.focusBtn.classList.toggle('active', state.focus);
  els.focusBtn.textContent = state.focus ? '高亮中' : '高亮';
  els.playhead.hidden = !state.playing || state.focus;
}

function toggleFocus() {
  state.focus = !state.focus;
  syncFocusUI();
  saveSettings();
  toast(state.focus ? '当前行高亮已开启' : '当前行高亮已关闭');
}

function setScrollMode(mode) {
  if (mode === state.scrollMode) return;

  pause();
  state.scrollMode = mode;
  state.metroOn = false;
  syncSpeedUI();
  saveSettings();

  toast(mode === 'line'
    ? '逐行模式：每个节拍滚动一行，按空格开始'
    : '匀速模式：按空格开始');
}

function syncControls() {
  syncSpeedUI();
  els.bpmSlider.value = String(state.bpm);
  els.bpmValue.textContent = String(state.bpm);
  els.countInSelect.value = String(state.countIn);
  els.zoomValue.textContent = `${Math.round(state.zoom * 100)}%`;
  els.pages.style.zoom = String(state.zoom);
}

/* ---------- Events ---------- */
function bindEvents() {
  [els.openBtn, els.dropOpenBtn].forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      els.fileInput.click();
    });
  });

  els.demoBtn.addEventListener('click', loadDemo);
  els.clearBtn.addEventListener('click', () => {
    if (!state.pages.length) return;
    resetDocument();
    toast('已清空');
  });

  els.fileInput.addEventListener('change', (e) => {
    if (e.target.files?.length) handleFiles(e.target.files);
    e.target.value = '';
  });

  const reader = $('reader');

  ['dragenter', 'dragover'].forEach((name) => {
    reader.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.dropZone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach((name) => {
    reader.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.dropZone.classList.remove('dragover');
    });
  });

  reader.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });

  document.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const files = items
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length) {
      e.preventDefault();
      handleFiles(files);
    }
  });

  els.playBtn.addEventListener('click', togglePlay);
  els.speedSlider.addEventListener('input', () => {
    const value = Number(els.speedSlider.value);

    if (state.scrollMode === 'line') {
      state.lineStep = value;
    } else {
      state.speed = value;
    }

    els.speedValue.textContent = String(value);
    syncFocusUI();
    saveSettings();
  });

  els.beatModeBtn.addEventListener('click', () => {
    setScrollMode(state.scrollMode === 'line' ? 'free' : 'line');
  });

  els.focusBtn.addEventListener('click', toggleFocus);

  els.metroBtn.addEventListener('click', toggleMetronome);
  els.bpmSlider.addEventListener('input', () => {
    state.bpm = Number(els.bpmSlider.value);
    els.bpmValue.textContent = String(state.bpm);
    saveSettings();
  });
  els.countInSelect.addEventListener('change', () => {
    state.countIn = Number(els.countInSelect.value);
    saveSettings();
  });
  els.lineBeatsSelect.addEventListener('change', () => {
    state.lineBeats = Number(els.lineBeatsSelect.value);
    saveSettings();
  });

  els.setABtn.addEventListener('click', setLoopA);
  els.setBBtn.addEventListener('click', setLoopB);
  els.loopBtn.addEventListener('click', toggleLoop);
  els.clearLoopBtn.addEventListener('click', clearLoop);

  els.zoomOutBtn.addEventListener('click', () => setZoom(state.zoom - 0.1));
  els.zoomInBtn.addEventListener('click', () => setZoom(state.zoom + 0.1));
  els.rotateBtn.addEventListener('click', rotatePage);
  els.fullscreenBtn.addEventListener('click', toggleFullscreen);

  els.helpBtn.addEventListener('click', openHelp);
  els.helpClose.addEventListener('click', closeHelp);
  els.helpModal.addEventListener('click', (e) => {
    if (e.target === els.helpModal) closeHelp();
  });

  els.scroller.addEventListener('scroll', () => {
    if (state.scrollRaf) return;
    state.scrollRaf = requestAnimationFrame(() => {
      state.scrollRaf = 0;
      updateProgress();
    });
  });

  els.progressRail.addEventListener('click', (e) => {
    const rect = els.progressRail.getBoundingClientRect();
    const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    els.scroller.scrollTop = ratio * maxScroll();
    updateProgress();
  });

  document.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (tag === 'INPUT' && e.target.type !== 'range') return;

    if (!els.helpModal.hidden) {
      if (e.key === 'Escape') closeHelp();
      return;
    }

    if (e.code === 'Space') {
      if (e.target?.tagName === 'BUTTON') return;  // 让按钮自己响应空格，避免触发两次
      e.preventDefault();
      togglePlay();
      return;
    }

    const key = e.key.toLowerCase();
    if (key === 'm') { e.preventDefault(); toggleMetronome(); }
    else if (key === 'a') { e.preventDefault(); setLoopA(); }
    else if (key === 'b') { e.preventDefault(); setLoopB(); }
    else if (key === 'l') { e.preventDefault(); toggleLoop(); }
    else if (key === '+' || key === '=') { e.preventDefault(); setZoom(state.zoom + 0.1); }
    else if (key === '-') { e.preventDefault(); setZoom(state.zoom - 0.1); }
    else if (key === 'r') { e.preventDefault(); rotatePage(); }
    else if (key === 'h') { e.preventDefault(); toggleFocus(); }
    else if (key === 'f') { e.preventDefault(); toggleFullscreen(); }
    else if (key === '?') { e.preventDefault(); openHelp(); }
    else if (key === 'escape') { closeHelp(); }
  });

  document.addEventListener('fullscreenchange', () => {
    setTimeout(() => {
      if (state.pages.length) withPreservedScroll(layoutPages);
    }, 120);
  });

  const resizeObserver = new ResizeObserver(() => {
    if (!state.pages.length) return;
    clearTimeout(resizeObserver._timer);
    resizeObserver._timer = setTimeout(() => {
      withPreservedScroll(layoutPages);
    }, 100);
  });
  resizeObserver.observe(els.scroller);
}

/* ---------- Init ---------- */
function init() {
  bindEvents();
  loadSettings();
  syncControls();
  updateLoopUI();

  if (new URLSearchParams(location.search).has('debug')) {
    els.debugPanel.hidden = false;
    setInterval(() => {
      els.debugPanel.textContent = [
        `mode=${state.scrollMode}`,
        `playing=${state.playing}`,
        `scrollTop=${Math.round(els.scroller.scrollTop)}`,
        `max=${Math.round(maxScroll())}`,
        `clientH=${els.scroller.clientHeight}`,
        `scrollH=${els.scroller.scrollHeight}`,
        `pages=${state.pages.length}`,
        `lineStep=${state.lineStep}`,
        `lineBeats=${state.lineBeats}`,
        `lineTimer=${state.lineTimer ? 1 : 0}`,
        `lineRaf=${state.lineRaf ? 1 : 0}`,
        `countIn=${state.countIn}`,
        `metroOn=${state.metroOn}`,
        `zoom=${state.zoom}`,
        `bpm=${state.bpm}`,
      ].join('\n');
    }, 300);
  }

  if (location.protocol === 'file:') {
    setTimeout(() => {
      toast('请通过 start.bat 启动本地服务器，否则 PDF 可能无法解析', 6000);
    }, 700);
  }
}

try {
  init();
} catch (err) {
  console.error(err);
  const el = document.getElementById('bootError');
  if (el) {
    el.hidden = false;
    el.textContent = `初始化失败：${err?.message || err}`;
  }
}
