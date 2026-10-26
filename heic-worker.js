/* HEIC to JPG: decoder worker. libheif (WebAssembly, LGPL, unmodified) runs here so the page stays responsive.
   It only receives file bytes from the page and returns pixels. No network. */
"use strict";
importScripts("lib/libheif-bundle.js");

var heif = null;
function mod() {
  if (!heif) {
    // The bundle carries its own wasm binary and compiles it synchronously, so the module is ready on return.
    heif = libheif();
    if (!heif || typeof heif.HeifDecoder !== "function") { heif = null; throw new Error("The HEIC decoder failed to start"); }
  }
  return heif;
}

function isPrimary(m, img) {
  try { return !!m.heif_image_handle_is_primary_image(img.handle); } catch (e) { return false; }
}

function decode(buf) {
  var m = mod(), dec = new m.HeifDecoder(), imgs = dec.decode(new Uint8Array(buf));
  try {
    if (!imgs.length) throw new Error("Not a HEIC/HEIF image, or the file is damaged");
    var prim = imgs.filter(function (i) { return isPrimary(m, i); })[0] || imgs[0];
    // libheif applies the file's rotation/mirror (irot/imir) here, so the pixels come out upright.
    var r = m.heif_js_decode_image2(prim.handle, m.heif_colorspace.heif_colorspace_RGB, m.heif_chroma.heif_chroma_interleaved_RGBA);
    if (!r || r.code) throw new Error("Could not decode this image" + (r && r.message ? " (" + r.message + ")" : ""));
    try {
      var ch = r.channels.filter(function (c) { return c.id == m.heif_channel.heif_channel_interleaved; })[0] || r.channels[0];
      var w = ch.width, h = ch.height, row = w * 4, out = new Uint8ClampedArray(row * h);
      if (ch.stride === row) out.set(ch.data.subarray(0, row * h));
      else for (var y = 0; y < h; y++) out.set(ch.data.subarray(y * ch.stride, y * ch.stride + row), y * row);
      return { w: w, h: h, count: imgs.length, rgba: out.buffer };
    } finally { m.heif_image_release(r.image); }
  } finally {
    imgs.forEach(function (i) { i.free(); });
    if (dec.decoder) { m.heif_context_free(dec.decoder); dec.decoder = null; }
  }
}

self.onmessage = function (e) {
  var id = e.data.id;
  try {
    var r = decode(e.data.buf);
    r.id = id;
    self.postMessage(r, [r.rgba]);
  } catch (err) {
    self.postMessage({ id: id, error: String((err && err.message) || err) });
  }
};
