// Fingerabdruck eines Kartenbilds: kleines Farbraster vom Bild-Bereich (Artwork) der Karte,
// je Farbkanal normalisiert, damit Licht und Schatten auf dem Foto weniger stören.
// Wird von der App (Scan) und von build-index.html (Datenbank bauen) gleich berechnet.
const FP_W = 16, FP_H = 12, FP_LEN = FP_W * FP_H * 3;

function fingerprint(src) {
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  const c = document.createElement("canvas");
  c.width = FP_W;
  c.height = FP_H;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, w * 0.08, h * 0.11, w * 0.84, h * 0.36, 0, 0, FP_W, FP_H);
  const d = ctx.getImageData(0, 0, FP_W, FP_H).data;
  const v = new Float32Array(FP_LEN);
  let k = 0;
  for (let ch = 0; ch < 3; ch++) {
    let mean = 0, sq = 0;
    for (let i = ch; i < d.length; i += 4) mean += d[i];
    mean /= FP_W * FP_H;
    for (let i = ch; i < d.length; i += 4) sq += (d[i] - mean) ** 2;
    const sd = Math.sqrt(sq / (FP_W * FP_H)) || 1;
    for (let i = ch; i < d.length; i += 4) v[k++] = (d[i] - mean) / sd;
  }
  return v;
}

// Ähnlichkeit zweier Fingerabdrücke: -1 (gegensätzlich) bis 1 (gleich)
function fpSimilarity(a, b) {
  let s = 0;
  for (let i = 0; i < FP_LEN; i++) s += a[i] * b[i];
  return s / FP_LEN;
}

// Für die Datenbank platzsparend als ganze Zahlen (-127..127) speichern
function fpToInt8(v) {
  const out = new Int8Array(FP_LEN);
  for (let i = 0; i < FP_LEN; i++) out[i] = Math.max(-127, Math.min(127, Math.round(v[i] * 32)));
  return out;
}
