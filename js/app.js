import { TYPES, LEVELS, analyse, difficulty, estimate, fmtDur, hav, cumKm } from './geo.js';
import { parseGpx, buildGpx } from './gpx.js';
import * as db from './db.js';
import { syncNow } from './sync.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fr = (n, d = 0) => n == null ? '—' : n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const frDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const L = window.L;

const S = {
  tracks: [], bikes: [],
  settings: { defaults: {}, gh: { owner: '', repo: '', token: '' }, tombs: {}, bikesAt: 0, lastSync: null, base: 'Topographique' },
  tab: 'sorties', sel: null, editBike: null, pos: null, syncMsg: '',
  f: { type: '', sector: '', km: '', dp: '', dur: '', diff: '', sort: 'date' },
  idea: { type: '', mode: 'dur', dur: 2, km: 30, dp: '', near: false, radius: 30 }, ideaRes: null,
};

/* ---------- Valeurs dérivées ---------- */

function factor(type) {
  const r = S.tracks.filter(t => t.type === type && t.stats.mov).map(t => t.stats.mov / estimate(type, t.stats.km, t.stats.dplus)).sort((a, b) => a - b);
  return r.length ? r[Math.floor(r.length / 2)] : 1;
}
const durOf = t => t.stats.mov ?? estimate(t.type, t.stats.km, t.stats.dplus, factor(t.type));
const levelOf = t => t.diff != null ? t.diff : difficulty(t.type, t.stats.km, t.stats.dplus);
const fromMe = t => S.pos ? hav(S.pos, t.pts[0]) / 1000 : null;
const bikeOf = t => S.bikes.find(b => b.id === t.bikeId);

const RANGES = {
  km: { '0-20': [0, 20], '20-35': [20, 35], '35-50': [35, 50], '50+': [50, 1e9] },
  dp: { '0-400': [0, 400], '400-800': [400, 800], '800-1200': [800, 1200], '1200+': [1200, 1e9] },
  dur: { '0-1.5': [0, 1.5], '1.5-2.5': [1.5, 2.5], '2.5-4': [2.5, 4], '4+': [4, 1e9] },
};
const inRange = (v, key, sel) => { if (!sel) return true; const [a, b] = RANGES[key][sel]; return v >= a && v < b; };

function visible() {
  const f = S.f;
  const list = S.tracks.filter(t =>
    (!f.type || t.type === f.type) && (!f.sector || t.sector === f.sector) &&
    inRange(t.stats.km, 'km', f.km) && inRange(t.stats.dplus || 0, 'dp', f.dp) &&
    inRange(durOf(t) / 3600, 'dur', f.dur) && (f.diff === '' || levelOf(t) === +f.diff));
  const by = {
    date: (a, b) => (b.date || '').localeCompare(a.date || ''),
    km: (a, b) => b.stats.km - a.stats.km,
    dp: (a, b) => (b.stats.dplus || 0) - (a.stats.dplus || 0),
    near: (a, b) => (fromMe(a) ?? 0) - (fromMe(b) ?? 0),
    name: (a, b) => a.name.localeCompare(b.name, 'fr'),
  };
  return list.sort(by[f.sort] || by.date);
}

/* ---------- Enregistrement ---------- */

let syncTimer;
function scheduleSync() {
  const g = S.settings.gh;
  if (!g.owner || !g.repo || !g.token) return;
  clearTimeout(syncTimer); syncTimer = setTimeout(() => doSync(true), 15000);
}
const saveSettings = () => db.setKV('settings', S.settings);
async function saveTrack(t) { t.updatedAt = Date.now(); await db.putTrack(t); scheduleSync(); }
async function saveBikes() { S.settings.bikesAt = Date.now(); await db.setKV('bikes', S.bikes); await saveSettings(); scheduleSync(); }

function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 3500);
}

/* ---------- Carte ---------- */

let map, trackLayer, posMarker, hoverMarker;
function initMap() {
  map = L.map('map', { zoomControl: false, renderer: L.canvas({ tolerance: 10 }) }).setView([46.6, 2.4], 6);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.attributionControl.setPrefix(false);
  const geopf = (layer, fmt) => `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal&FORMAT=image/${fmt}&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;
  const base = {
    'Topographique': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap, SRTM · OpenTopoMap' }),
    'Vélo et VTT': L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', { maxZoom: 20, attribution: '© OpenStreetMap · CyclOSM' }),
    'Plan IGN': L.tileLayer(geopf('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'png'), { maxZoom: 19, attribution: '© IGN' }),
    'Satellite IGN': L.tileLayer(geopf('ORTHOIMAGERY.ORTHOPHOTOS', 'jpeg'), { maxZoom: 19, attribution: '© IGN' }),
    'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }),
  };
  (base[S.settings.base] || base['Topographique']).addTo(map);
  L.control.layers(base, null, { position: 'topright' }).addTo(map);
  map.on('baselayerchange', e => { S.settings.base = e.name; saveSettings(); });
  trackLayer = L.layerGroup().addTo(map);
}

function drawTracks(fit) {
  trackLayer.clearLayers(); hoverMarker = null;
  const list = S.sel ? S.tracks.filter(t => t.id === S.sel).concat(visible().filter(t => t.id !== S.sel)) : visible();
  let selLine;
  for (const t of list) {
    const isSel = t.id === S.sel, color = TYPES[t.type].color;
    const line = L.polyline(t.pts.map(p => [p[0], p[1]]), { color, weight: isSel ? 6 : 4, opacity: S.sel && !isSel ? 0.35 : 0.9 });
    line.on('click', () => openTrack(t.id)).bindTooltip(esc(t.name), { sticky: true });
    trackLayer.addLayer(line);
    trackLayer.addLayer(L.circleMarker([t.pts[0][0], t.pts[0][1]], { radius: isSel ? 7 : 5, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1, interactive: false }));
    if (isSel) selLine = line;
  }
  if (selLine) { selLine.bringToFront(); if (fit) map.fitBounds(selLine.getBounds(), { padding: [30, 30] }); }
  else if (fit && list.length) map.fitBounds(L.latLngBounds(list.flatMap(t => t.pts.map(p => [p[0], p[1]]))), { padding: [30, 30] });
}

function showPos() {
  if (!S.pos) return;
  if (!posMarker) posMarker = L.circleMarker(S.pos, { radius: 8, color: '#fff', weight: 3, fillColor: '#1c6dd0', fillOpacity: 1 }).addTo(map).bindTooltip('Vous êtes ici');
  posMarker.setLatLng(S.pos);
}

function locate() {
  if (!navigator.geolocation) return toast('La localisation n\'est pas disponible sur cet appareil.');
  toast('Recherche de votre position…');
  navigator.geolocation.getCurrentPosition(p => {
    S.pos = [p.coords.latitude, p.coords.longitude]; showPos();
    if (S.f.sort === 'date') S.f.sort = 'near';
    if (!S.sel) map.setView(S.pos, Math.max(map.getZoom(), 11));
    toast('Position trouvée. Les sorties sont classées par proximité.'); render();
  }, () => toast('Position introuvable. Autorisez la localisation pour ce site dans les réglages du navigateur.'), { enableHighAccuracy: true, timeout: 15000 });
}

/* ---------- Import, export, partage ---------- */

async function importFiles(files) {
  let added = 0, dup = 0, bad = 0; const fresh = [];
  for (const file of files) {
    try {
      for (const g of parseGpx(await file.text(), file.name)) {
        const { pts, stats } = analyse(g.raw);
        const same = S.tracks.find(t => hav(t.pts[0], pts[0]) < 150 && Math.abs(t.stats.km - stats.km) < 0.3 && Math.abs((t.stats.dplus || 0) - (stats.dplus || 0)) < 30);
        if (same) { dup++; continue; }
        const type = g.type || 'vtt';
        const t = { id: uid(), name: g.name, type, typeSure: !!g.type, date: g.date, pts, stats, sector: 'À classer', startLabel: '',
          bikeId: TYPES[type].bike ? (S.settings.defaults[type] || null) : null, status: stats.mov ? 'fait' : 'afaire', diff: null, notes: '', createdAt: Date.now() };
        S.tracks.push(t); fresh.push(t); await saveTrack(t); added++;
      }
    } catch (e) { bad++; console.warn(file.name, e); }
  }
  toast([added && `${added} sortie${added > 1 ? 's' : ''} importée${added > 1 ? 's' : ''}`, dup && `${dup} déjà présente${dup > 1 ? 's' : ''}`, bad && `${bad} fichier${bad > 1 ? 's' : ''} illisible${bad > 1 ? 's' : ''}`].filter(Boolean).join(' · ') || 'Aucun fichier GPX reconnu');
  if (added) { S.sel = null; S.tab = 'sorties'; render(true); locateSectors(fresh); }
}

// Commune et rue du point de départ, demandées au service de géocodage d'OpenStreetMap (une requête par seconde au plus).
async function locateSectors(list) {
  for (const t of list) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&accept-language=fr&lat=${t.pts[0][0]}&lon=${t.pts[0][1]}`);
      const a = (await r.json()).address || {};
      const commune = a.village || a.town || a.city || a.municipality || a.hamlet || '';
      t.startLabel = [a.road, commune].filter(Boolean).join(', ');
      if (commune && t.sector === 'À classer') t.sector = commune;
      await saveTrack(t); render();
    } catch (e) { /* hors ligne : le secteur reste à classer */ }
    await new Promise(r => setTimeout(r, 1100));
  }
}

const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'parcours';

function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const gpxFile = (t, type = 'application/gpx+xml') => new File([buildGpx(t)], slug(t.name) + '.gpx', { type });

// Safari refuse certains types de fichier dans la feuille de partage : on essaie plusieurs déclarations
// du même fichier .gpx (iOS choisit les applications proposées d'après l'extension du nom).
async function shareTrack(t) {
  if (navigator.canShare) {
    for (const type of ['application/gpx+xml', 'application/xml', 'text/xml', 'application/octet-stream', 'text/plain']) {
      const file = gpxFile(t, type);
      if (!navigator.canShare({ files: [file] })) continue;
      try { await navigator.share({ files: [file] }); return; }
      catch (e) { if (e.name === 'AbortError') return; break; }
    }
  }
  const file = gpxFile(t); download(file, file.name);
  toast('Partage direct indisponible ici : le fichier GPX a été téléchargé.');
}

function backup() {
  const s = { ...S.settings, gh: { ...S.settings.gh, token: '' } };
  download(new Blob([JSON.stringify({ app: 'vtt-gps', v: 1, date: new Date().toISOString(), tracks: S.tracks, bikes: S.bikes, settings: s })], { type: 'application/json' }),
    `vtt-gps-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`);
}
async function restore(file) {
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== 'vtt-gps' || !Array.isArray(d.tracks)) throw new Error('format');
    let n = 0;
    for (const t of d.tracks) {
      const cur = S.tracks.find(x => x.id === t.id);
      if (!cur) { S.tracks.push(t); await db.putTrack(t); n++; }
      else if ((t.updatedAt || 0) > (cur.updatedAt || 0)) { Object.assign(cur, t); await db.putTrack(cur); n++; }
    }
    if (!S.bikes.length && d.bikes?.length) { S.bikes = d.bikes; S.settings.defaults = d.settings?.defaults || {}; await saveBikes(); }
    toast(`${n} sortie${n > 1 ? 's' : ''} restaurée${n > 1 ? 's' : ''}.`); render(true);
  } catch (e) { toast('Ce fichier n\'est pas une sauvegarde VTT-GPS.'); }
}

async function doSync(silent) {
  const g = S.settings.gh;
  if (!g.owner || !g.repo || !g.token) { S.syncMsg = 'Renseignez le compte, le dépôt et la clé.'; return render(); }
  S.syncMsg = 'Synchronisation en cours…'; if (!silent) render();
  try {
    const r = await syncNow(g, {
      tracks: S.tracks, bikes: S.bikes, bikesAt: S.settings.bikesAt, defaults: S.settings.defaults, tombs: S.settings.tombs,
      putTrack: t => db.putTrack(t), delTrack: id => db.delTrack(id),
      setBikes: async (b, at, def) => { S.bikes = b; S.settings.bikesAt = at; S.settings.defaults = def; await db.setKV('bikes', b); },
    });
    S.tracks = await db.allTracks();
    S.settings.lastSync = Date.now(); await saveSettings();
    S.syncMsg = `Synchronisé : ${r.down} reçue${r.down > 1 ? 's' : ''}, ${r.up} envoyée${r.up > 1 ? 's' : ''}, ${r.del} supprimée${r.del > 1 ? 's' : ''}.`;
    if (!silent || r.down || r.del) render(!!r.down);
  } catch (e) { S.syncMsg = 'Échec : ' + e.message; if (!silent) render(); }
}

/* ---------- Vues ---------- */

const opt = (v, label, cur) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(label)}</option>`;
const sel = (attr, cur, options, id) => `<select ${attr} id="${id}">${options.map(o => opt(o[0], o[1], cur)).join('')}</select>`;
const typeOpts = () => Object.entries(TYPES).map(([k, T]) => [k, T.label]);

function cardHtml(t, extra = '') {
  const lv = LEVELS[levelOf(t)], d = fromMe(t);
  return `<li><button class="card" data-act="open" data-id="${t.id}" style="--tc:${TYPES[t.type].color}">
    <span class="ttl">${esc(t.name)}</span>
    <span class="sub">${TYPES[t.type].label} · ${esc(t.sector)}${t.date ? ' · ' + frDate(t.date) : ''}</span>
    <span class="nums"><span><b>${fr(t.stats.km, 1)}</b> km</span><span><b>${fr(t.stats.dplus)}</b> m D+</span><span><b>${fmtDur(durOf(t))}</b></span></span>
    <span class="foot"><span class="pill" style="--lc:${lv.color}">${lv.label}</span>${t.status === 'afaire' ? '<span class="tag">À faire</span>' : ''}${d != null ? `<span class="tag">à ${fr(d, d < 10 ? 1 : 0)} km de vous</span>` : ''}${extra}</span>
  </button></li>`;
}

function viewList() {
  const f = S.f, list = visible();
  const sectors = [...new Set(S.tracks.map(t => t.sector))].sort((a, b) => a.localeCompare(b, 'fr'));
  const chip = (v, label, color) => `<button class="chip" data-act="ftype" data-v="${v}" aria-pressed="${f.type === v}" style="--tc:${color}">${label}</button>`;
  return `<div class="ph"><h1>Mes sorties</h1><span class="count">${list.length} sur ${S.tracks.length}</span><button class="btn primary" data-act="import">Importer des GPX</button></div>
  <div class="chips">${chip('', 'Toutes', 'var(--muted)')}${Object.entries(TYPES).map(([k, T]) => chip(k, T.label, T.color)).join('')}</div>
  <div class="filters">
    ${sel('data-f="sector" aria-label="Secteur"', f.sector, [['', 'Tous les secteurs'], ...sectors.map(s => [s, s])], 'f-sector')}
    ${sel('data-f="km" aria-label="Distance"', f.km, [['', 'Toutes distances'], ['0-20', 'Moins de 20 km'], ['20-35', '20 à 35 km'], ['35-50', '35 à 50 km'], ['50+', 'Plus de 50 km']], 'f-km')}
    ${sel('data-f="dp" aria-label="Dénivelé"', f.dp, [['', 'Tous dénivelés'], ['0-400', 'Moins de 400 m'], ['400-800', '400 à 800 m'], ['800-1200', '800 à 1 200 m'], ['1200+', 'Plus de 1 200 m']], 'f-dp')}
    ${sel('data-f="dur" aria-label="Durée"', f.dur, [['', 'Toutes durées'], ['0-1.5', 'Moins de 1 h 30'], ['1.5-2.5', '1 h 30 à 2 h 30'], ['2.5-4', '2 h 30 à 4 h'], ['4+', 'Plus de 4 h']], 'f-dur')}
    ${sel('data-f="diff" aria-label="Difficulté"', f.diff, [['', 'Toutes difficultés'], ...LEVELS.map((l, i) => [i, l.label])], 'f-diff')}
    ${sel('data-f="sort" aria-label="Tri"', f.sort, [['date', 'Tri : plus récentes'], ['km', 'Tri : distance'], ['dp', 'Tri : dénivelé'], ['name', 'Tri : nom'], ...(S.pos ? [['near', 'Tri : proximité']] : [])], 'f-sort')}
  </div>
  ${!S.tracks.length ? `<div class="empty"><p><b>Aucune sortie pour l'instant.</b></p><p class="muted">Importez vos fichiers GPX exportés de Garmin Connect ou de Strava, ou reçus d'amis. Sur ordinateur, vous pouvez aussi les glisser sur cette page.</p><button class="btn primary" data-act="import">Importer des GPX</button></div>`
    : !list.length ? `<div class="empty"><p class="muted">Aucune sortie ne correspond à ces filtres.</p><button class="btn" data-act="resetf">Effacer les filtres</button></div>`
    : `<ul class="cards">${list.map(t => cardHtml(t)).join('')}</ul>`}`;
}

function profileSvg(t) {
  if (t.stats.dplus == null) return '';
  const W = 600, H = 150, l = 38, r = 8, top = 16, bot = 22;
  const c = cumKm(t.pts), km = c[c.length - 1];
  let lo = Infinity, hi = -Infinity; for (const p of t.pts) { lo = Math.min(lo, p[2]); hi = Math.max(hi, p[2]); }
  lo = Math.floor(lo / 50) * 50; hi = Math.max(Math.ceil(hi / 50) * 50, lo + 50);
  const x = d => l + d / km * (W - l - r), y = e => top + (hi - e) / (hi - lo) * (H - top - bot);
  const line = t.pts.map((p, i) => `${i ? 'L' : 'M'}${x(c[i]).toFixed(1)} ${y(p[2]).toFixed(1)}`).join('');
  const color = TYPES[t.type].color, mid = (lo + hi) / 2;
  const kmStep = km > 60 ? 20 : km > 25 ? 10 : 5; let ticks = '';
  for (let d = 0; d <= km; d += kmStep) ticks += `<text x="${x(d)}" y="${H - 6}" text-anchor="middle">${d}</text>`;
  return `<div class="profile" id="profile"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Profil altimétrique">
    ${[lo, mid, hi].map(e => `<line x1="${l}" x2="${W - r}" y1="${y(e)}" y2="${y(e)}" stroke="var(--line)"/><text x="${l - 5}" y="${y(e) + 4}" text-anchor="end">${Math.round(e)}</text>`).join('')}
    <path d="${line}L${x(km)} ${y(lo)}L${x(0)} ${y(lo)}Z" fill="${color}" opacity=".18"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    ${ticks}<text x="${W - r}" y="11" text-anchor="end">altitude en m, distance en km</text>
    <g id="cursor" visibility="hidden"><line y1="${top}" y2="${H - bot}" stroke="var(--ink)"/><text class="tip" y="11"></text></g>
  </svg></div>`;
}

function bindProfile(t) {
  const box = $('#profile'); if (!box) return;
  const svg = box.querySelector('svg'), cur = svg.querySelector('#cursor'), W = 600, l = 38, r = 8;
  const c = cumKm(t.pts), km = c[c.length - 1];
  const move = ev => {
    const b = svg.getBoundingClientRect(), px = (ev.clientX - b.left) / b.width * W;
    const d = Math.max(0, Math.min(km, (px - l) / (W - l - r) * km));
    let i = 0; while (i < c.length - 1 && c[i] < d) i++;
    const x = l + c[i] / km * (W - l - r);
    cur.setAttribute('visibility', 'visible'); cur.querySelector('line').setAttribute('x1', x); cur.querySelector('line').setAttribute('x2', x);
    const tip = cur.querySelector('text'); tip.textContent = `km ${fr(c[i], 1)} · ${Math.round(t.pts[i][2])} m`;
    tip.setAttribute('x', Math.min(Math.max(x, l + 50), W - 190)); tip.setAttribute('text-anchor', 'middle');
    if (!hoverMarker) hoverMarker = L.circleMarker([0, 0], { radius: 7, color: '#fff', weight: 3, fillColor: '#14231f', fillOpacity: 1, interactive: false }).addTo(trackLayer);
    hoverMarker.setLatLng([t.pts[i][0], t.pts[i][1]]);
  };
  box.addEventListener('pointermove', move); box.addEventListener('pointerdown', move);
}

function viewDetail(t) {
  const st = t.stats, lv = levelOf(t), T = TYPES[t.type], p0 = t.pts[0], ll = `${p0[0]},${p0[1]}`;
  const sectors = [...new Set(S.tracks.map(x => x.sector))];
  const bikes = S.bikes.filter(b => b.type === t.type).concat(S.bikes.filter(b => b.type !== t.type));
  return `<button class="back" data-act="close">‹ Toutes les sorties</button>
  <input class="title-input" type="text" id="d-name" data-d="name" value="${esc(t.name)}" aria-label="Nom de la sortie">
  <p class="muted small">${t.date ? frDate(t.date) + ' · ' : ''}${st.loop ? 'Boucle' : 'Aller simple (arrivée différente du départ)'}${!t.typeSure ? ' · type à confirmer' : ''}</p>
  <div class="stats">
    <div><b>${fr(st.km, 1)} km</b><span>Distance</span></div>
    <div><b>${fr(st.dplus)} m</b><span>Dénivelé positif</span></div>
    <div><b>${fmtDur(durOf(t))}</b><span>${st.mov ? 'Temps de déplacement' : 'Durée estimée'}</span></div>
    <div><b>${fr(st.dminus)} m</b><span>Dénivelé négatif</span></div>
    <div><b>${fr(st.eleMin)} – ${fr(st.eleMax)}</b><span>Altitude min – max (m)</span></div>
    <div><b>${st.maxGrade != null ? st.maxGrade + ' %' : '—'}</b><span>Pente max sur 100 m</span></div>
  </div>
  ${profileSvg(t)}
  <h2>Envoyer vers le GPS</h2>
  <div class="row"><button class="btn primary" data-act="share">Envoyer vers Garmin / partager</button><button class="btn" data-act="dl">Télécharger le .GPX</button></div>
  <h2>Point de départ</h2>
  <div class="box"><p><b>${esc(t.startLabel || t.sector)}</b></p><p class="muted small">GPS : ${p0[0].toFixed(5)}, ${p0[1].toFixed(5)}</p>
    <div class="row"><a class="btn" href="https://maps.apple.com/?daddr=${ll}&dirflg=d" target="_blank" rel="noopener">Plans</a><a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${ll}" target="_blank" rel="noopener">Google Maps</a><a class="btn" href="https://waze.com/ul?ll=${ll}&navigate=yes" target="_blank" rel="noopener">Waze</a></div></div>
  <h2>Classement</h2>
  <div class="grid2">
    <div class="field"><label for="d-type">Type de sortie</label>${sel('data-d="type"', t.type, typeOpts(), 'd-type')}</div>
    <div class="field"><label for="d-sector">Secteur</label><input type="text" id="d-sector" data-d="sector" value="${esc(t.sector)}" list="sectors"><datalist id="sectors">${sectors.map(s => `<option value="${esc(s)}">`).join('')}</datalist></div>
    <div class="field"><label for="d-diff">Difficulté</label>${sel('data-d="diff"', t.diff ?? '', [['', `Calculée : ${LEVELS[difficulty(t.type, st.km, st.dplus)].label}`], ...LEVELS.map((l, i) => [i, l.label])], 'd-diff')}</div>
    <div class="field"><label for="d-status">Statut</label>${sel('data-d="status"', t.status, [['fait', 'Déjà faite'], ['afaire', 'À faire']], 'd-status')}</div>
  </div>
  ${T.bike ? `<div class="field"><label for="d-bike">Vélo utilisé</label>${sel('data-d="bikeId"', t.bikeId || '', [['', S.bikes.length ? 'Non renseigné' : 'Aucun vélo enregistré (rubrique Vélos)'], ...bikes.map(b => [b.id, `${b.name} (${TYPES[b.type].label})`])], 'd-bike')}</div>` : ''}
  <div class="field"><label for="d-notes">Notes (état du terrain, passages techniques…)</label><textarea id="d-notes" data-d="notes">${esc(t.notes)}</textarea></div>
  <p><span class="pill" style="--lc:${LEVELS[lv].color}">${LEVELS[lv].label}</span></p>
  <button class="btn danger" data-act="del">Supprimer cette sortie</button>`;
}

function viewIdeas() {
  const i = S.idea, res = S.ideaRes;
  return `<div class="ph"><h1>Trouve-moi une sortie</h1></div>
  <p class="muted">Indiquez le temps dont vous disposez ou la distance voulue : l'application cherche dans vos sorties celles qui s'en approchent le plus.</p>
  <div class="box">
    <div class="grid2">
      <div class="field"><label for="i-type">Pratique</label>${sel('data-i="type"', i.type, [['', 'Toutes'], ...typeOpts()], 'i-type')}</div>
      <div class="field"><label for="i-mode">Je raisonne en</label>${sel('data-i="mode"', i.mode, [['dur', 'Temps disponible'], ['km', 'Distance et dénivelé']], 'i-mode')}</div>
      ${i.mode === 'dur' ? `<div class="field"><label for="i-dur">Temps disponible (heures)</label><input type="number" id="i-dur" data-i="dur" min="0.5" max="12" step="0.25" value="${i.dur}"></div>`
        : `<div class="field"><label for="i-km">Distance (km)</label><input type="number" id="i-km" data-i="km" min="1" max="300" value="${i.km}"></div>
           <div class="field"><label for="i-dp">Dénivelé (m, facultatif)</label><input type="number" id="i-dp" data-i="dp" min="0" max="6000" step="50" value="${esc(i.dp)}"></div>`}
    </div>
    <label class="check"><input type="checkbox" id="i-near" data-i="near"${i.near ? ' checked' : ''}> Départ à moins de <input type="number" id="i-radius" data-i="radius" min="1" max="300" value="${i.radius}" style="width:74px" aria-label="Rayon en km"> km de ma position</label>
    <p style="margin-top:12px"><button class="btn primary block" data-act="idea">Chercher</button></p>
  </div>
  ${res ? (res.length ? `<h2>Les plus proches de votre demande</h2><ul class="cards">${res.map(r => cardHtml(r.t, `<span class="tag">${r.why}</span>`)).join('')}</ul>` : `<div class="empty"><p class="muted">Aucune sortie ne convient. Élargissez la pratique ou le rayon.</p></div>`) : ''}
  <p class="muted small" style="margin-top:16px">À venir : la création de nouvelles boucles depuis votre position, sur les chemins et sentiers.</p>`;
}

function findIdeas() {
  const i = S.idea;
  if (i.near && !S.pos) { toast('Touchez d\'abord le bouton de localisation sur la carte.'); locate(); }
  let list = S.tracks.filter(t => !i.type || t.type === i.type);
  if (i.near && S.pos) list = list.filter(t => fromMe(t) <= +i.radius);
  S.ideaRes = list.map(t => {
    if (i.mode === 'dur') { const d = durOf(t) / 3600, gap = d - +i.dur; return { t, s: Math.abs(gap) / +i.dur, why: Math.abs(gap) < 0.1 ? 'pile dans le temps' : `${gap > 0 ? '+' : '−'} ${fmtDur(Math.abs(gap) * 3600)}` }; }
    const gk = t.stats.km - +i.km, gd = i.dp ? (t.stats.dplus || 0) - +i.dp : 0;
    return { t, s: Math.abs(gk) / +i.km + (i.dp ? Math.abs(gd) / +i.dp : 0), why: `${gk >= 0 ? '+' : '−'} ${fr(Math.abs(gk), 1)} km${i.dp ? `, ${gd >= 0 ? '+' : '−'} ${fr(Math.abs(gd))} m` : ''}` };
  }).sort((a, b) => a.s - b.s).slice(0, 5);
  render();
}

const BIKE_FIELDS = [['brand', 'Marque'], ['model', 'Modèle'], ['year', 'Année'], ['frame', 'Taille du cadre'], ['wheels', 'Roues'], ['tyres', 'Pneus (modèle, section)'],
  ['pressure', 'Pression habituelle'], ['drivetrain', 'Transmission'], ['suspension', 'Suspensions'], ['brakes', 'Freins'], ['weight', 'Poids']];

function bikeTotals(b) {
  const ts = S.tracks.filter(t => t.bikeId === b.id && t.status !== 'afaire');
  return { n: ts.length, km: ts.reduce((s, t) => s + t.stats.km, 0), dp: ts.reduce((s, t) => s + (t.stats.dplus || 0), 0), ts };
}

function viewBikes() {
  if (S.editBike) return viewBikeForm();
  const bikeTypes = Object.entries(TYPES).filter(([, T]) => T.bike);
  return `<div class="ph"><h1>Mes vélos</h1><button class="btn primary" data-act="newbike">Ajouter un vélo</button></div>
  ${S.bikes.length ? `<ul class="cards">${S.bikes.map(b => { const k = bikeTotals(b), def = S.settings.defaults[b.type] === b.id;
    return `<li><button class="card" data-act="editbike" data-id="${b.id}" style="--tc:${TYPES[b.type].color}">
      <span class="ttl">${esc(b.name)}</span><span class="sub">${TYPES[b.type].label}${[b.brand, b.model, b.year].filter(Boolean).length ? ' · ' + esc([b.brand, b.model, b.year].filter(Boolean).join(' ')) : ''}</span>
      <span class="nums"><span><b>${fr(k.km)}</b> km</span><span><b>${fr(k.dp)}</b> m D+</span><span><b>${k.n}</b> sortie${k.n > 1 ? 's' : ''}</span></span>
      <span class="foot">${def ? `<span class="tag">Par défaut en ${TYPES[b.type].label}</span>` : ''}</span></button></li>`; }).join('')}</ul>`
    : `<div class="empty"><p><b>Aucun vélo enregistré.</b></p><p class="muted">Créez une fiche par vélo, puis choisissez celui utilisé par défaut pour chaque pratique.</p></div>`}
  <h2>Vélo par défaut</h2>
  <div class="box">${bikeTypes.map(([k, T]) => `<div class="field"><label for="def-${k}">${T.label}</label>${sel(`data-def="${k}"`, S.settings.defaults[k] || '', [['', 'Aucun'], ...S.bikes.filter(b => b.type === k).map(b => [b.id, b.name])], 'def-' + k)}</div>`).join('')}
    <p class="muted small">À l'import, chaque sortie reçoit le vélo par défaut de son type. Vous pouvez le changer sur la fiche de la sortie.</p></div>`;
}

function viewBikeForm() {
  const isNew = S.editBike === 'new', b = isNew ? { type: 'vtt', maint: [] } : S.bikes.find(x => x.id === S.editBike), k = isNew ? null : bikeTotals(b);
  const bikeTypes = Object.entries(TYPES).filter(([, T]) => T.bike).map(([key, T]) => [key, T.label]);
  return `<button class="back" data-act="closebike">‹ Tous les vélos</button>
  <div class="ph"><h1>${isNew ? 'Nouveau vélo' : esc(b.name)}</h1></div>
  ${k ? `<div class="stats"><div><b>${fr(k.km)} km</b><span>Parcourus</span></div><div><b>${fr(k.dp)} m</b><span>Dénivelé positif</span></div><div><b>${k.n}</b><span>Sorties</span></div></div>` : ''}
  <div class="grid2">
    <div class="field"><label for="b-name">Nom du vélo</label><input type="text" id="b-name" data-b="name" value="${esc(b.name || '')}" placeholder="Ex. : mon tout-suspendu"></div>
    <div class="field"><label for="b-type">Pratique</label>${sel('data-b="type"', b.type, bikeTypes, 'b-type')}</div>
    ${BIKE_FIELDS.map(([key, label]) => `<div class="field"><label for="b-${key}">${label}</label><input type="text" id="b-${key}" data-b="${key}" value="${esc(b[key] || '')}"></div>`).join('')}
  </div>
  <div class="field"><label for="b-notes">Notes</label><textarea id="b-notes" data-b="notes">${esc(b.notes || '')}</textarea></div>
  <div class="row"><button class="btn primary" data-act="savebike">Enregistrer</button>${isNew ? '' : '<button class="btn danger" data-act="delbike">Supprimer ce vélo</button>'}</div>
  ${isNew ? '' : `<h2>Carnet d'entretien</h2><div class="box">
    ${(b.maint || []).length ? b.maint.slice().sort((x, y) => y.date.localeCompare(x.date)).map(m => {
      const since = k.ts.filter(t => (t.date || '') >= m.date).reduce((s, t) => s + t.stats.km, 0);
      return `<div class="maint"><span><b>${esc(m.label)}</b><br><span class="muted small">${frDate(m.date)} · ${fr(since)} km depuis</span></span><button class="btn" data-act="delmaint" data-id="${m.id}" aria-label="Supprimer">Retirer</button></div>`; }).join('')
      : '<p class="muted small">Notez ici un changement de chaîne, de plaquettes ou de pneus : l\'application affichera les kilomètres parcourus depuis.</p>'}
    <div class="grid2" style="margin-top:10px"><div class="field"><label for="m-label">Intervention</label><input type="text" id="m-label" placeholder="Ex. : chaîne neuve"></div><div class="field"><label for="m-date">Date</label><input type="date" id="m-date" value="${new Date().toISOString().slice(0, 10)}"></div></div>
    <button class="btn" data-act="addmaint">Ajouter au carnet</button></div>`}`;
}

function viewSettings() {
  const g = S.settings.gh;
  return `<div class="ph"><h1>Réglages</h1></div>
  <h2>Synchronisation entre iPhone et Mac</h2>
  <div class="box">
    <p class="muted small">Vos sorties et vos vélos sont enregistrés sur cet appareil. Pour les retrouver sur vos autres appareils, indiquez un dépôt GitHub <b>privé</b> et une clé d'accès personnelle limitée à ce dépôt.</p>
    <div class="grid2"><div class="field"><label for="g-owner">Compte GitHub</label><input type="text" id="g-owner" data-g="owner" value="${esc(g.owner)}" autocapitalize="off" autocomplete="off"></div>
    <div class="field"><label for="g-repo">Dépôt privé</label><input type="text" id="g-repo" data-g="repo" value="${esc(g.repo)}" placeholder="vtt-gps-donnees" autocapitalize="off" autocomplete="off"></div></div>
    <div class="field"><label for="g-token">Clé d'accès (elle reste sur cet appareil)</label><input type="password" id="g-token" data-g="token" value="${esc(g.token)}" autocomplete="off"></div>
    <button class="btn primary" data-act="sync">Synchroniser maintenant</button>
    <p class="small" style="margin-top:8px">${esc(S.syncMsg || (S.settings.lastSync ? 'Dernière synchronisation : ' + new Date(S.settings.lastSync).toLocaleString('fr-FR') : 'Pas encore synchronisé.'))}</p>
  </div>
  <h2>Sauvegarde</h2>
  <div class="box"><p class="muted small">Un seul fichier contient toutes vos sorties et vos vélos. Rangez-le dans OneDrive, par exemple.</p>
    <div class="row"><button class="btn" data-act="backup">Tout sauvegarder</button><button class="btn" data-act="restore">Restaurer une sauvegarde</button></div></div>
  <h2>Installer sur l'iPhone</h2>
  <div class="box"><p class="muted small">Dans Safari, touchez le bouton Partager puis « Sur l'écran d'accueil ». L'application s'ouvre ensuite comme une application classique.</p></div>
  <p class="muted small">VTT-GPS version 1 · ${S.tracks.length} sortie${S.tracks.length > 1 ? 's' : ''} sur cet appareil. Le point de départ de chaque sortie importée est envoyé au service de géocodage d'OpenStreetMap pour trouver sa commune.</p>`;
}

function render(fit) {
  const t = S.sel && S.tracks.find(x => x.id === S.sel);
  if (S.sel && !t) S.sel = null;
  document.body.dataset.tab = S.tab; document.body.classList.toggle('detail', !!t);
  for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-current', String(!t && b.dataset.tab === S.tab));
  const panel = $('#panel');
  panel.innerHTML = t ? viewDetail(t) : S.tab === 'idees' ? viewIdeas() : S.tab === 'velos' ? viewBikes() : S.tab === 'reglages' ? viewSettings() : viewList();
  if (fit) panel.scrollTop = 0;
  setTimeout(() => { map.invalidateSize(); drawTracks(fit); if (t) bindProfile(t); }, 0);
}

function openTrack(id) { S.sel = id; render(true); }

/* ---------- Événements ---------- */

const ACTIONS = {
  import: () => $('#file').click(),
  open: el => openTrack(el.dataset.id),
  close: () => { S.sel = null; if (S.tab === 'carte') S.tab = 'sorties'; render(true); },
  ftype: el => { S.f.type = el.dataset.v; render(true); },
  resetf: () => { S.f = { type: '', sector: '', km: '', dp: '', dur: '', diff: '', sort: S.f.sort }; render(true); },
  locate,
  share: () => shareTrack(S.tracks.find(t => t.id === S.sel)),
  dl: () => { const f = gpxFile(S.tracks.find(t => t.id === S.sel)); download(f, f.name); },
  del: async () => {
    const t = S.tracks.find(x => x.id === S.sel);
    if (!confirm(`Supprimer « ${t.name} » ? Cette suppression est définitive.`)) return;
    S.tracks = S.tracks.filter(x => x !== t); S.settings.tombs[t.id] = Date.now();
    await db.delTrack(t.id); await saveSettings(); scheduleSync(); S.sel = null; render(true);
  },
  idea: findIdeas,
  newbike: () => { S.editBike = 'new'; render(); },
  editbike: el => { S.editBike = el.dataset.id; render(); },
  closebike: () => { S.editBike = null; render(); },
  savebike: async () => {
    const data = {}; for (const el of document.querySelectorAll('[data-b]')) data[el.dataset.b] = el.value.trim();
    if (!data.name) return toast('Donnez un nom à ce vélo.');
    if (S.editBike === 'new') {
      const b = { id: uid(), maint: [], ...data }; S.bikes.push(b);
      if (!S.settings.defaults[b.type]) {
        // Premier vélo de cette pratique : il devient le vélo par défaut, y compris pour les sorties déjà importées sans vélo.
        S.settings.defaults[b.type] = b.id;
        for (const t of S.tracks) if (t.type === b.type && !t.bikeId) { t.bikeId = b.id; await saveTrack(t); }
      }
    } else {
      const b = S.bikes.find(x => x.id === S.editBike);
      if (b.type !== data.type && S.settings.defaults[b.type] === b.id) delete S.settings.defaults[b.type];
      Object.assign(b, data);
    }
    await saveBikes(); S.editBike = null; toast('Vélo enregistré.'); render();
  },
  delbike: async () => {
    const b = S.bikes.find(x => x.id === S.editBike);
    if (!confirm(`Supprimer la fiche « ${b.name} » ? Les sorties restent, sans vélo associé.`)) return;
    S.bikes = S.bikes.filter(x => x !== b);
    for (const k in S.settings.defaults) if (S.settings.defaults[k] === b.id) delete S.settings.defaults[k];
    for (const t of S.tracks) if (t.bikeId === b.id) { t.bikeId = null; await saveTrack(t); }
    await saveBikes(); S.editBike = null; render();
  },
  addmaint: async () => {
    const b = S.bikes.find(x => x.id === S.editBike), label = $('#m-label').value.trim(), date = $('#m-date').value;
    if (!label || !date) return toast('Indiquez l\'intervention et sa date.');
    (b.maint ||= []).push({ id: uid(), label, date }); await saveBikes(); render();
  },
  delmaint: async el => { const b = S.bikes.find(x => x.id === S.editBike); b.maint = b.maint.filter(m => m.id !== el.dataset.id); await saveBikes(); render(); },
  sync: () => doSync(false),
  backup,
  restore: () => $('#restore').click(),
};

document.addEventListener('click', e => {
  const tab = e.target.closest('#tabs button');
  if (tab) { S.tab = tab.dataset.tab; S.sel = null; S.editBike = null; return render(true); }
  const el = e.target.closest('[data-act]');
  if (el && ACTIONS[el.dataset.act]) ACTIONS[el.dataset.act](el);
});

document.addEventListener('change', async e => {
  const el = e.target, d = el.dataset;
  if (el.id === 'file') { const files = [...el.files]; el.value = ''; return importFiles(files); }
  if (el.id === 'restore') { const f = el.files[0]; el.value = ''; return f && restore(f); }
  if (d.f) { S.f[d.f] = el.value; return render(true); }
  if (d.i) { S.idea[d.i] = el.type === 'checkbox' ? el.checked : el.value; if (d.i === 'mode' ) render(); return; }
  if (d.g) { S.settings.gh[d.g] = el.value.trim(); return saveSettings(); }
  if (d.def) { if (el.value) S.settings.defaults[d.def] = el.value; else delete S.settings.defaults[d.def]; return saveBikes(); }
  if (d.d) {
    const t = S.tracks.find(x => x.id === S.sel); if (!t) return;
    let v = el.value;
    if (d.d === 'diff') v = v === '' ? null : +v;
    if (d.d === 'bikeId') v = v || null;
    if (d.d === 'name' || d.d === 'sector') { v = v.trim(); if (!v) { el.value = t[d.d]; return; } }
    t[d.d] = v;
    if (d.d === 'type') { t.typeSure = true; t.bikeId = TYPES[v].bike ? (S.settings.defaults[v] || null) : null; }
    await saveTrack(t);
    if (d.d !== 'notes' && d.d !== 'name') render(); else drawTracks();
  }
});

// Glisser-déposer de fichiers GPX sur la page (ordinateur).
let dragDepth = 0;
addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); if (e.dataTransfer?.files?.length) importFiles([...e.dataTransfer.files]); });

/* ---------- Démarrage ---------- */

(async function start() {
  try {
    S.tracks = await db.allTracks();
    S.bikes = (await db.getKV('bikes')) || [];
    const s = await db.getKV('settings'); if (s) S.settings = { ...S.settings, ...s, gh: { ...S.settings.gh, ...(s.gh || {}) } };
  } catch (e) { toast('Le stockage local est indisponible (navigation privée ?). Vos sorties ne seront pas conservées.'); }
  initMap(); render(true);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (S.settings.gh.token && navigator.onLine) doSync(true);
})();
