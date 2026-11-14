// Findet eine Pokémon-Karte im Foto und schneidet sie gerade und entzerrt aus (wie ein Dokumenten-Scanner).
// Nutzt OpenCV.js, das erst beim ersten Scan geladen wird (~10 MB, danach im Browser-Cache).
const OPENCV_URL = "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js";
const CARD_W = 800, CARD_H = Math.round(800 * 88 / 63);

let cvPromise = null;
function loadOpenCV() {
  if (!cvPromise) {
    cvPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = OPENCV_URL;
      s.onerror = () => reject(new Error("OpenCV konnte nicht geladen werden"));
      s.onload = () => {
        // Das OpenCV-Modul ist ein "thenable", das sich selbst zurückgibt: "await cv" oder resolve(cv)
        // würden endlos laufen und die Seite einfrieren. Deshalb in ein Objekt verpacken.
        const started = Date.now();
        (function check() {
          if (window.cv && typeof window.cv.Mat === "function") return resolve({ cv: window.cv });
          if (Date.now() - started > 60000) return reject(new Error("OpenCV startet nicht"));
          setTimeout(check, 100);
        })();
      };
      document.head.appendChild(s);
    });
  }
  return cvPromise;
}

// Liefert ein Canvas mit der geraden Karte (Hochformat) oder null, wenn keine Karte gefunden wurde
async function detectCard(src) {
  const { cv } = await loadOpenCV();
  const W = src.naturalWidth || src.width, H = src.naturalHeight || src.height;
  const k = 900 / Math.max(W, H);
  const small = document.createElement("canvas");
  small.width = Math.round(W * k);
  small.height = Math.round(H * k);
  small.getContext("2d").drawImage(src, 0, 0, small.width, small.height);

  const mats = [];
  const keep = (m) => (mats.push(m), m);
  try {
    const img = keep(cv.imread(small));
    const rgb = keep(new cv.Mat());
    cv.cvtColor(img, rgb, cv.COLOR_RGBA2RGB);
    const gray = keep(new cv.Mat());
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    const hsv = keep(new cv.Mat());
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const hsvParts = keep(new cv.MatVector());
    cv.split(hsv, hsvParts);
    const sat = keep(hsvParts.get(1));

    // Mehrere Durchgänge: Helligkeit findet Karten auf ruhigem Untergrund, die Farbsättigung
    // findet sie auch auf Holz (Maserung = hell/dunkel, aber gleiche Farbe; Kartenrand = andere Farbe)
    const passes = [[gray, 5, 30, 100], [sat, 9, 20, 60], [sat, 5, 40, 120], [gray, 9, 60, 180]];
    const kernel = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    const imgArea = small.width * small.height;
    let best = null;
    for (const [channel, blur, t1, t2] of passes) {
      const edges = keep(new cv.Mat());
      cv.GaussianBlur(channel, edges, new cv.Size(blur, blur), 0);
      cv.Canny(edges, edges, t1, t2);
      cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);
      const contours = keep(new cv.MatVector());
      const hierarchy = keep(new cv.Mat());
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);
        // nicht zu klein, und nicht das ganze Foto (Fotos haben selbst fast Kartenformat)
        if (area > imgArea * 0.03 && area < imgArea * 0.8) {
          const rect = cv.minAreaRect(cnt);
          const w = rect.size.width, h = rect.size.height;
          const ratio = Math.min(w, h) / Math.max(w, h);
          const fill = area / (w * h); // wie rechteckig die Form ist
          if (ratio > 0.64 && ratio < 0.8 && fill > 0.85) {
            // große, kartenförmige Rechtecke bevorzugen
            const score = area * fill * (1 - Math.abs(ratio - 63 / 88) * 3);
            if (!best || score > best.score) best = { score, rect };
          }
        }
        cnt.delete();
      }
    }
    if (!best) return null;

    // Ecken im Originalbild, im Uhrzeigersinn ab oben links
    let pts = cv.RotatedRect.points(best.rect).map((p) => ({ x: p.x / k, y: p.y / k }));
    pts = orderClockwise(pts);
    // Die Kante von Punkt 0 nach 1 soll die kurze (obere) Kante sein -> Hochformat
    if (dist(pts[0], pts[1]) > dist(pts[1], pts[2])) pts = [pts[3], pts[0], pts[1], pts[2]];
    return warp(cv, src, pts, keep);
  } finally {
    mats.forEach((m) => m.delete());
  }
}

function warp(cv, src, pts, keep) {
  const full = document.createElement("canvas");
  full.width = src.naturalWidth || src.width;
  full.height = src.naturalHeight || src.height;
  full.getContext("2d").drawImage(src, 0, 0);
  const img = keep(cv.imread(full));
  const from = keep(cv.matFromArray(4, 1, cv.CV_32FC2, pts.flatMap((p) => [p.x, p.y])));
  const to = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, CARD_W, 0, CARD_W, CARD_H, 0, CARD_H]));
  const M = keep(cv.getPerspectiveTransform(from, to));
  const out = keep(new cv.Mat());
  cv.warpPerspective(img, out, M, new cv.Size(CARD_W, CARD_H), cv.INTER_CUBIC);
  const c = document.createElement("canvas");
  cv.imshow(c, out);
  return c;
}

function orderClockwise(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4, cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // mit dem Punkt oben links beginnen (kleinste x+y)
  const start = sorted.reduce((bi, p, i) => (p.x + p.y < sorted[bi].x + sorted[bi].y ? i : bi), 0);
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Karte um 180° drehen (falls sie auf dem Kopf lag)
function rotate180(c) {
  const out = document.createElement("canvas");
  out.width = c.width;
  out.height = c.height;
  const ctx = out.getContext("2d");
  ctx.translate(c.width, c.height);
  ctx.rotate(Math.PI);
  ctx.drawImage(c, 0, 0);
  return out;
}
