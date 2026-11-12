// Synchronisation de la bibliothèque avec un dépôt GitHub privé.
// Contenu du dépôt : index.json (sommaire, vélos) et traces/<id>.json (une sortie par fichier).

const API = 'https://api.github.com';

function b64e(str) {
  const b = new TextEncoder().encode(str); let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64d(b64) {
  const s = atob(b64.replace(/\s/g, '')), b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return new TextDecoder().decode(b);
}

async function gh(cfg, method, path, body) {
  const r = await fetch(`${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`, {
    method, cache: 'no-store',
    headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 404 && method === 'GET') return null;
  if (!r.ok) {
    const e = new Error(r.status === 401 ? 'Clé GitHub refusée. Vérifiez-la dans les réglages.'
      : r.status === 404 ? 'Dépôt introuvable. Vérifiez le nom et les droits de la clé.'
      : r.status === 403 ? 'Accès refusé par GitHub. La clé doit autoriser « Contents : lecture et écriture ».'
      : `GitHub a répondu ${r.status}.`);
    e.status = r.status; throw e;
  }
  return r.json();
}

async function put(cfg, path, obj, sha, message) {
  const body = { message, content: b64e(JSON.stringify(obj)) };
  if (sha) body.sha = sha;
  try { return (await gh(cfg, 'PUT', path, body)).content.sha; }
  catch (e) {
    if (e.status !== 409 && e.status !== 422) throw e;
    const cur = await gh(cfg, 'GET', path);          // le fichier a changé ailleurs : reprendre sa version
    if (cur) body.sha = cur.sha; else delete body.sha;
    return (await gh(cfg, 'PUT', path, body)).content.sha;
  }
}

/**
 * L = { tracks, bikes, bikesAt, defaults, tombs, putTrack(t), delTrack(id), setBikes(bikes, at, defaults) }
 * Renvoie { down, up, del }.
 */
export async function syncNow(cfg, L) {
  const file = await gh(cfg, 'GET', 'index.json');
  const idx = file ? JSON.parse(b64d(file.content)) : { v: 1, tracks: {}, bikes: [], bikesAt: 0, defaults: {} };
  const out = { down: 0, up: 0, del: 0 }; let dirty = !file;
  const local = new Map(L.tracks.map(t => [t.id, t]));

  // 1. Ce qui est plus récent sur GitHub descend sur l'appareil.
  for (const [id, e] of Object.entries(idx.tracks)) {
    const lt = local.get(id), tomb = L.tombs[id];
    if (e.d) { if (lt && lt.updatedAt <= e.u) { await L.delTrack(id); local.delete(id); out.del++; } continue; }
    if (tomb && tomb >= e.u) continue;
    if (!lt || lt.updatedAt < e.u) {
      const f = await gh(cfg, 'GET', `traces/${id}.json`);
      if (f) { const t = JSON.parse(b64d(f.content)); await L.putTrack(t); local.set(id, t); out.down++; }
    }
  }
  // 2. Les suppressions faites sur l'appareil partent vers GitHub.
  for (const [id, ts] of Object.entries(L.tombs)) {
    const e = idx.tracks[id];
    if (e && !e.d && ts >= e.u) {
      if (e.sha) { try { await gh(cfg, 'DELETE', `traces/${id}.json`, { message: 'Suppression d\'une sortie', sha: e.sha }); } catch (_) { /* déjà supprimé */ } }
      idx.tracks[id] = { u: ts, d: 1 }; dirty = true; out.del++;
    }
  }
  // 3. Ce qui est plus récent sur l'appareil monte vers GitHub.
  for (const t of local.values()) {
    const e = idx.tracks[t.id];
    if (e && !e.d && e.u >= t.updatedAt) continue;
    if (e && e.d && e.u >= t.updatedAt) continue;
    const sha = await put(cfg, `traces/${t.id}.json`, t, e && !e.d ? e.sha : null, `Sortie : ${t.name}`);
    idx.tracks[t.id] = { u: t.updatedAt, sha }; dirty = true; out.up++;
  }
  // 4. Vélos et vélos par défaut : la version la plus récente l'emporte.
  if ((idx.bikesAt || 0) > (L.bikesAt || 0)) await L.setBikes(idx.bikes || [], idx.bikesAt, idx.defaults || {});
  else if ((L.bikesAt || 0) > (idx.bikesAt || 0)) { idx.bikes = L.bikes; idx.bikesAt = L.bikesAt; idx.defaults = L.defaults; dirty = true; }

  if (dirty) await put(cfg, 'index.json', idx, file && file.sha, 'Mise à jour de la bibliothèque');
  return out;
}
