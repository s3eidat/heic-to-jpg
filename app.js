/* HEIC to JPG — HEIC is decoded by libheif (WebAssembly) in heic-worker.js, then re-encoded with <canvas>. Nothing is uploaded. */
(function () {
  "use strict";
  const $ = S3.$, $$ = S3.$$;
  const MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
  const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const saved = S3.store("heic") || {};
  const opts = { format: MIME[saved.format] ? saved.format : "jpeg", quality: saved.quality || 90, max: saved.max || "" };
  let items = [], run = 0, queue = Promise.resolve(), selected = null, nextId = 1;

  // ---------- decoder worker ----------
  let worker = null, wid = 0;
  const pending = new Map();
  function getWorker() {
    if (worker) return worker;
    worker = new Worker("heic-worker.js");
    worker.onmessage = e => {
      const p = pending.get(e.data.id); if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data);
    };
    worker.onerror = e => {
      e.preventDefault();
      const msg = "The HEIC decoder stopped" + (e.message ? ": " + e.message : "") + ". Try a smaller batch or reload the page.";
      pending.forEach(p => p.reject(new Error(msg))); pending.clear();
      worker.terminate(); worker = null; // a fresh worker is started for the next file
    };
    return worker;
  }
  // bytes (ArrayBuffer) -> {w, h, count, rgba: ArrayBuffer}
  function decodeHeic(buf) {
    return new Promise((resolve, reject) => {
      const id = ++wid;
      pending.set(id, { resolve, reject });
      getWorker().postMessage({ id, buf }, [buf]);
    });
  }

  // ---------- pipeline ----------
  function canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
  function fitSize(w, h, max) {
    const s = max && Math.max(w, h) > max ? max / Math.max(w, h) : 1;
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }
  function resample(src, sw, sh, tw, th, bg) {
    let cur = src, cw = sw, ch = sh;
    while (cw / 2 >= tw && ch / 2 >= th) {
      const c = canvas(Math.round(cw / 2), Math.round(ch / 2)), x = c.getContext("2d");
      x.imageSmoothingQuality = "high"; x.drawImage(cur, 0, 0, c.width, c.height);
      cur = c; cw = c.width; ch = c.height;
    }
    const out = canvas(tw, th), x = out.getContext("2d");
    if (bg) { x.fillStyle = bg; x.fillRect(0, 0, tw, th); }
    x.imageSmoothingQuality = "high"; x.drawImage(cur, 0, 0, tw, th);
    return out;
  }
  function toBlob(c, type, q) {
    return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error("The browser could not encode this image (too large?)")), type, q));
  }
  function canEncode(type) { return new Promise(res => canvas(2, 2).toBlob(b => res(!!b && b.type === type), type, 0.5)); }
  // decoded pixels -> encoded Blob
  async function encode(dec, o) {
    const type = MIME[o.format], src = canvas(dec.w, dec.h);
    src.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(dec.rgba), dec.w, dec.h), 0, 0);
    const f = fitSize(dec.w, dec.h, +o.max || 0);
    const c = type === "image/jpeg" || f.w !== dec.w ? resample(src, dec.w, dec.h, f.w, f.h, type === "image/jpeg" ? "#ffffff" : null) : src;
    const blob = await toBlob(c, type, o.quality / 100);
    if (blob.type !== type) throw new Error("This browser can't write " + EXT[type].toUpperCase());
    return { blob, type, w: f.w, h: f.h };
  }
  async function convert(file, o) {
    const dec = await decodeHeic(await file.arrayBuffer());
    const r = await encode(dec, o);
    r.count = dec.count; r.srcW = dec.w; r.srcH = dec.h;
    return r;
  }
  function outName(name, type) { return (name.replace(/\.(heic|heif|hif)$/i, "") || "photo") + "." + EXT[type]; }
  function isHeic(f) { return /\.(heic|heif|hif)$/i.test(f.name) || /^image\/hei[cf]/.test(f.type); }

  // ---------- UI ----------
  const list = $("#list");
  function seg(el, value, onPick) {
    $$("button", el).forEach(b => {
      b.setAttribute("aria-pressed", String(b.dataset.v === value));
      b.addEventListener("click", () => { $$("button", el).forEach(x => x.setAttribute("aria-pressed", String(x === b))); onPick(b.dataset.v); });
    });
  }
  function save() { S3.store("heic", opts); }

  function addFiles(files) {
    const ok = files.filter(isHeic), skipped = files.length - ok.length;
    if (skipped) S3.toast(skipped + (skipped === 1 ? " file is" : " files are") + " not HEIC/HEIF and " + (skipped === 1 ? "was" : "were") + " skipped", "error");
    if (!ok.length) return Promise.resolve();
    const fresh = ok.map(f => ({ id: nextId++, file: f }));
    items = items.concat(fresh);
    fresh.forEach(it => { it.el = S3.h("li", { "class": "hk-item", tabindex: "0" }); list.appendChild(it.el); renderItem(it); });
    refresh();
    return Promise.all(fresh.map(it => enqueue(it, run))).then(() => { if (fresh.some(it => it.res)) S3.done(); });
  }
  function enqueue(it, myRun) { queue = queue.then(() => processItem(it, myRun)); return queue; }
  async function processItem(it, myRun) {
    if (myRun !== run || items.indexOf(it) < 0 || it.bad) return;
    it.busy = true; renderItem(it); refresh();
    try {
      const r = await convert(it.file, opts);
      if (myRun !== run || items.indexOf(it) < 0) return;
      if (it.res) URL.revokeObjectURL(it.res.url);
      r.url = URL.createObjectURL(r.blob); it.res = r; it.err = null;
      if (!selected) select(it); else if (selected === it) showPreview();
    } catch (e) {
      it.err = e.message || "Failed"; it.bad = true;
    } finally { it.busy = false; renderItem(it); refresh(); }
  }
  function reprocess() {
    save(); run++;
    const my = run;
    items.forEach(it => { if (!it.bad) { it.busy = true; renderItem(it); } });
    refresh();
    return Promise.all(items.map(it => enqueue(it, my))).then(() => { if (items.some(it => it.res)) S3.done(); });
  }

  function renderItem(it) {
    const r = it.res, f = it.file, el = it.el;
    el.classList.toggle("is-sel", it === selected);
    let meta, chip;
    if (it.err) {
      meta = '<span class="hk-err">' + S3.esc(it.err) + "</span>"; chip = '<span class="chip bad">Error</span>';
    } else if (it.busy || !r) {
      meta = '<span class="faint">' + S3.fmtBytes(f.size) + " · converting…</span>"; chip = '<span class="chip"><span class="hk-spin"></span></span>';
    } else {
      meta = '<span class="faint">' + (r.srcW === r.w ? r.w + "×" + r.h : r.srcW + "×" + r.srcH + " → " + r.w + "×" + r.h) + " · " +
        S3.fmtBytes(f.size) + " → " + S3.fmtBytes(r.blob.size) + "</span>" +
        (r.count > 1 ? '<span class="hk-more">File holds ' + r.count + " images; the main one was converted</span>" : "");
      chip = '<span class="chip ok">' + EXT[r.type].toUpperCase() + "</span>";
    }
    el.innerHTML = (r && !it.busy ? '<img class="hk-thumb" alt="" src="' + r.url + '">' : '<span class="hk-thumb"></span>') +
      '<div class="hk-info"><b title="' + S3.esc(f.name) + '">' + S3.esc(f.name) + "</b>" + meta + "</div>" + chip +
      '<button class="btn small icon" data-dl aria-label="Download ' + S3.esc(f.name) + '"' + (r && !it.busy && !it.err ? "" : " disabled") + '><svg class="i"><use href="#i-download"/></svg></button>' +
      '<button class="btn ghost small icon" data-rm aria-label="Remove ' + S3.esc(f.name) + '"><svg class="i"><use href="#i-x"/></svg></button>';
  }
  function refresh() {
    const done = items.filter(it => it.res && !it.err && !it.busy), fin = items.filter(it => !it.busy && (it.res || it.err)).length;
    $("#empty").hidden = items.length > 0;
    $("#count").textContent = items.length ? fin + " of " + items.length + " done" : "";
    $("#zip").disabled = !done.length; $("#clear").disabled = !items.length;
    const busy = items.some(it => it.busy);
    $("#prog").hidden = !busy;
    $("#progBar").style.width = (items.length ? Math.round(fin / items.length * 100) : 0) + "%";
    $("#viewer").hidden = !selected || !selected.res;
  }
  function select(it) {
    const old = selected; selected = it;
    if (old && old.el) renderItem(old);
    if (it) { renderItem(it); showPreview(); }
    refresh();
  }
  function showPreview() {
    if (!selected || !selected.res) return;
    const r = selected.res;
    $("#preview").src = r.url;
    $("#cap").textContent = outName(selected.file.name, r.type) + " · " + r.w + "×" + r.h + " · " + S3.fmtBytes(r.blob.size);
  }
  function remove(it) {
    items = items.filter(x => x !== it); it.el.remove();
    if (it.res) URL.revokeObjectURL(it.res.url);
    if (selected === it) { selected = null; select(items.filter(x => x.res)[0] || null); }
    refresh();
  }

  list.addEventListener("click", e => {
    const li = e.target.closest(".hk-item"); if (!li) return;
    const it = items.filter(x => x.el === li)[0]; if (!it) return;
    if (e.target.closest("[data-rm]")) return remove(it);
    if (e.target.closest("[data-dl]")) { S3.download(it.res.blob, outName(it.file.name, it.res.type)); S3.done(); return; }
    if (it.res && !it.err) select(it);
  });
  list.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("hk-item")) { e.preventDefault(); e.target.click(); } });

  S3.drop($("#drop"), addFiles, { multiple: true });

  const q = $("#quality"), qv = $("#qv"), redo = S3.debounce(reprocess, 350);
  function syncQuality() { $("#qfield").classList.toggle("hk-off", opts.format === "png"); q.disabled = opts.format === "png"; }
  q.value = opts.quality; qv.textContent = opts.quality + "%";
  q.addEventListener("input", () => { opts.quality = +q.value; qv.textContent = q.value + "%"; redo(); });
  $("#max").value = opts.max;
  $("#max").addEventListener("change", e => { opts.max = e.target.value; reprocess(); });
  $("#clear").addEventListener("click", () => { items.slice().forEach(remove); run++; });
  $("#zip").addEventListener("click", async () => {
    const used = {}, files = [];
    for (const it of items) {
      if (!it.res || it.err || it.busy) continue;
      let n = outName(it.file.name, it.res.type);
      while (used[n.toLowerCase()]) n = n.replace(/(\.[^.]+)$/, "-" + (used[n.toLowerCase()]++) + "$1");
      used[n.toLowerCase()] = 1;
      files.push({ name: n, data: new Uint8Array(await it.res.blob.arrayBuffer()) });
    }
    S3.download(S3.zip(files), "converted-photos.zip"); S3.done();
  });

  const ready = canEncode("image/webp").then(ok => {
    $("#format [data-v=webp]").hidden = !ok;
    if (!ok && opts.format === "webp") opts.format = "jpeg";
    seg($("#format"), opts.format, v => { opts.format = v; syncQuality(); reprocess(); });
    syncQuality();
  });

  // ---------- samples (generated pictures encoded as HEIC, see sample.js) ----------
  function b64(s) { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function sampleFile(key, name) { return new File([b64(window.HEIC_SAMPLES[key])], name, { type: "image/heic" }); }

  window.S3_DEMO = async function () {
    await ready;
    await addFiles([sampleFile("demo1", "IMG_4021.HEIC"), sampleFile("demo2", "IMG_4022.HEIC"), sampleFile("demo3", "IMG_4025.HEIC")]);
  };

  // Self-test run by scripts/smoke.py: a real HEIC (two images: 64x48 colour blocks as primary + 32x32) through libheif.
  window.S3_SELFTEST = async function () {
    await ready;
    const near = (p, c, tol) => Math.abs(p[0] - c[0]) <= tol && Math.abs(p[1] - c[1]) <= tol && Math.abs(p[2] - c[2]) <= tol;
    const COLS = [[220, 40, 40], [40, 180, 60], [40, 60, 220], [240, 200, 40]], PTS = [[10, 10], [50, 10], [10, 38], [50, 38]];
    // 1) decode: dimensions, image count, primary chosen, pixel colours
    const dec = await decodeHeic(b64(window.HEIC_SAMPLES.test).buffer);
    const px = new Uint8ClampedArray(dec.rgba.slice(0)), at = (x, y) => px.subarray((y * dec.w + x) * 4, (y * dec.w + x) * 4 + 4);
    const ok1 = dec.w === 64 && dec.h === 48 && dec.count === 2 && PTS.every((p, i) => near(at(p[0], p[1]), COLS[i], 12) && at(p[0], p[1])[3] === 255);
    // 2) full pipeline to JPEG: real JPEG bytes, decodes back with the right size and colours
    const jr = await convert(sampleFile("test", "t.HEIC"), { format: "jpeg", quality: 92, max: "" });
    const jb = new Uint8Array(await jr.blob.arrayBuffer());
    const img = new Image(), url = URL.createObjectURL(jr.blob); img.src = url; await img.decode(); URL.revokeObjectURL(url);
    const c = canvas(img.naturalWidth, img.naturalHeight), x = c.getContext("2d"); x.drawImage(img, 0, 0);
    const ok2 = jb[0] === 0xFF && jb[1] === 0xD8 && jr.count === 2 && img.naturalWidth === 64 && img.naturalHeight === 48 &&
      PTS.every((p, i) => near(x.getImageData(p[0], p[1], 1, 1).data, COLS[i], 24));
    // 3) PNG + resize, damaged input is rejected, names
    const pr = await convert(sampleFile("test", "t.heic"), { format: "png", quality: 90, max: 32 });
    const pb = new Uint8Array(await pr.blob.arrayBuffer());
    let rejected = false;
    try { await decodeHeic(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99, 1, 2, 3, 4]).buffer); } catch (e) { rejected = true; }
    const ok3 = pb[1] === 0x50 && pb[2] === 0x4E && pr.w === 32 && pr.h === 24 && rejected &&
      outName("IMG_0001.HEIC", "image/jpeg") === "IMG_0001.jpg" && outName("a.b.heif", "image/webp") === "a.b.webp";
    return (ok1 && ok2 && ok3) || { ok1, ok2, ok3, dec: [dec.w, dec.h, dec.count, [].slice.call(at(10, 10))], jpg: [img.naturalWidth, img.naturalHeight], png: [pr.w, pr.h], rejected };
  };
})();
