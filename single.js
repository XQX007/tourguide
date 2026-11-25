let pdfjsLib = null;

async function ensurePdf() {
  if (!pdfjsLib) {
    pdfjsLib = await import('./vendor/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjsLib;
}

const $ = (id) => document.getElementById(id);
const els = {
  file: $('file'),
  empty: $('empty'),
  view: $('view'),
  hscroll: $('hscroll'),
  strip: $('strip'),
  overlay: $('overlay'),
  info: $('info'),
  loading: $('loading'),
  loadingText: $('loadingText'),
  play: $('play'),
  bpm: $('bpm'),
  bpmv: $('bpmv'),
  beats: $('beats'),
  fitMeasures: $('fitMeasures'),
  mw: $('mw'),
  mwv: $('mwv'),
  barsMode: $('barsMode'),
  loop: $('loop'),
  fs: $('fs'),
  status: $('status'),
  toast: $('toast'),
};

const state = {
  sources: [],
  systems: [],
  marks: [],
  autoBars: true,
  stripCanvas: null,
  stripW: 0,
  stripH: 0,
  measureIndex: 0,
  measureStart: 0,
  lineProgress: 0,
  lineX: 0,
  range: null,
  measureWidth: 360,
  fitMeasures: 3,
  beats: 4,
  bpm: 80,
  loop: true,
  playing: false,
  timer: 0,
  raf: 0,
  toastTimer: 0,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ANALYSIS_W = 800;

function toast(msg, ms = 2600) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = msg;
  els.toast.hidden = false;
  state.toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function showError(msg) {
  const el = document.getElementById('bootError');
  if (!el) return;
  el.hidden = false;
  el.textContent = `页面脚本出错：${msg}`;
}

function showLoading(text) {
  els.loadingText.textContent = text;
  els.loading.hidden = false;
}

function hideLoading() {
  els.loading.hidden = true;
}

function resetView() {
  pause();
  state.sources = [];
  state.systems = [];
  state.marks = [];
  state.measureIndex = 0;
  state.measureStart = 0;
  state.lineProgress = 0;
  state.lineX = 0;
  state.range = null;
  state.stripCanvas = null;
  state.stripW = 0;
  state.stripH = 0;

  els.view.hidden = true;
  els.empty.hidden = false;
  els.strip.width = 0;
  els.strip.height = 0;
  els.strip.style.width = '0px';
  els.hscroll.scrollLeft = 0;
  els.info.textContent = '等待识别…';
  els.status.textContent = '等待上传';
}

/* ---------- 识别 ---------- */
function findMeasureMarks(aw, darkMap, top, avg, vlines) {
  const bandTop = Math.max(0, Math.round(top - avg * 2.2));
  const bandBot = Math.max(bandTop + 1, Math.round(top - 1));
  const bw = aw;
  const bh = bandBot - bandTop;

  if (bh < 4) return [];

  const band = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    const sy = (bandTop + y) * aw;
    const dy = y * bw;
    for (let x = 0; x < bw; x++) {
      band[dy + x] = darkMap[sy + x];
    }
  }

  const seen = new Uint8Array(bw * bh);
  const comps = [];

  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const idx = y * bw + x;
      if (!band[idx] || seen[idx]) continue;

      const stack = [idx];
      seen[idx] = 1;
      let minx = x;
      let maxx = x;
      let miny = y;
      let maxy = y;
      let area = 0;

      while (stack.length) {
        const cur = stack.pop();
        const cy = Math.floor(cur / bw);
        const cx = cur - cy * bw;
        area++;
        if (cx < minx) minx = cx;
        if (cx > maxx) maxx = cx;
        if (cy < miny) miny = cy;
        if (cy > maxy) maxy = cy;

        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (!oy && !ox) continue;
            const ny = cy + oy;
            const nx = cx + ox;
            if (ny < 0 || ny >= bh || nx < 0 || nx >= bw) continue;
            const ni = ny * bw + nx;
            if (band[ni] && !seen[ni]) {
              seen[ni] = 1;
              stack.push(ni);
            }
          }
        }
      }

      comps.push({ minx, maxx, miny, maxy, area });
    }
  }

  const maxH = Math.max(6, Math.round(avg * 0.9));
  const maxW = Math.max(10, Math.round(avg * 1.4));
  const minBottom = bh - Math.max(5, Math.round(avg * 0.6));
  const numberXs = [];

  for (const c of comps) {
    const w = c.maxx - c.minx + 1;
    const h = c.maxy - c.miny + 1;

    // 小节号：很小、靠近六线谱顶部、略高于谱线
    if (
      h >= 3 &&
      h <= maxH &&
      w >= 1 &&
      w <= maxW &&
      c.area >= 4 &&
      c.maxy >= minBottom
    ) {
      numberXs.push((c.minx + c.maxx) / 2);
    }
  }

  numberXs.sort((a, b) => a - b);

  const clusters = [];
  for (const x of numberXs) {
    if (clusters.length && x - clusters[clusters.length - 1][clusters[clusters.length - 1].length - 1] <= 6) {
      clusters[clusters.length - 1].push(x);
    } else {
      clusters.push([x]);
    }
  }

  const numbers = clusters.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
  const marks = [];

  for (const nx of numbers) {
    let best = null;
    let bestD = Infinity;

    for (const v of vlines) {
      const d = Math.abs(v - nx);
      if (d < bestD && d <= avg * 3.5) {
        bestD = d;
        best = v;
      }
    }

    // 只有“数字附近真的有竖线”才算小节线；
    // 没有竖线的数字（三连音 3、T.Harm.12/19 等）直接丢弃。
    if (best !== null) marks.push(best);
  }

  const sorted = marks
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b)
    .filter((v, idx, arr) => idx === 0 || v - arr[idx - 1] > 8);

  if (!sorted.length) return [];

  const last = sorted[sorted.length - 1];
  const rightCandidates = vlines.filter((v) => v > last + avg * 0.5);
  const right = rightCandidates.length ? Math.max(...rightCandidates) : aw - 1;
  if (right > last + avg * 0.5) sorted.push(right);

  const left = vlines.length ? Math.min(...vlines) : 0;
  if (sorted[0] > left + avg * 2) sorted.unshift(left);

  return sorted;
}

function detectSystems(source) {
  const aw = ANALYSIS_W;
  const ah = Math.max(1, Math.round(source.natH * aw / source.natW));

  const canvas = document.createElement('canvas');
  canvas.width = aw;
  canvas.height = ah;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, aw, ah);
  ctx.drawImage(source.src, 0, 0, aw, ah);

  const data = ctx.getImageData(0, 0, aw, ah).data;
  const rowRatio = new Float32Array(ah);
  const darkMap = new Uint8Array(aw * ah);

  for (let y = 0; y < ah; y++) {
    let dark = 0;
    const off = y * aw * 4;
    for (let x = 0; x < aw; x++) {
      const i = off + x * 4;
      const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (g < 225) {
        dark++;
        darkMap[y * aw + x] = 1;
      }
    }
    rowRatio[y] = dark / aw;
  }

  const centers = [];
  let run = [];

  for (let y = 0; y < ah; y++) {
    if (rowRatio[y] > 0.45) {
      run.push(y);
    } else if (run.length) {
      centers.push(run.reduce((a, b) => a + b, 0) / run.length);
      run = [];
    }
  }
  if (run.length) {
    centers.push(run.reduce((a, b) => a + b, 0) / run.length);
  }

  const filtered = centers.filter((y) => y > 10);
  const systems = [];
  const factor = source.natW / aw;
  let i = 0;

  while (i <= filtered.length - 6) {
    const c = filtered.slice(i, i + 6);
    const gaps = [];
    for (let j = 0; j < 5; j++) gaps.push(c[j + 1] - c[j]);
    const min = Math.min(...gaps);
    const max = Math.max(...gaps);

    if (min > 3 && max < 35 && max / min < 1.7) {
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const pad = avg * 2.7;
      const y0 = Math.max(0, c[0] - pad);
      const y1 = Math.min(ah, c[5] + pad);

      /* 小节线：贯穿 6 条弦，并且有一定粗细（排除音符符干） */
      const bandTop = Math.max(0, Math.round(c[0]));
      const bandBot = Math.min(ah, Math.round(c[5] + 1));
      const bandH = Math.max(1, bandBot - bandTop);
      const barCols = [];

      for (let x = 0; x < aw; x++) {
        let db = 0;
        for (let y = bandTop; y < bandBot; y++) db += darkMap[y * aw + x];
        if (db / bandH > 0.85) barCols.push(x);
      }

      const groups = [];
      let cur = [];
      for (const x of barCols) {
        if (cur.length && x - cur[cur.length - 1] <= 2) cur.push(x);
        else {
          if (cur.length) groups.push(cur);
          cur = [x];
        }
      }
      if (cur.length) groups.push(cur);

      const vlines = groups
        .map((g) => g.reduce((a, b) => a + b, 0) / g.length)
        .filter((center) => {
          const x = Math.round(center);
          let up = 0;
          let y = bandTop - 1;
          while (y >= 0 && darkMap[y * aw + x]) { up++; y--; }

          let down = 0;
          y = bandBot;
          while (y < ah && darkMap[y * aw + x]) { down++; y++; }

          // 真小节线基本只在六线谱内；符干/泛音线通常上下延伸很长
          return up <= 3 && down <= 3;
        });

      const bars = findMeasureMarks(aw, darkMap, c[0], avg, vlines);

      systems.push({
        y0: y0 * factor,
        y1: y1 * factor,
        bars,
      });

      i += 6;
    } else {
      i++;
    }
  }

  return systems;
}

function buildStrip() {
  const targetH = 240;
  const gap = 0;

  const items = state.systems.map((entry) => {
    const cropH = Math.max(1, entry.system.y1 - entry.system.y0);
    const scale = targetH / cropH;
    const bars = entry.system.bars || [];
    const hasBars = bars.length >= 2;
    const factor = entry.source.natW / ANALYSIS_W;
    const ax0 = hasBars ? bars[0] : 0;
    const ax1 = hasBars ? bars[bars.length - 1] : ANALYSIS_W;
    const sx0 = ax0 * factor;
    const cropW = Math.max(1, (ax1 - ax0) * factor);

    return {
      ...entry,
      cropH,
      scale,
      bars,
      factor,
      sx0,
      cropW,
      hasBars,
      drawW: cropW * scale,
    };
  });

  const totalW = Math.ceil(items.reduce((s, it) => s + it.drawW, 0) + gap * (items.length - 1));
  const canvas = document.createElement('canvas');
  canvas.width = totalW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, totalW, targetH);

  let x = 0;
  const marks = [];

  for (const it of items) {
    const src = it.source;
    ctx.drawImage(
      src.src,
      it.sx0,
      it.system.y0,
      it.cropW,
      it.cropH,
      x,
      0,
      it.drawW,
      targetH
    );

    if (it.hasBars) {
      for (const b of it.bars) {
        const sourceX = b * it.factor;
        marks.push(x + ((sourceX - it.sx0) / it.cropW) * it.drawW);
      }
    }

    x += it.drawW + gap;
  }

  state.marks = marks
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b)
    .filter((v, idx, arr) => idx === 0 || v - arr[idx - 1] > 8);

  if (state.autoBars && state.marks.length < 2) {
    state.autoBars = false;
  }

  state.stripCanvas = canvas;
  state.stripW = totalW;
  state.stripH = targetH;

  els.strip.width = totalW;
  els.strip.height = targetH;
  els.strip.style.width = `${totalW}px`;
  els.strip.style.height = `${targetH}px`;

  const visibleCtx = els.strip.getContext('2d', { alpha: false });
  visibleCtx.drawImage(canvas, 0, 0);

  els.view.hidden = false;
  els.empty.hidden = true;

  const useAuto = state.autoBars && state.marks.length >= 2;
  const measureCount = useAuto ? state.marks.length - 1 : Math.max(1, Math.round(totalW / state.measureWidth));
  els.info.textContent = `识别到 ${items.length} 行 · ${useAuto ? '自动检测小节线' : '固定宽度（可调）'} · 约 ${measureCount} 小节`;
  els.status.textContent = `共约 ${measureCount} 小节`;
  syncBarsUI();

  requestAnimationFrame(() => {
    state.measureIndex = 0;
    els.hscroll.scrollLeft = 0;
    applyFit();
    updateOverlay();
    updateStatus();
  });
}

function useMarks() {
  return state.autoBars && state.marks.length >= 2;
}

function syncBarsUI() {
  els.barsMode.textContent = state.autoBars ? '小节线：自动' : '小节线：固定';
  els.barsMode.classList.toggle('active', state.autoBars);
  els.barsMode.title = state.autoBars
    ? '当前：自动检测小节线（可能误检）'
    : '当前：固定每小节宽度，用滑块调整';
}

function measureMarks() {
  if (useMarks()) return state.marks;

  const total = state.stripW || els.strip.width || 0;
  const w = Math.max(40, state.measureWidth);
  if (total <= 0) return [];

  const arr = [];
  for (let x = 0; x < total - 1; x += w) arr.push(x);
  if (!arr.length) arr.push(0);
  if (arr[arr.length - 1] < total) arr.push(total);
  return arr;
}

function currentSpan() {
  const marks = measureMarks();
  const idx = clamp(state.measureIndex, 0, Math.max(0, marks.length - 2));
  const start = marks[idx] ?? 0;
  const end = marks[idx + 1] ?? (start + state.measureWidth);
  return { idx, start, end, width: Math.max(40, end - start) };
}

function hPadding() {
  return parseFloat(getComputedStyle(els.hscroll).paddingLeft) || 0;
}

function applyFit() {
  if (!state.stripCanvas) return;

  const marks = measureMarks();
  const total = Math.max(1, marks.length - 1);
  const naturalW = Math.max(1, (marks[marks.length - 1] ?? state.stripW) - (marks[0] ?? 0));
  const avg = naturalW / total;
  const viewW = els.hscroll.clientWidth;
  const pad = hPadding();
  const available = Math.max(180, viewW * 0.86 - pad);
  const fit = clamp(state.fitMeasures, 1, 6);
  const targetH = state.stripH || 240;

  let cssH = targetH * (available / fit) / Math.max(1, avg);
  cssH = clamp(cssH, 60, 360);

  els.strip.style.height = `${cssH}px`;
  els.strip.style.width = `${state.stripW * (cssH / targetH)}px`;
  state.range = null;

  updateOverlay();
}

function displayScale() {
  const targetH = state.stripH || 240;
  const h = els.strip.getBoundingClientRect().height || targetH;
  return h / targetH;
}

function prepareMeasure() {
  const span = currentSpan();
  const scale = displayScale();
  const pad = hPadding();
  const maxRight = Math.max(pad + 80, els.hscroll.clientWidth * 0.86);

  let startX = pad + span.start * scale - els.hscroll.scrollLeft;
  let endX = pad + span.end * scale - els.hscroll.scrollLeft;
  let reset = false;

  if (startX < pad - 2 || startX > maxRight || endX > maxRight) {
    els.hscroll.scrollLeft = Math.max(0, Math.min(span.start * scale, maxScroll()));
    startX = pad;
    endX = pad + span.width * scale;
    reset = true;
  }

  return { span, scale, pad, maxRight, startX, endX, reset };
}

function updateOverlay(leftOverride) {
  const rect = els.strip.getBoundingClientRect();
  const h = rect.height || 240;
  const span = currentSpan();
  const pad = hPadding();
  const scale = displayScale();
  const left = Number.isFinite(leftOverride)
    ? Math.max(0, leftOverride)
    : Math.max(0, pad + span.start * scale - els.hscroll.scrollLeft);
  const maxW = Math.max(40, els.overlay.clientWidth - left - 4);
  const w = clamp(span.width * scale, 40, maxW);

  els.overlay.style.setProperty('--band-h', `${h}px`);
  els.overlay.style.setProperty('--band-w', `${w}px`);
  els.overlay.style.setProperty('--band-left', `${left}px`);
}

/* ---------- 加载 ---------- */
async function loadFile(file) {
  if (!file) return;

  resetView();
  showLoading('正在读取文件…');

  try {
    const sources = [];

    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      const lib = await ensurePdf();
      const data = await file.arrayBuffer();
      const pdf = await lib.getDocument({ data }).promise;

      for (let n = 1; n <= pdf.numPages; n++) {
        els.loadingText.textContent = `正在解析 PDF… ${n}/${pdf.numPages}`;
        const page = await pdf.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 1800 / Math.max(1, base.width));
        const viewport = page.getViewport({ scale });
        const c = document.createElement('canvas');
        c.width = Math.ceil(viewport.width);
        c.height = Math.ceil(viewport.height);
        const ctx = c.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        sources.push({ src: c, natW: c.width, natH: c.height });
        await new Promise((r) => setTimeout(r, 0));
      }
    } else if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      await img.decode();
      sources.push({ src: img, natW: img.naturalWidth, natH: img.naturalHeight });
    } else {
      throw new Error('请选择图片或 PDF');
    }

    const systems = [];
    for (const source of sources) {
      els.loadingText.textContent = '正在识别六线谱行…';
      const found = detectSystems(source);
      for (const system of found) systems.push({ source, system });
      await new Promise((r) => setTimeout(r, 0));
    }

    if (!systems.length) {
      throw new Error('没有识别到六线谱行（6 条横线）。请换一张更清晰、只有六线谱的图片/PDF。');
    }

    state.sources = sources;
    state.systems = systems;

    showLoading('正在拼接单行谱…');
    buildStrip();
    toast(`已识别 ${systems.length} 行，拼成一整行`);
  } catch (err) {
    console.error(err);
    resetView();
    showError(`识别失败：${err?.message || err}`);
    toast(`识别失败：${err?.message || err}`, 5000);
  } finally {
    hideLoading();
  }
}

/* ---------- 播放：一小节一步 ---------- */
function measureDuration() {
  return state.beats * 60000 / state.bpm;
}

function maxScroll() {
  return Math.max(0, els.hscroll.scrollWidth - els.hscroll.clientWidth);
}

function updateStatus() {
  const marks = measureMarks();
  const total = Math.max(1, marks.length - 1);
  const current = clamp(state.measureIndex + 1, 1, total);
  els.status.textContent = `第 ${current} / 约 ${total} 小节`;
}

function start() {
  if (!state.stripCanvas) {
    toast('先打开一张吉他谱');
    return;
  }

  if (state.playing) {
    pause();
    return;
  }

  const total = Math.max(0, measureMarks().length - 1);
  if (total < 1) {
    toast('没有可用的小节');
    return;
  }

  if (state.measureIndex < 0 || state.measureIndex >= total) {
    state.measureIndex = 0;
  }

  const span = currentSpan();
  const scale = displayScale();
  els.hscroll.scrollLeft = Math.max(0, Math.min(span.start * scale, maxScroll()));

  state.playing = true;
  state.measureStart = performance.now();
  state.lineProgress = 0;
  state.range = prepareMeasure();
  state.lineX = state.range.startX;
  els.play.textContent = '❚❚';
  els.play.classList.add('playing');
  updateOverlay(state.lineX);
  updateStatus();
  state.raf = requestAnimationFrame(tick);
}

function pause() {
  state.playing = false;

  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = 0;
  }

  if (state.raf) {
    cancelAnimationFrame(state.raf);
    state.raf = 0;
  }

  els.play.textContent = '▶';
  els.play.classList.remove('playing');
}

function tick(now) {
  if (!state.playing) return;

  const marks = measureMarks();
  const total = marks.length - 1;
  if (total < 1) {
    pause();
    toast('没有可用的小节');
    return;
  }

  const duration = Math.max(200, measureDuration());

  if (now - state.measureStart >= duration) {
    state.measureStart += duration;
    state.measureIndex++;

    if (state.measureIndex >= total) {
      if (state.loop) {
        state.measureIndex = 0;
        els.hscroll.scrollLeft = 0;
        state.measureStart = now;
      } else {
        pause();
        toast('已到谱面末尾');
        return;
      }
    }

    state.range = prepareMeasure();
    if (state.range.reset) state.lineX = state.range.startX;
  }

  if (!state.range) state.range = prepareMeasure();

  state.lineProgress = clamp((now - state.measureStart) / duration, 0, 1);

  const range = state.range;
  const target = range.startX + state.lineProgress * (range.endX - range.startX);

  // 严格匀速：小节之间不重置速度，只有整组跳到下一段时才回到左边
  state.lineX = target;

  updateOverlay(state.lineX);
  updateStatus();
  state.raf = requestAnimationFrame(tick);
}

/* ---------- 事件 ---------- */
els.file.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) loadFile(file);
  e.target.value = '';
});

els.play.addEventListener('click', start);

els.bpm.addEventListener('input', () => {
  state.bpm = Number(els.bpm.value);
  els.bpmv.textContent = String(state.bpm);
});

els.mw.addEventListener('input', () => {
  pause();
  state.measureWidth = Number(els.mw.value);
  els.mwv.textContent = String(state.measureWidth);
  state.measureIndex = 0;
  els.hscroll.scrollLeft = 0;
  applyFit();
  updateOverlay();
  updateStatus();
});

els.beats.addEventListener('change', () => {
  state.beats = Number(els.beats.value);
});

els.fitMeasures.addEventListener('change', () => {
  pause();
  state.fitMeasures = Number(els.fitMeasures.value);
  state.measureIndex = 0;
  els.hscroll.scrollLeft = 0;
  applyFit();
  updateOverlay();
  updateStatus();
});

els.barsMode.addEventListener('click', () => {
  const next = !state.autoBars;

  if (next && state.marks.length < 2) {
    state.autoBars = false;
    syncBarsUI();
    toast('没有可靠的小节线，继续用固定宽度');
    return;
  }

  pause();
  state.autoBars = next;
  syncBarsUI();
  state.measureIndex = 0;
  els.hscroll.scrollLeft = 0;

  if (state.stripCanvas) {
    const auto = useMarks();
    const contentW = els.strip.getBoundingClientRect().width || state.stripW;
    const count = auto
      ? Math.max(1, state.marks.length - 1)
      : Math.max(1, Math.round(contentW / state.measureWidth));
    els.info.textContent = `小节线：${auto ? '自动（数字+竖线）' : '固定宽度（可调）'} · 约 ${count} 小节`;
  }

  applyFit();
  updateOverlay();
  updateStatus();
  toast(state.autoBars ? '小节线：自动检测（可能误检）' : '小节线：固定宽度，用滑块调整');
});

els.loop.addEventListener('click', () => {
  state.loop = !state.loop;
  els.loop.classList.toggle('active', state.loop);
});

els.fs.addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch {
    toast('当前浏览器不支持全屏');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    if (e.target?.tagName === 'BUTTON') return;
    e.preventDefault();
    start();
  }
});

window.addEventListener('resize', () => {
  if (state.stripCanvas) applyFit();
});

const stage = $('stage');

['dragenter', 'dragover'].forEach((name) => {
  stage.addEventListener(name, (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
});

stage.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

window.addEventListener('error', (e) => {
  if (e.message) toast(`页面错误：${e.message}`, 5000);
});

syncBarsUI();
updateOverlay();
