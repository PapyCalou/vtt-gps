// Calculs géographiques : distance, dénivelé, simplification, difficulté, durée.

export const TYPES = {
  vtt:    { label: 'VTT',       color: '#d9480f', flat: 19,  climb: 900,  kf: 1,   df: 50, bike: true },
  gravel: { label: 'Gravel',    color: '#9a6a00', flat: 24,  climb: 1000, kf: 0.7, df: 60, bike: true },
  route:  { label: 'Route',     color: '#1c6dd0', flat: 28,  climb: 1100, kf: 0.4, df: 80, bike: true },
  rando:  { label: 'Randonnée', color: '#2b8a3e', flat: 4.5, climb: 500,  kf: 2.5, df: 25, bike: false },
};

export const LEVELS = [
  { label: 'Facile',         color: '#2b8a3e' },
  { label: 'Modérée',        color: '#1c6dd0' },
  { label: 'Difficile',      color: '#d62828' },
  { label: 'Très difficile', color: '#1b1b1b' },
];

const R = 6371000, rad = Math.PI / 180;

/** Distance en mètres entre deux points [lat, lon]. */
export function hav(a, b) {
  const p1 = a[0] * rad, p2 = b[0] * rad, dp = p2 - p1, dl = (b[1] - a[1]) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Douglas-Peucker en mètres ; renvoie les indices conservés. */
function simplifyIdx(raw, tol) {
  const lat0 = raw[0].lat, kx = 111320 * Math.cos(lat0 * rad), ky = 110540;
  const xy = raw.map(p => [(p.lon - raw[0].lon) * kx, (p.lat - lat0) * ky]);
  const keep = new Uint8Array(raw.length); keep[0] = keep[raw.length - 1] = 1;
  const stack = [[0, raw.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b <= a + 1) continue;
    const [ax, ay] = xy[a], [bx, by] = xy[b], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let md = -1, mi = a;
    for (let i = a + 1; i < b; i++) {
      const px = xy[i][0] - ax, py = xy[i][1] - ay;
      let d;
      if (L === 0) d = Math.hypot(px, py);
      else { const t = Math.max(0, Math.min(1, (px * dx + py * dy) / L)); d = Math.hypot(px - t * dx, py - t * dy); }
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return keep;
}

/**
 * Analyse une trace brute [{lat, lon, ele, t}] (ele en m ou null, t en secondes ou null).
 * Renvoie { pts: [[lat, lon, ele]], stats }.
 */
export function analyse(raw) {
  const n = raw.length;
  const hasEle = raw.some(p => p.ele != null);
  // Altitudes : combler les trous puis lisser sur 7 points.
  let last = hasEle ? raw.find(p => p.ele != null).ele : 0;
  const el = raw.map(p => (p.ele != null ? (last = p.ele) : last));
  const sm = el.map((_, i) => {
    const a = Math.max(0, i - 3), b = Math.min(n, i + 4);
    let s = 0; for (let k = a; k < b; k++) s += el[k];
    return s / (b - a);
  });
  // Distance cumulée et temps de déplacement.
  const cum = new Float64Array(n); let mov = 0;
  for (let i = 1; i < n; i++) {
    const d = hav([raw[i - 1].lat, raw[i - 1].lon], [raw[i].lat, raw[i].lon]);
    cum[i] = cum[i - 1] + d;
    const t0 = raw[i - 1].t, t1 = raw[i].t;
    if (t0 != null && t1 != null) { const dt = t1 - t0; if (dt > 0 && dt <= 60 && d / dt > 0.5) mov += dt; }
  }
  // Dénivelé avec seuil de 2 m pour ignorer le bruit du GPS.
  let up = 0, dn = 0, ref = sm[0];
  for (const e of sm) {
    if (e - ref >= 2) { up += e - ref; ref = e; }
    else if (ref - e >= 2) { dn += ref - e; ref = e; }
  }
  // Pente maximale sur une fenêtre d'environ 100 m.
  let maxGrade = 0;
  if (hasEle) for (let i = 0, j = 0; i < n; i++) {
    while (j < n - 1 && cum[j] - cum[i] < 100) j++;
    const d = cum[j] - cum[i];
    if (d >= 100) maxGrade = Math.max(maxGrade, (sm[j] - sm[i]) / d * 100);
  }
  // Simplification : 6 m de tolérance, un point au moins tous les 150 m.
  const keep = simplifyIdx(raw, 6); let acc = 0;
  for (let i = 1; i < n; i++) {
    acc += cum[i] - cum[i - 1];
    if (keep[i]) acc = 0; else if (acc > 150) { keep[i] = 1; acc = 0; }
  }
  const pts = [];
  for (let i = 0; i < n; i++) if (keep[i]) pts.push([+raw[i].lat.toFixed(5), +raw[i].lon.toFixed(5), +sm[i].toFixed(1)]);
  const gap = hav([raw[0].lat, raw[0].lon], [raw[n - 1].lat, raw[n - 1].lon]);
  return {
    pts,
    stats: {
      km: +(cum[n - 1] / 1000).toFixed(2),
      dplus: hasEle ? Math.round(up) : null,
      dminus: hasEle ? Math.round(dn) : null,
      eleMin: hasEle ? Math.round(el.reduce((a, b) => Math.min(a, b))) : null,
      eleMax: hasEle ? Math.round(el.reduce((a, b) => Math.max(a, b))) : null,
      maxGrade: hasEle ? Math.round(maxGrade) : null,
      mov: mov > 300 ? Math.round(mov) : null,
      loop: gap < 400,
    },
  };
}

/** Niveau de difficulté 0..3 selon le type, la distance et le dénivelé. */
export function difficulty(type, km, dplus) {
  const T = TYPES[type] || TYPES.vtt;
  const score = km * T.kf + (dplus || 0) / T.df;
  return score < 25 ? 0 : score < 45 ? 1 : score < 70 ? 2 : 3;
}

/** Durée estimée en secondes ; factor = calibrage personnel. */
export function estimate(type, km, dplus, factor = 1) {
  const T = TYPES[type] || TYPES.vtt;
  return Math.round((km / T.flat + (dplus || 0) / T.climb) * 3600 * factor);
}

export function fmtDur(sec) {
  if (sec == null) return '—';
  const m = Math.round(sec / 60), h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
}

/** Distances cumulées (km) le long des points simplifiés. */
export function cumKm(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + hav(pts[i - 1], pts[i]) / 1000);
  return c;
}
