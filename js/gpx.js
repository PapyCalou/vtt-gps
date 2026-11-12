// Lecture et écriture des fichiers GPX.

function guessType(text) {
  const s = (text || '').toLowerCase();
  if (!s) return null;
  if (/mountain|mtb|vtt|enduro/.test(s)) return 'vtt';
  if (/gravel/.test(s)) return 'gravel';
  if (/hik|walk|rando|marche|trek|trail_run|running/.test(s)) return 'rando';
  if (/road|route|cycl|ride|biking|velo|vélo/.test(s)) return 'route';
  return null;
}

function readPoints(nodes) {
  const out = [];
  for (const n of nodes) {
    const lat = parseFloat(n.getAttribute('lat')), lon = parseFloat(n.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const e = n.getElementsByTagName('ele')[0], t = n.getElementsByTagName('time')[0];
    const ele = e ? parseFloat(e.textContent) : NaN;
    const ts = t ? Date.parse(t.textContent) : NaN;
    out.push({ lat, lon, ele: isFinite(ele) ? ele : null, t: isFinite(ts) ? ts / 1000 : null });
  }
  return out;
}

/** Renvoie une liste de traces { name, type, raw, date } trouvées dans le fichier. */
export function parseGpx(text, fileName = '') {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Fichier GPX illisible');
  const base = fileName.replace(/\.gpx$/i, '').replace(/^[0-9a-f]{8}-/, '').replace(/_/g, ' ');
  const out = [];
  const first = (el, tag) => { for (const c of el.children) if (c.localName === tag) return c.textContent.trim(); return ''; };
  const add = (el, nodes) => {
    const raw = readPoints(nodes);
    if (raw.length < 2) return;
    const name = first(el, 'name') || base || 'Sortie sans nom';
    const type = guessType(first(el, 'type')) || guessType(name) || guessType(base);
    const t0 = raw.find(p => p.t != null);
    out.push({ name, type, raw, date: t0 ? new Date(t0.t * 1000).toISOString().slice(0, 10) : null });
  };
  for (const trk of doc.getElementsByTagName('trk')) add(trk, trk.getElementsByTagName('trkpt'));
  if (!out.length) for (const rte of doc.getElementsByTagName('rte')) add(rte, rte.getElementsByTagName('rtept'));
  if (!out.length) throw new Error('Aucune trace dans ce fichier');
  return out;
}

const xml = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/** Construit un GPX « parcours » (sans horodatage) accepté par Garmin Connect, Edge et Epix. */
export function buildGpx(track) {
  const pts = track.pts.map(p => `<trkpt lat="${p[0]}" lon="${p[1]}"><ele>${p[2]}</ele></trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="VTT-GPS" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${xml(track.name)}</name></metadata>
<trk><name>${xml(track.name)}</name>
<trkseg>
${pts}
</trkseg></trk>
</gpx>
`;
}
