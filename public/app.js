// Karten-Scanner: Foto -> Texterkennung -> Karte finden -> Preise von Cardmarket und eBay
const TCGDEX = "https://api.tcgdex.net/v2";
// Läuft die App über server.py auf dem Mac? Nur dann gibt es eBay-Preise (/api/ebay) und das
// Speichern von Scans (/api/scan). Online (pokemon.3dfilips.lu) ist sie eine reine Webseite.
const ON_MAC = /^(localhost|127\.0\.0\.1|192\.168\.|10\.)|\.local$/.test(location.hostname);
// Der Bilder-Server von TCGdex schickt manchmal "Access-Control-Allow-Origin: *, *", dann blockiert
// der Browser das Laden per fetch. Online holt Vercel die Bilder deshalb selbst ab (vercel.json).
const imageFetchUrl = (url) => (ON_MAC ? url : url.replace("https://assets.tcgdex.net/", "/tcgdex-img/"));

const $ = (sel) => document.querySelector(sel);
const els = {
  photo: $("#photo"),
  form: $("#searchForm"),
  input: $("#searchInput"),
  status: $("#status"),
  preview: $("#preview"),
  candidates: $("#candidates"),
  result: $("#result"),
  modeHint: $("#modeHint"),
};

const MODE_HINTS = {
  value: "Zeigt dir den billigsten Preis auf Cardmarket und eBay.",
  buy: "Zeigt dir die billigsten Angebote mit Link zum Kaufen.",
};

let mode = "value";
try { mode = localStorage.getItem("mode") || "value"; } catch {}
let current = null; // { card, enCard, ebay } der zuletzt angezeigten Karte

// ---------- Modus ----------
function setMode(m) {
  mode = m;
  try { localStorage.setItem("mode", m); } catch {}
  document.querySelectorAll(".mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  els.modeHint.textContent = MODE_HINTS[m];
  if (current) renderResult();
}
document.querySelectorAll(".mode").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
setMode(mode);

// ---------- Hilfsfunktionen ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const euro = (n) => (n == null || isNaN(n) ? "–" : n.toLocaleString("de-DE", { style: "currency", currency: "EUR" }));
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
const stripZeros = (n) => String(n).replace(/^0+(?=\d)/, "");

function showStatus(html, isError = false) {
  els.status.hidden = false;
  els.status.className = "status" + (isError ? " error" : "");
  els.status.innerHTML = html;
}
const busy = (text) => showStatus(`<span class="spinner"></span>${esc(text)}`);
const hideStatus = () => { els.status.hidden = true; };

function resetViews() {
  $("#cropper").hidden = true;
  els.candidates.hidden = true;
  els.result.hidden = true;
  current = null;
}

async function getJSON(url, retries = 2) {
  const r = await fetch(url);
  // Bei Überlastung (429/503) kurz warten und nochmal versuchen
  if ((r.status === 429 || r.status >= 500) && retries > 0) {
    await new Promise((res) => setTimeout(res, 1200));
    return getJSON(url, retries - 1);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const tryJSON = (url) => getJSON(url).catch(() => null);

// Ähnlichkeit zweier Namen (0..1), für das Sortieren der Treffer
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}
// Wie similarity, aber ohne "Teilwort passt" – für unsichere Texterkennung
function strictSimilarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}
function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

// ---------- Sets (für die Suche über die Kartennummer) ----------
let setsPromise = null;
function getSets() {
  if (!setsPromise) {
    setsPromise = Promise.all([tryJSON(`${TCGDEX}/de/sets`), tryJSON(`${TCGDEX}/en/sets`)]).then(([de, en]) => {
      const byId = new Map();
      for (const s of [...(en || []), ...(de || [])]) byId.set(s.id, { ...byId.get(s.id), ...s });
      return [...byId.values()];
    });
  }
  return setsPromise;
}

// ---------- Texterkennung ----------
let workerPromise = null;
function getWorker() {
  if (!workerPromise) workerPromise = Tesseract.createWorker(["deu", "eng", "fra"]);
  return workerPromise;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Bild konnte nicht geladen werden"));
    img.src = URL.createObjectURL(file);
  });
}

// Schneidet einen Streifen aus dem Bild, vergrößert ihn und macht ihn kontrastreich (graustufen)
function crop(img, y0, y1, scale = 1) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const base = (1400 / w) * scale; // immer auf ~1400px Breite bringen (kleine Bilder werden vergrößert)
  const c = document.createElement("canvas");
  c.width = Math.round(w * base);
  c.height = Math.round(h * (y1 - y0) * base);
  const ctx = c.getContext("2d");
  ctx.filter = "grayscale(1) contrast(1.6)";
  ctx.drawImage(img, 0, h * y0, w, h * (y1 - y0), 0, 0, c.width, c.height);
  return c;
}

const NUMBER_RE = /(\d{1,3})\s*[\/|]\s*(\d{2,3})/;
const NAME_STOPWORDS = new Set(["basis", "basic", "phase", "stage", "kp", "hp", "pv", "entwickelt", "evolves", "aus", "from", "trainer", "item", "unterstutzer", "supporter", "pokemon", "energie", "energy", "ex", "gx", "vmax", "vstar", "lv", "niveau", "base", "stade", "evolution", "basique"]);

// Findet "025/165" im Text. Mit validTotals (Setgrößen, die es wirklich gibt) werden auch
// typische Lesefehler korrigiert, z.B. "O25/l65" -> 025/165
const LOOSE_NUMBER_RE = /([\dOoIlSB]{1,3})\s*[\/|]\s*([\dOoIlSB]{2,3})/g;
const fixDigits = (s) => s.replace(/[Oo]/g, "0").replace(/[Il]/g, "1").replace(/S/g, "5").replace(/B/g, "8");
function parseNumber(text, validTotals) {
  if (!validTotals) {
    const m = text.match(NUMBER_RE);
    return m ? { num: stripZeros(m[1]), total: stripZeros(m[2]) } : null;
  }
  for (const m of text.matchAll(LOOSE_NUMBER_RE)) {
    if (!/\d/.test(m[1]) || !/\d/.test(m[2])) continue;
    const num = stripZeros(fixDigits(m[1])), total = stripZeros(fixDigits(m[2]));
    if (!/^\d+$/.test(num + total) || !validTotals.has(total)) continue;
    if (Number(num) > Number(total) + 150) continue; // Secret Rares liegen etwas über der Setgröße
    return { num, total };
  }
  return null;
}

// Alle plausiblen Nummern aus mehreren Lese-Versuchen. Die Setgröße (hinter dem /) wird meist richtig
// gelesen, die Kartennummer davor öfter falsch – deshalb mehrere Kandidaten sammeln.
function parseNumbers(texts, validTotals) {
  const out = [];
  const add = (a, b) => {
    if (!/\d/.test(a) || !/\d/.test(b)) return;
    const num = stripZeros(fixDigits(a)), total = stripZeros(fixDigits(b));
    if (!/^\d+$/.test(num + total) || !validTotals.has(total)) return;
    if (Number(num) > Number(total) + 150) return;
    if (Number(total) < 20) return; // Mini-Sets sind selten, "12/6" ist fast immer ein Lesefehler
    if (!out.some((n) => n.num === num && n.total === total)) out.push({ num, total });
  };
  for (const t of texts) {
    for (const m of t.matchAll(LOOSE_NUMBER_RE)) add(m[1], m[2]);
    for (const m of t.matchAll(/(\d{3})7(\d{3})/g)) add(m[1], m[2]); // schräger "/" als 7 gelesen: 0127086
  }
  return out;
}

// Ausschnitt aus der geraden Karte (Anteile von Breite/Höhe), vergrößert und in Graustufen.
// Mit dark (0–255) bleiben nur fast schwarze Pixel übrig: so verschwindet Glitzerfolie
// hinter schwarzer Schrift.
function region(card, x0, x1, y0, y1, scale, dark = 0) {
  const out = document.createElement("canvas");
  const sw = card.width * (x1 - x0), sh = card.height * (y1 - y0);
  out.width = Math.round(sw * scale);
  out.height = Math.round(sh * scale);
  const ctx = out.getContext("2d");
  if (!dark) ctx.filter = "grayscale(1) contrast(1.5)";
  ctx.drawImage(card, card.width * x0, card.height * y0, sw, sh, 0, 0, out.width, out.height);
  if (dark) {
    const img = ctx.getImageData(0, 0, out.width, out.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i + 1] = d[i + 2] = Math.max(d[i], d[i + 1], d[i + 2]) < dark ? 0 : 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  return out;
}

// Liest Name und Nummer von einer geraden, ausgeschnittenen Karte (aus detectCard).
// Weil die Karte gerade ist, liegen Name und Nummer immer an derselben Stelle.
async function readCard(card) {
  const worker = await getWorker();
  const validTotals = new Set((await getSets()).map((s) => String(s.cardCount?.official)));
  try {
    // Name: mehrere Varianten, weil er je nach Kartenart etwas anders sitzt (ältere Karten: "BASIS"
    // darüber) und Glitzerkarten nur mit "nur dunkle Pixel" lesbar sind. Alle gelesenen Namen
    // werden gesammelt und später nacheinander in der Datenbank geprüft.
    const namePasses = [
      ["6", 0.05, 0.65, 0.015, 0.11, 1, 0],
      ["7", 0.12, 0.6, 0.02, 0.085, 1, 0],
      ["7", 0.05, 0.65, 0.015, 0.11, 1, 90],
      ["6", 0.05, 0.45, 0.04, 0.14, 1.5, 90],
      ["7", 0.05, 0.45, 0.07, 0.13, 1.5, 90],
    ];
    const names = [];
    let nameText = "";
    for (const [psm, x0, x1, y0, y1, s, dark] of namePasses) {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const text = (await worker.recognize(region(card, x0, x1, y0, y1, s, dark))).data.text;
      nameText += "\n" + text;
      const n = parseName(text);
      if (n && !names.includes(n)) names.push(n);
    }
    await worker.setParameters({ tessedit_pageseg_mode: "7" }); // eine Zeile
    // neuere Karten: Nummer unten links, ältere: unten rechts. Je nach Ausschnitt sitzt sie etwas
    // höher oder tiefer – mehrere Zeilen probieren und aufhören, sobald eine Nummer gefunden ist.
    let numbers = [];
    search: for (const [x0, x1] of [[0.05, 0.45], [0.55, 1]]) {
      for (const [y0, y1, s] of [[0.93, 0.98, 2.5], [0.95, 1, 2.5], [0.93, 0.98, 4], [0.95, 1, 4], [0.935, 0.97, 2.5], [0.94, 0.99, 2.5], [0.92, 0.965, 2.5]]) {
        const text = (await worker.recognize(region(card, x0, x1, y0, y1, s))).data.text;
        numbers = parseNumbers([text], validTotals);
        if (numbers.length) break search;
      }
    }
    // Die Zeile "Entwickelt sich aus …" / "Évolution de …" nennt die Vorstufe – nicht mitnehmen
    const words = nameText.split("\n").filter((line) => !/[EÉ]v[aoe]l|volves|ntwick/i.test(line)).join(" ")
      .split(/[^A-Za-zÄÖÜäöüßéÉ\-]+/).filter((w) => w.length >= 3);
    return { name: names[0] || null, names, words, numbers, ...(numbers[0] || {}), fromScan: true };
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: "3" });
  }
}

function parseName(text) {
  const words = text.split(/[^A-Za-zÄÖÜäöüßéÉ'\-]+/).filter(Boolean);
  for (const w of words) {
    const clean = w.replace(/^[-']+|[-']+$/g, "");
    if (clean.length < 3) continue; // kurze Namen wie "Mew" zulassen
    if (NAME_STOPWORDS.has(norm(clean))) continue;
    if (!/^[A-ZÄÖÜ]/.test(clean)) continue; // Pokémon-Namen fangen groß an
    return clean;
  }
  return null;
}

// img ist der eingerahmte Kartenausschnitt (Canvas)
async function recognize(img) {
  busy("Texterkennung lädt …");
  els.preview.hidden = false;
  els.preview.innerHTML = `<img src="${img.toDataURL("image/jpeg", 0.85)}" alt="Deine Karte"><div class="ocr" id="ocrInfo"></div>`;

  const worker = await getWorker();
  const validTotals = new Set((await getSets()).map((s) => String(s.cardCount?.official)));
  busy("Lese Kartennamen und Nummer …");
  const top = await worker.recognize(crop(img, 0, 0.2, 2));
  // Die Nummer ist klein und sitzt je nach Rahmen unterschiedlich hoch:
  // von unten nach oben überlappende Streifen absuchen, bis eine gefunden wird
  let number = null;
  for (let y1 = 1; y1 >= 0.55 && !number; y1 -= 0.08) {
    busy(`Suche die Kartennummer … (${Math.round((1 - y1) / 0.08) + 1}/6)`);
    number = parseNumber((await worker.recognize(crop(img, Math.max(0, y1 - 0.16), y1, 2.5))).data.text, validTotals);
  }
  let name = parseName(top.data.text);
  let texts = [top.data.text];
  if (!number || !name) {
    // Falls der Rahmen nicht genau sitzt: die ganze Karte in hoher Auflösung lesen
    busy("Schaue mir die ganze Karte an …");
    const full = (await worker.recognize(crop(img, 0, 1, 2))).data.text;
    texts.push(full);
    number = number || parseNumber(full, validTotals);
    name = name || parseName(full);
  }
  const info = [name && `Name: ${name}`, number && `Nr.: ${number.num}/${number.total}`].filter(Boolean).join(" · ");
  $("#ocrInfo").textContent = info ? `Erkannt: ${info}` : "Nichts erkannt";
  // Alle gelesenen Wörter, um den Namen später mit den Treffern abzugleichen
  const words = texts.join(" ").split(/[^A-Za-zÄÖÜäöüßéÉ\-]+/).filter((w) => w.length >= 3);
  return { name, words, fromScan: true, ...(number || {}) };
}

// ---------- Karte im Foto einrahmen ----------
const CARD_RATIO = 63 / 88; // Breite / Höhe einer Pokémon-Karte
const cropEls = {
  box: $("#cropper"),
  stage: $("#cropStage"),
  canvas: $("#cropCanvas"),
  frame: $("#cropFrame"),
  size: $("#cropSize"),
  angle: $("#cropAngle"),
};
const cropState = { img: null, rot90: 0, cx: 0.5, cy: 0.5 }; // cx/cy: Rahmenmitte relativ zum Bild

function drawRotated() {
  const { img, rot90 } = cropState;
  const rad = ((rot90 * 90 + Number(cropEls.angle.value)) * Math.PI) / 180;
  const s = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = img.naturalWidth * s, h = img.naturalHeight * s;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const c = cropEls.canvas;
  c.width = Math.round(w * cos + h * sin);
  c.height = Math.round(w * sin + h * cos);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  placeFrame();
}

// Rahmen in Bildkoordinaten (Pixel auf dem Canvas)
function frameRect() {
  const c = cropEls.canvas;
  let fh = (Number(cropEls.size.value) / 100) * c.height;
  let fw = fh * CARD_RATIO;
  if (fw > c.width) { fw = c.width; fh = fw / CARD_RATIO; }
  const x = Math.min(Math.max(cropState.cx * c.width - fw / 2, 0), c.width - fw);
  const y = Math.min(Math.max(cropState.cy * c.height - fh / 2, 0), c.height - fh);
  return { x, y, w: fw, h: fh };
}

function placeFrame() {
  const c = cropEls.canvas;
  const k = c.clientWidth / c.width; // Bild-Pixel -> Bildschirm-Pixel
  const r = frameRect();
  Object.assign(cropEls.frame.style, {
    left: `${r.x * k}px`, top: `${r.y * k}px`, width: `${r.w * k}px`, height: `${r.h * k}px`,
  });
}

async function showCropper(img) {
  resetViews();
  els.preview.hidden = true;
  showStatus("Ich habe die Karte auf dem Foto nicht automatisch gefunden. Bitte rahme sie ein.");
  cropState.img = img;
  cropState.rot90 = 0;
  cropState.cx = cropState.cy = 0.5;
  cropEls.size.value = 80;
  cropEls.angle.value = 0;
  cropEls.box.hidden = false;
  drawRotated();
  cropEls.box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Tippen oder Ziehen auf dem Foto verschiebt den Rahmen dorthin
function moveFrameTo(e) {
  const rect = cropEls.canvas.getBoundingClientRect();
  cropState.cx = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
  cropState.cy = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1);
  placeFrame();
}
cropEls.stage.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  cropEls.stage.setPointerCapture(e.pointerId);
  moveFrameTo(e);
});
cropEls.stage.addEventListener("pointermove", (e) => {
  if (cropEls.stage.hasPointerCapture(e.pointerId)) moveFrameTo(e);
});
cropEls.size.addEventListener("input", placeFrame);
cropEls.angle.addEventListener("input", drawRotated);
$("#cropRotate").addEventListener("click", () => { cropState.rot90 = (cropState.rot90 + 1) % 4; drawRotated(); });
window.addEventListener("resize", () => { if (!cropEls.box.hidden) placeFrame(); });

// Foto und Ausschnitt im Ordner scans/ auf dem Mac ablegen (zum Verbessern der Erkennung)
function saveScan(photo, cut) {
  if (!ON_MAC) return;
  const id = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  for (const [kind, src] of [["foto", photo], ["ausschnitt", cut]]) {
    const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
    const s = Math.min(1, 2400 / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * s);
    canvas.height = Math.round(h * s);
    canvas.getContext("2d").drawImage(src, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      fetch(`/api/scan?id=${id}&kind=${kind}`, { method: "POST", body: blob }).catch(() => {});
    }, "image/jpeg", 0.9);
  }
}

$("#cropOk").addEventListener("click", async () => {
  // Etwas Rand dazunehmen, falls der Rahmen ein Stück der Karte abschneidet
  const f = frameRect(), c = cropEls.canvas;
  const mx = f.w * 0.08, my = f.h * 0.08;
  const x = Math.max(0, f.x - mx), y = Math.max(0, f.y - my);
  const r = { x, y, w: Math.min(c.width, f.x + f.w + mx) - x, h: Math.min(c.height, f.y + f.h + my) - y };
  const out = document.createElement("canvas");
  out.width = Math.round(r.w);
  out.height = Math.round(r.h);
  out.getContext("2d").drawImage(c, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
  saveScan(c, out);
  cropEls.box.hidden = true;
  try {
    // Im kleineren Ausschnitt findet die automatische Erkennung die Karte oft doch noch.
    // Sonst gilt der Rahmen selbst als Karte (du hast sie ja gerade eingerahmt).
    let card = await detectCard(out).catch(() => null);
    if (!card) {
      card = document.createElement("canvas");
      card.width = 800;
      card.height = Math.round(800 * 88 / 63);
      card.getContext("2d").drawImage(c, f.x, f.y, f.w, f.h, 0, 0, card.width, card.height);
    }
    let q = await readStraightCard(card);
    if (!q.name && !q.numbers.length) q = await recognize(out); // letzter Versuch: ganzen Ausschnitt lesen
    await lookup(q);
  } catch (e) {
    console.error(e);
    showStatus("Beim Scannen ist etwas schiefgelaufen: " + esc(e.message), true);
  }
});

// Gerade Karte lesen; liegt sie auf dem Kopf, das Ganze um 180° gedreht nochmal
async function readStraightCard(card) {
  busy("Lese Kartennamen und Nummer …");
  els.preview.hidden = false;
  els.preview.innerHTML = `<img src="${card.toDataURL("image/jpeg", 0.85)}" alt="Deine Karte"><div class="ocr" id="ocrInfo"></div>`;
  let q = await readCard(card);
  q.card = card;
  const found = (r) => r.numbers.length || r.name;
  // Nur übernehmen, wenn dabei wirklich Text gelesen wurde – sonst bleibt die ursprüngliche
  // Karte (für den Bildvergleich wäre eine falsch gedrehte Karte schlecht)
  if (!found(q)) {
    // Vielleicht wurde eine Hülle/ein Toploader ausgeschnitten: darin nochmal nach der Karte suchen
    const inner = await detectCard(card).catch(() => null);
    const r = inner && await readCard(inner);
    if (r && found(r)) q = { ...r, card: inner };
  }
  if (!found(q)) {
    busy("Drehe die Karte und lese nochmal …");
    const turned = rotate180(card);
    const r = await readCard(turned);
    if (found(r)) q = { ...r, card: turned };
  }
  const nums = q.numbers.map((n) => `${n.num}/${n.total}`).join(" oder ");
  const info = [q.name && `Name: ${q.name}`, nums && `Nr.: ${nums}`].filter(Boolean).join(" · ");
  $("#ocrInfo").textContent = info ? `Erkannt: ${info}` : "Nichts erkannt";
  els.input.value = [q.name, q.num && `${q.num}/${q.total}`].filter(Boolean).join(" ");
  return q;
}

// Wie gut passt ein Kartenname zur Suche? Bei Scans zählt das bestpassende gelesene Wort.
function nameScore(cardName, query) {
  const scores = [similarity(cardName, query.name)];
  for (const w of query.words || []) scores.push(similarity(cardName, w));
  return Math.max(...scores);
}

// ---------- Karte finden ----------
function parseQuery(q) {
  const number = parseNumber(q);
  const name = q.replace(NUMBER_RE, " ").replace(/\s+/g, " ").trim();
  let num = number?.num, total = number?.total;
  if (!number) {
    const lone = name.match(/(?:^|\s)#?(\d{1,3})$/); // "Pikachu 25"
    if (lone) num = stripZeros(lone[1]);
  }
  return { name: name.replace(/(?:^|\s)#?\d{1,3}$/, "").trim() || null, num, total };
}

// Karten nach Namen suchen – auf Deutsch, Englisch und Französisch (angezeigt wird der deutsche Name)
async function searchByName(terms) {
  const results = await Promise.all(terms.flatMap((t) => ["de", "en", "fr"].map((lang) =>
    tryJSON(`${TCGDEX}/${lang}/cards?name=${encodeURIComponent(t)}`))));
  const setNames = new Map((await getSets()).map((s) => [s.id, s.name]));
  const byId = new Map();
  for (const c of results.flatMap((r) => r || [])) {
    const prev = byId.get(c.id);
    if (prev) { // gleiche Karte in anderer Sprache: Namen merken, fehlendes Bild ergänzen
      prev.image = prev.image || c.image;
      if (!prev.names.includes(c.name)) prev.names.push(c.name);
      continue;
    }
    const setId = c.id.slice(0, c.id.length - c.localId.length - 1);
    byId.set(c.id, { id: c.id, name: c.name, names: [c.name], image: c.image, localId: c.localId, setId, setName: setNames.get(setId) });
  }
  return [...byId.values()].reverse(); // neuere Sets zuerst
}

// Karten mit dieser Nummer in allen Sets dieser Größe (mit Namen in allen drei Sprachen zum Vergleichen)
async function cardsByNumber(num, total) {
  const sets = (await getSets()).filter((s) => String(s.cardCount?.official) === total);
  const cards = await Promise.all(sets.map(async (s) => {
    const [de, en, fr] = await Promise.all(["de", "en", "fr"].map((lang) => tryJSON(`${TCGDEX}/${lang}/sets/${s.id}/${num}`)));
    const c = de || en || fr;
    if (!c) return null;
    const names = [...new Set([de, en, fr].filter(Boolean).map((x) => x.name))];
    return { id: c.id, name: c.name, names, image: c.image || en?.image, setId: s.id, setName: c.set?.name, localId: c.localId };
  }));
  return cards.filter(Boolean);
}

async function findCandidates(q) {
  const { words } = q;
  let name = q.name;
  const numbers = q.numbers?.length ? q.numbers : q.num ? [{ num: q.num, total: q.total }] : [];
  const officialOf = new Map((await getSets()).map((s) => [s.id, String(s.cardCount?.official)]));
  let list = [];

  // 1. Über den Namen – und wenn eine Setgröße gelesen wurde, nur Karten aus Sets dieser Größe.
  //    Name + Setgröße ist sehr zuverlässig, auch wenn die Kartennummer selbst falsch gelesen wurde.
  //    Beim Scan gibt es oft mehrere gelesene Namen (teils Unsinn, der zufällig eine echte Karte
  //    trifft): Treffer zu allen Namen sammeln, der Bildvergleich entscheidet später.
  const longWords = [...(words || [])].filter((w) => w.length >= 5).sort((a, b) => b.length - a.length).slice(0, 2);
  for (const n of q.names?.length ? q.names : name ? [name] : []) {
    let found = await searchByName([...new Set([n, ...longWords])]);
    if (q.fromScan) {
      found = found.filter((c) => c.names.some((x) => [n, ...longWords].some((w) => strictSimilarity(x, w) >= 0.7)));
    }
    if (!found.length) continue;
    if (!list.length) name = n;
    list.push(...found.filter((c) => !list.some((x) => x.id === c.id)));
  }
  if (list.length) {
    const totals = new Set(numbers.map((n) => n.total).filter(Boolean));
    if (totals.size) {
      const inSets = list.filter((c) => totals.has(officialOf.get(c.setId)));
      if (inSets.length) list = inSets;
      else if (q.fromScan) list = []; // gelesener Name passt nicht zur Nummer -> über die Nummer suchen
    }
    const exact = list.filter((c) => numbers.some((n) => n.num === stripZeros(c.localId)));
    if (exact.length) list = exact;
  }

  // 2. Über Nummer + Setgröße (funktioniert in jeder Sprache gleich)
  if (!list.length) {
    for (const n of numbers.filter((n) => n.num && n.total).slice(0, 3)) list.push(...await cardsByNumber(n.num, n.total));
    list = list.filter((c, i) => list.findIndex((x) => x.id === c.id) === i);
  }

  for (const c of list) c.score = Math.max(...(c.names || [c.name]).map((n) => nameScore(n, { name, words })));
  list.sort((a, b) => b.score - a.score);
  return list.slice(0, 150); // viele Treffer (z.B. alle Mew-Karten) – der Bildvergleich sucht die richtige
}

// Scan mit gerader Karte: Bildvergleich mit allen Karten der Bild-Datenbank, dazu die gelesenen
// Namen/Nummern als Bonus. Ohne Datenbank wie bisher nur über den gelesenen Text.
async function lookupScan(query) {
  resetViews();
  busy("Vergleiche mit allen Karten …");
  const totals = new Set((query.numbers || []).map((n) => n.total));
  const byImage = await matchByImage(query.card, 40, totals);
  if (!byImage.length) return lookupText(query); // noch keine Bild-Datenbank gebaut

  // Treffer aus dem gelesenen Text (Name, Setgröße, Nummer) bekommen einen Bonus
  let byText = [];
  if (query.name || query.numbers?.length) {
    byText = await findCandidates(query);
    if (!query.numbers?.length) {
      byText = byText.filter((c) => (c.names || [c.name]).some((n) =>
        [query.name, ...query.words].some((w) => strictSimilarity(n, w) >= 0.7)));
    }
    byText = await rankByImage(query.card, byText);
  }
  // Bonus: +0.1 wenn die Setgröße passt, +0.15 wenn auch Name oder Nummer passen
  const all = new Map(byImage.map((c) => [c.id, { ...c, bonus: c.inTotal ? 0.1 : 0 }]));
  for (const c of byText) {
    const prev = all.get(c.id);
    all.set(c.id, { ...(prev || c), visual: c.visual, bonus: (prev?.bonus || 0) + 0.15 });
  }
  const list = [...all.values()]
    .map((c) => ({ ...c, total: c.visual + c.bonus }))
    .sort((a, b) => b.total - a.total);

  const [a, b] = list;
  if (!a || a.visual < 0.15) {
    showStatus("Ich habe keine Karte gefunden, die so aussieht wie deine. Versuch ein Foto ohne Schatten und Spiegelung oder tippe Name und Nummer unten ein (z.B. <b>Pikachu 25/165</b>).", true);
    return;
  }
  hideStatus();
  // Klar vorne? Dann direkt öffnen, sonst die ähnlichsten zur Auswahl zeigen
  const gap = a.total - (b?.total ?? -1);
  if (a.visual >= 0.35 && gap >= 0.12) return openCard(a.id);
  renderCandidates(list, true);
}

async function lookup(query) {
  if (query.card) return lookupScan(query);
  return lookupText(query);
}

async function lookupText(query) {
  resetViews();
  if (!query.name && !query.num) {
    showStatus("Ich konnte auf dem Foto nichts lesen. Versuch es nochmal mit besserem Licht oder tippe den Namen und die Nummer ein (z.B. <b>Glurak 4/102</b>).", true);
    return;
  }
  busy("Suche die Karte …");
  let list = await findCandidates(query);
  // Scan ohne Nummer: nur Karten, deren ganzer Name wirklich zum gelesenen Wort passt (kein Raten aus Wortfetzen)
  if (query.fromScan && !query.num && !query.numbers?.length) {
    list = list.filter((c) => (c.names || [c.name]).some((n) =>
      [query.name, ...query.words].some((w) => strictSimilarity(n, w) >= 0.7)));
    if (!list.length) {
      showStatus("Ich konnte die Karte nicht sicher lesen. Rahme sie enger ein, halte das Handy näher und gerade über die Karte, oder tippe Name und Nummer unten ein (z.B. <b>Pikachu 25/165</b>).", true);
      return;
    }
  }
  if (!list.length) {
    showStatus("Keine passende Karte gefunden. Tippe den Namen und die Nummer unten links auf der Karte ein (z.B. <b>Pikachu 25/165</b>).", true);
    return;
  }
  if (list.length === 1) return hideStatus(), openCard(list[0].id);

  // Beim Scan: Kartenbild mit den Bildern der Treffer vergleichen – die ähnlichste Karte gewinnt
  if (query.card) {
    busy("Vergleiche das Kartenbild …");
    list = await rankByImage(query.card, list);
    const [a, b] = list;
    if (a.visual < 0.15) {
      // keine der gefundenen Karten sieht so aus wie deine -> wahrscheinlich falsch gelesen
      showStatus("Ich habe Karten gefunden, aber keine sieht so aus wie deine. Tippe Name und Nummer unten ein (z.B. <b>Pikachu 25/165</b>).", true);
      return;
    }
    hideStatus();
    // Klar vorne? Glitzerkarten erreichen nur niedrige Werte, deshalb zählt vor allem der Abstand
    const gap = a.visual - (b?.visual ?? -1);
    if ((a.visual >= 0.5 && gap >= 0.15) || (a.visual >= 0.2 && gap >= 0.25)) return openCard(a.id);
    return renderCandidates(list);
  }

  hideStatus();
  // Eindeutiger Treffer -> direkt öffnen, sonst auswählen lassen
  if (query.num && list[0].score >= 0.8 && list[1].score < 0.8) return openCard(list[0].id);
  renderCandidates(list);
}

// ---------- Bild-Datenbank (gebaut mit build-index.html) ----------
// Für jede Karte ein Fingerabdruck des Kartenbilds: damit lässt sich ein Foto mit allen
// ~22.000 Karten auf einmal vergleichen, ohne Text lesen zu müssen.
let indexPromise = null;
function loadIndex() {
  if (!indexPromise) {
    indexPromise = Promise.all([
      fetch("data/cards.json").then((r) => (r.ok ? r.json() : null)),
      fetch("data/fingerprints.bin").then((r) => (r.ok ? r.arrayBuffer() : null)),
    ]).then(([meta, bin]) => {
      if (!meta || !bin || bin.byteLength !== meta.length * FP_LEN) return null;
      const pos = new Map(meta.map((m, i) => [m[0], i]));
      return { meta, fps: new Int8Array(bin), pos };
    }).catch(() => null);
  }
  return indexPromise;
}

// Ähnlichkeit des Fotos zu Karte Nr. i der Datenbank (gespeichert als Wert * 32)
function indexSimilarity(idx, fp, i) {
  let s = 0;
  const o = i * FP_LEN;
  for (let k = 0; k < FP_LEN; k++) s += fp[k] * idx.fps[o + k];
  return s / (32 * FP_LEN);
}

// Die n Karten der Datenbank, die dem Foto am ähnlichsten sehen. Wurde eine Setgröße gelesen
// (z.B. "/086"), kommen die ähnlichsten Karten aus Sets dieser Größe immer mit dazu (inTotal).
async function matchByImage(card, n = 40, totals = new Set()) {
  const idx = await loadIndex();
  if (!idx) return [];
  const fp = fingerprint(card);
  const sets = await getSets();
  const setInfo = new Map(sets.map((s) => [s.id, s]));
  const setIdOf = (id) => id.slice(0, id.lastIndexOf("-"));
  const order = idx.meta.map((_, i) => i);
  const scores = order.map((i) => indexSimilarity(idx, fp, i));
  order.sort((a, b) => scores[b] - scores[a]);
  const picked = new Set(order.slice(0, n));
  if (totals.size) {
    const inTotal = order.filter((i) => totals.has(String(setInfo.get(setIdOf(idx.meta[i][0]))?.cardCount?.official)));
    inTotal.slice(0, 15).forEach((i) => picked.add(i));
  }
  return [...picked].map((i) => {
    const [id, name, image] = idx.meta[i];
    const set = setInfo.get(setIdOf(id));
    return {
      id, name, names: [name], image, visual: scores[i],
      localId: id.slice(id.lastIndexOf("-") + 1), setId: setIdOf(id), setName: set?.name,
      inTotal: totals.has(String(set?.cardCount?.official)),
    };
  });
}

// Sortiert die Treffer nach Ähnlichkeit zum fotografierten Kartenbild (Feld "visual", -1 bis 1)
async function rankByImage(card, list) {
  const mine = fingerprint(card);
  // Karten aus der Bild-Datenbank direkt vergleichen, nur fehlende Bilder laden
  const idx = await loadIndex();
  if (idx) for (const c of list) if (idx.pos.has(c.id)) c.visual = indexSimilarity(idx, mine, idx.pos.get(c.id));
  const missing = list.filter((c) => c.visual === undefined);
  // in Gruppen von 20 Bildern laden, damit das Handy nicht überlastet wird
  for (let i = 0; i < missing.length; i += 20) {
    if (missing.length > 20) busy(`Vergleiche das Kartenbild … (${Math.min(i + 20, missing.length)}/${missing.length})`);
    await Promise.all(missing.slice(i, i + 20).map(async (c) => {
      c.visual = -1;
      if (!c.image) return;
      try {
        const blob = await fetch(imageFetchUrl(`${c.image}/low.webp`)).then((r) => r.blob());
        const img = await loadImage(blob);
        c.visual = fpSimilarity(mine, fingerprint(img));
        URL.revokeObjectURL(img.src);
      } catch {}
    }));
  }
  return [...list].sort((a, b) => b.visual - a.visual);
}

// best = true: die erste Karte ist die beste Übereinstimmung (Scan) und wird groß gezeigt
function renderCandidates(list, best = false) {
  const tile = (c) => `
    <button class="cand" data-id="${esc(c.id)}">
      ${c.image ? `<img loading="lazy" src="${esc(c.image)}/low.webp" alt="">` : `<div class="noimg">kein Bild</div>`}
      <div class="n">${esc(c.name)}</div>
      <div class="s">${esc(c.setName || c.id)} · #${esc(c.localId)}</div>
    </button>`;
  const [first, ...rest] = list.slice(0, 30);
  els.candidates.hidden = false;
  els.candidates.innerHTML = best
    ? `<h2>Ist es diese Karte?</h2>
       <div class="best-cand">${tile(first)}<button class="btn buy" data-id="${esc(first.id)}">Ja, das ist sie</button></div>
       <h2>Oder eine von diesen?</h2><div class="grid">${rest.map(tile).join("")}</div>`
    : `<h2>Welche Karte ist es?</h2><div class="grid">${list.slice(0, 30).map(tile).join("")}</div>`;
  els.candidates.querySelectorAll("[data-id]").forEach((b) => b.addEventListener("click", () => openCard(b.dataset.id)));
}

// ---------- Preise ----------
async function openCard(id) {
  els.candidates.hidden = true;
  busy("Hole Preise von Cardmarket und eBay …");
  const [de, en] = await Promise.all([tryJSON(`${TCGDEX}/de/cards/${id}`), tryJSON(`${TCGDEX}/en/cards/${id}`)]);
  const card = de || en;
  if (!card) return showStatus("Die Karte konnte nicht geladen werden.", true);

  current = { card, enCard: en, ebay: { loading: true }, cmUrl: null };
  hideStatus();
  renderResult();

  const [ebay, cmUrl] = await Promise.all([loadEbay(card, en), cardmarketPageUrl(card, en)]);
  if (current?.card !== card) return;
  current.ebay = ebay;
  current.cmUrl = cmUrl;
  renderResult();
}

// Direkter Link zur Cardmarket-Kartenseite über pokemontcg.io (leitet auf die echte Produktseite weiter)
async function cardmarketPageUrl(card, enCard) {
  const official = card.set?.cardCount?.official;
  if (!enCard?.name || !official) return null;
  const q = `name:"${enCard.name.replace(/"/g, "")}" number:${stripZeros(card.localId)} set.printedTotal:${official}`;
  const r = await tryJSON(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(q)}&select=id,cardmarket&pageSize=1`);
  return r?.data?.[0]?.cardmarket?.url || null;
}

function numberLabel(card) {
  return card.set?.cardCount?.official ? `${card.localId}/${String(card.set.cardCount.official).padStart(String(card.localId).length, "0")}` : card.localId;
}

async function loadEbay(card, enCard) {
  const num = numberLabel(card);
  const names = [...new Set([card.name, enCard?.name].filter(Boolean))];
  const linkQuery = `pokemon ${names[0]} ${num}`;
  const link = `https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(linkQuery)}&_sop=15&LH_BIN=1`;
  if (!ON_MAC) return { configured: false, link };
  try {
    for (const n of names) {
      const r = await getJSON(`/api/ebay?q=${encodeURIComponent(`pokemon ${n} ${num}`)}&num=${encodeURIComponent(num)}`);
      if (!r.configured) return { configured: false, link };
      if (r.items.length) return { configured: true, items: r.items, link };
    }
    return { configured: true, items: [], link };
  } catch (e) {
    return { error: "eBay ist gerade nicht erreichbar.", link };
  }
}

function cardmarketVariants(card) {
  const seen = new Map();
  for (const v of card.variants_detailed || []) {
    const cm = cleanPrices(v.pricing?.cardmarket);
    if (!cm?.idProduct || seen.has(cm.idProduct)) continue;
    const isHolo = v.type && /holo/i.test(v.type) && !/reverse/i.test(v.type);
    const label = [v.type, v.subtype, ...(v.stamp || [])].filter(Boolean).join(" · ");
    seen.set(cm.idProduct, {
      label: label || "Normal",
      low: (isHolo ? cm["low-holo"] : null) ?? cm.low ?? cm["low-holo"],
      trend: (isHolo ? cm["trend-holo"] : null) ?? cm.trend ?? cm["trend-holo"],
      url: `https://www.cardmarket.com/de/Pokemon/Products?idProduct=${cm.idProduct}`,
    });
  }
  const cm = cleanPrices(card.pricing?.cardmarket);
  if (!seen.size && cm) {
    seen.set(cm.idProduct || "main", {
      label: "Normal",
      low: cm.low ?? cm["low-holo"],
      trend: cm.trend ?? cm["trend-holo"],
      url: cm.idProduct ? `https://www.cardmarket.com/de/Pokemon/Products?idProduct=${cm.idProduct}` : null,
    });
  }
  return [...seen.values()].filter((v) => v.low != null || v.trend != null);
}

// 0 bedeutet bei TCGdex "kein Preis"
function cleanPrices(cm) {
  if (!cm) return null;
  const out = { ...cm };
  for (const k of Object.keys(out)) if (out[k] === 0) out[k] = null;
  return out;
}

function renderResult() {
  const { card, ebay, cmUrl } = current;
  const buy = mode === "buy";
  const variants = cardmarketVariants(card);
  const cmSearch = `https://www.cardmarket.com/de/Pokemon/Products/Search?searchString=${encodeURIComponent(card.name)}`;

  // Billigstes Angebot insgesamt
  const offers = [];
  const firstCm = variants.find((v) => v.low != null);
  if (firstCm) offers.push({ price: firstCm.low, where: `Cardmarket (${firstCm.label})`, url: cmUrl || firstCm.url || cmSearch });
  if (ebay.items?.length) offers.push({ price: ebay.items[0].total, where: "eBay (inkl. Versand)", url: ebay.items[0].url });
  offers.sort((a, b) => a.price - b.price);
  const best = offers[0];

  const img = card.image ? `${card.image}/high.webp` : current.enCard?.image ? `${current.enCard.image}/high.webp` : "";

  els.result.hidden = false;
  els.result.innerHTML = `
    <div class="card-head">
      ${img ? `<img src="${esc(img)}" alt="${esc(card.name)}">` : `<div></div>`}
      <div>
        <h2>${esc(card.name)}</h2>
        <div class="meta">${esc(card.set?.name || "")} · Nr. ${esc(numberLabel(card))}${card.rarity ? " · " + esc(card.rarity) : ""}</div>
        ${best ? `
          <div class="best">
            <div class="label">Billigster Preis</div>
            <div class="price">${euro(best.price)}</div>
            <div class="where">bei ${esc(best.where)}</div>
            ${buy ? `<div class="links"><a class="btn buy" href="${esc(best.url)}" target="_blank" rel="noopener">Jetzt kaufen →</a></div>` : ""}
          </div>` : ebay.loading ? `<p class="note"><span class="spinner"></span>Suche Preise …</p>` : `<p class="note">Keine Preise gefunden.</p>`}
      </div>
    </div>

    <div class="shop">
      <h3>Cardmarket <span class="src">ab-Preis (alle Zustände)</span></h3>
      ${variants.length ? variants.map((v) => `
        <div class="row">
          <div class="info"><div class="t">${esc(v.label)}</div><div class="sub">Trend ${euro(v.trend)}</div></div>
          <div class="p">${v.low != null ? "ab " + euro(v.low) : "–"}</div>
          ${buy && v.url ? `<a class="btn buy" href="${esc(v.url)}" target="_blank" rel="noopener">Kaufen</a>` : ""}
        </div>`).join("") : `<p class="note">Keine Cardmarket-Preise für diese Karte.</p>`}
      ${buy ? `<div class="links"><a class="btn" href="${esc(cmSearch)}" target="_blank" rel="noopener">Auf Cardmarket suchen</a></div>` : ""}
    </div>

    <div class="shop">
      <h3>eBay <span class="src">Sofort-Kaufen, billigste zuerst</span></h3>
      ${renderEbay(ebay, buy)}
    </div>

    <button class="btn back" id="again">📷 Nächste Karte scannen</button>
  `;
  $("#again").addEventListener("click", () => els.photo.click());
}

function renderEbay(ebay, buy) {
  if (ebay.loading) return `<p class="note"><span class="spinner"></span>Suche auf eBay …</p>`;
  const linkBtn = `<div class="links"><a class="btn${buy ? " buy" : ""}" href="${esc(ebay.link)}" target="_blank" rel="noopener">${buy ? "Billigste Angebote auf eBay öffnen →" : "Auf eBay ansehen"}</a></div>`;
  if (ebay.error) return `<p class="note">${esc(ebay.error)}</p>${linkBtn}`;
  if (!ebay.configured) {
    return `<p class="note">Der Link öffnet die eBay-Suche nach dieser Karte, billigste Angebote inkl. Versand zuerst.</p>${linkBtn}`;
  }
  if (!ebay.items.length) return `<p class="note">Keine passenden Sofort-Kaufen-Angebote gefunden.</p>${linkBtn}`;
  const items = buy ? ebay.items : ebay.items.slice(0, 3);
  return items.map((it) => `
    <div class="row">
      ${it.image ? `<img class="thumb" src="${esc(it.image)}" alt="">` : ""}
      <div class="info"><div class="t">${esc(it.title)}</div><div class="sub">${esc(it.condition)}</div></div>
      <div class="p">${euro(it.total)}<small>${it.shipping ? "inkl. " + euro(it.shipping) + " Versand" : "Versand frei"}</small></div>
      ${buy ? `<a class="btn buy" href="${esc(it.url)}" target="_blank" rel="noopener">Kaufen</a>` : ""}
    </div>`).join("") + (buy ? linkBtn : "");
}

// ---------- Eingaben ----------
els.photo.addEventListener("change", async () => {
  const file = els.photo.files[0];
  els.photo.value = "";
  if (!file) return;
  resetViews();
  els.preview.hidden = true;
  getWorker(); // Texterkennung schon im Hintergrund laden
  try {
    const img = await loadImage(file);
    busy("Suche die Karte im Foto …");
    const card = await detectCard(img).catch((e) => { console.warn(e); return null; });
    if (!card) return showCropper(img);
    saveScan(img, card);
    // Ist das Kartenbild eindeutig, gleich öffnen – Text lesen dauert auf dem Handy länger
    busy("Vergleiche mit allen Karten …");
    const [a, b] = (await matchByImage(card, 2)).sort((x, y) => y.visual - x.visual);
    if (a && a.visual >= 0.6 && a.visual - (b?.visual ?? 0) >= 0.12) {
      els.preview.hidden = false;
      els.preview.innerHTML = `<img src="${card.toDataURL("image/jpeg", 0.85)}" alt="Deine Karte">`;
      return openCard(a.id);
    }
    await lookup(await readStraightCard(card));
  } catch (e) {
    console.error(e);
    showStatus("Beim Scannen ist etwas schiefgelaufen: " + esc(e.message), true);
  }
});

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.preview.hidden = true;
  try {
    await lookup(parseQuery(text));
  } catch (err) {
    console.error(err);
    showStatus("Fehler bei der Suche: " + esc(err.message), true);
  }
});

getSets(); // schon mal vorladen

// Bilderkennung schon mal im Hintergrund laden, damit der erste Scan schneller geht
setTimeout(() => loadOpenCV().catch(() => {}), 1500);
