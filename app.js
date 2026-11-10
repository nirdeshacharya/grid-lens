/* Grid Lens. Every figure on the page is fetched at load time from a public API;
   nothing is hard-coded or sampled. Sources:
   - SSEN Distribution open data (CKAN datastore)   https://data.ssen.co.uk
   - NESO Carbon Intensity API (regional)           https://carbonintensity.org.uk
   - Open-Meteo forecast API (wind at outage sites) https://open-meteo.com
   - postcodes.io (postcode and place lookup)       https://postcodes.io */
const CKAN = 'https://data-api.ssen.co.uk/api/3/action/';
const RES = {
  outages: 'd0ddd2de-30eb-49fc-a93e-f0044d507aac',   // Real Time Outage
  headroom: '52e9a305-ad90-4c81-9175-20a40ef57894',  // Headroom Dashboard Data
  lct: 'd8a481db-5f11-4849-8751-0186b9be5571',       // Low carbon technologies per primary
  ecr: 'bbae6797-364a-4b2d-a01a-8395e21bee76',       // Embedded Capacity Register, 1 MW and above
  areas: '8ef1172d-f3db-473a-9e46-9ae2d15fad9e',     // SEPD primary supply areas (primary number -> name)
  hvNorth: '245d5825-7d83-4d17-a2c5-04b473b9b408',   // NaFIRS HV faults, SHEPD
  hvSouth: 'f0d9d3fe-6739-4700-a699-f227b4e1de41',   // NaFIRS HV faults, SEPD
};
// SSEN republishes these two as a new, month-named resource, so the ids above are only a fallback:
// at load the newest matching CSV in each dataset is looked up and used instead.
const MONTHLY = {
  headroom: ['generation-availability-and-network-capacity', /headroom dashboard data/i],
  ecr: ['embedded_capacity_register', /ECR Part 1 - 1MW/i],
};
async function resolveLatest() {
  await Promise.all(Object.entries(MONTHLY).map(async ([key, [pkg, re]]) => {
    try {
      const res = (await getJSON(`${CKAN}package_show?id=${pkg}`)).result.resources
        .filter(r => r.datastore_active && /csv/i.test(r.format) && re.test(r.name))
        .sort((a, b) => String(b.last_modified || b.created).localeCompare(String(a.last_modified || a.created)));
      if (res[0]) RES[key] = res[0].id;
    } catch { /* keep the pinned id */ }
  }));
}
const PAGE = 32000; // CKAN's maximum rows per request

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${new URL(url).hostname} returned ${r.status}`);
  return r.json();
}
async function fetchAll(resource, fields) {
  let out = [], offset = 0, total = Infinity;
  while (offset < total) {
    const u = new URL(CKAN + 'datastore_search');
    u.searchParams.set('resource_id', resource);
    u.searchParams.set('limit', PAGE);
    u.searchParams.set('offset', offset);
    if (fields) u.searchParams.set('fields', fields.join(','));
    const j = (await getJSON(u)).result;
    out = out.concat(j.records);
    total = j.total;
    offset += PAGE;
    if (!j.records.length) break;
  }
  return out;
}

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const fmt = (n, d = 0) => n == null ? 'n/a' : n.toLocaleString('en-GB', { maximumFractionDigits: d, minimumFractionDigits: d });
const compact = n => n == null ? 'n/a' : Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const norm = s => String(s || '').toUpperCase().replace(/\b(PRIMARY|BSP|GSP)\b/g, '').replace(/[^A-Z0-9]/g, '');
const title = s => String(s || '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const km = (a, b, c, d) => { // haversine distance
  const R = 6371, p = Math.PI / 180, x = Math.sin((c - a) * p / 2), y = Math.sin((d - b) * p / 2);
  return 2 * R * Math.asin(Math.sqrt(x * x + Math.cos(a * p) * Math.cos(c * p) * y * y));
};
const when = s => s ? new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'not given';
const day = s => s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const hm = d => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const RAG = { Green: ['--good', '●'], Amber: ['--warn', '▲'], Red: ['--crit', '■'] }; // SSEN's own status; shape repeats the colour
const rag = r => RAG[r] ? `<span class="rag"><i style="color:var(${RAG[r][0]})">${RAG[r][1]}</i>${r}</span>` : '<span class="rag">No status</span>';

/* ---------- charts ---------- */
function hbar(rows, { unit = '', color = '--s1', d = 0 } = {}) {
  if (!rows.length) return '<p class="small">Nothing to show.</p>';
  const max = Math.max(...rows.map(r => r.value), 1e-9);
  return `<div class="hbar">${rows.map(r => `
    <div class="lab${r.click ? ' link' : ''}" ${r.click ? `data-go="${esc(r.click)}"` : ''} title="${esc(r.label)}">${esc(r.label)}</div>
    <div class="trk" data-tip="${esc(r.label)}\n${fmt(r.value, d)}${unit}${r.tip ? '\n' + esc(r.tip) : ''}"><div class="bar" style="width:${r.value / max * 100}%;background:var(${r.color || color})"></div></div>
    <div class="val">${r.value >= 1e5 ? compact(r.value) : fmt(r.value, d)}${unit}</div>`).join('')}</div>`;
}
function cols(rows, names) { // stacked columns: rows = [{label, a, b}]
  const max = Math.max(...rows.map(r => r.a + (r.b || 0)), 1);
  return `<div class="cols">${rows.map(r => `<div class="col" data-tip="${esc(r.label)}\n${names[0]}: ${fmt(r.a)}${names[1] ? `\n${names[1]}: ${fmt(r.b)}` : ''}">
      <i style="height:${r.a / max * 100}%"></i>${r.b ? `<i class="b" style="height:${r.b / max * 100}%"></i>` : ''}</div>`).join('')}</div>
    <div class="colx">${rows.map(r => `<span>${esc(String(r.label).slice(-2))}</span>`).join('')}</div>`;
}
function lineChart(pts, yMax, unit) { // pts = [{t: Date, v}] at even spacing
  const W = 392, H = 120, L = 30, B = 16, w = W - L, h = H - B - 6, n = pts.length;
  const x = i => L + i / (n - 1) * w, y = v => 6 + h - v / yMax * h;
  const ticks = pts.map((p, i) => [p, i]).filter(([p]) => p.t.getMinutes() === 0 && p.t.getHours() % 12 === 0);
  return `<svg class="line" viewBox="0 0 ${W} ${H}" role="img" aria-label="Forecast over the next 48 hours">
    ${[0, yMax / 2, yMax].map(v => `<line class="grid" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 5}" y="${y(v) + 3}" text-anchor="end">${fmt(v)}</text>`).join('')}
    ${ticks.map(([p, i]) => `<text x="${x(i)}" y="${H - 2}" text-anchor="middle">${p.t.getHours() === 0 ? p.t.toLocaleDateString('en-GB', { weekday: 'short' }) : '12:00'}</text>`).join('')}
    <path class="ln" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('')}"/>
    ${pts.map((p, i) => `<rect class="hit" x="${x(i) - w / n / 2}" y="0" width="${w / n}" height="${H - B}" data-tip="${p.t.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm(p.t)}\n${fmt(p.v)} ${unit}${p.label ? ' · ' + p.label : ''}"/>`).join('')}</svg>`;
}
const tip = $('#tip');
document.addEventListener('mousemove', e => {
  const t = e.target.closest?.('[data-tip]');
  if (!t) { tip.hidden = true; return; }
  tip.textContent = t.dataset.tip; tip.hidden = false;
  tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = (e.clientY + 14) + 'px';
});

/* ---------- state ---------- */
const S = {
  tab: 'capacity', mode: 'demand', types: { GSP: true, BSP: true, Primary: true },
  meta: {}, subs: [], subByKey: new Map(), subByPk: new Map(), lctByNrn: new Map(), nrnByKey: new Map(), sepdName: new Map(), sepdMin: Infinity,
  outages: [], gens: [], genStatus: 'all', flex: null, flexCheck: null, areas: null, areasOn: false, faults: null, relArea: 'all', relExc: true, selected: null, search: null, carbon: null, carbonFw: null,
};
const src = (...keys) => `<p class="src">${keys.map(k => S.meta[k] ? `<b>${esc(S.meta[k].name)}</b>, SSEN, updated ${day(S.meta[k].modified)}` : '').filter(Boolean).join('<br>')}</p>`;

/* ---------- map ---------- */
const dark = matchMedia('(prefers-color-scheme: dark)');
const map = L.map('map', { preferCanvas: true }).setView([54.6, -3.2], 6);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 18 }).addTo(map);
dark.addEventListener('change', () => drawMap());
const layers = { flex: L.layerGroup(), areas: L.layerGroup().addTo(map), subs: L.layerGroup().addTo(map), outages: L.layerGroup(), gens: L.layerGroup(), pin: L.layerGroup().addTo(map) };
const SEQ = ['#cde2fb', '#93bff0', '#5a9ae0', '#2a78d6', '#174f96'];
const GEN_CAT = { Solar: '--s2', Wind: '--s1', Storage: '--s3', Hydro: '--s7', Other: '--na' };
// Substation tiers get their own marker shape: square = grid supply point, diamond = bulk supply point, circle = primary.
const TIER = { GSP: { shape: 'square', r: 6.5, name: 'Grid supply point' }, BSP: { shape: 'diamond', r: 6, name: 'Bulk supply point' }, Primary: { shape: 'circle', r: 4.5, name: 'Primary' } };
L.Canvas.include({
  _updateShape(layer) {
    if (!this._drawing || layer._empty()) return;
    const p = layer._point, ctx = this._ctx, r = Math.max(layer._radius, 1), shape = layer.options.shape;
    ctx.beginPath();
    if (shape === 'square') ctx.rect(p.x - r, p.y - r, 2 * r, 2 * r);
    else if (shape === 'diamond') { const d = r * 1.3; ctx.moveTo(p.x, p.y - d); ctx.lineTo(p.x + d, p.y); ctx.lineTo(p.x, p.y + d); ctx.lineTo(p.x - d, p.y); ctx.closePath(); }
    else ctx.arc(p.x, p.y, r, 0, Math.PI * 2, false);
    this._fillStroke(ctx, layer);
  },
});
const ShapeMarker = L.CircleMarker.extend({ _updatePath() { this._renderer._updateShape(this); } });
const glyph = t => `<svg class="glyph" viewBox="0 0 12 12" aria-hidden="true">${{ square: '<rect x="1.5" y="1.5" width="9" height="9"/>', diamond: '<path d="M6 .5 11.5 6 6 11.5 .5 6z"/>', circle: '<circle cx="6" cy="6" r="3.6"/>' }[TIER[t].shape]}</svg>`;
const box = pos => { const c = L.control({ position: pos }); c.onAdd = () => L.DomUtil.create('div', 'mapbox'); return c.addTo(map); };
const legend = box('bottomleft'), carbonBox = box('topright');
carbonBox.getContainer().hidden = true;
carbonBox.getContainer().addEventListener('click', () => $('[data-tab=carbon]').click());
const sw = (c, round) => `<span class="${round ? 'dot' : 'sq'}" style="background:${c.startsWith('--') ? `var(${c})` : c}"></span>`;

function drawMap() {
  const show = { capacity: 'subs', reliability: 'subs', carbon: 'subs', outages: 'outages', generators: 'gens', flexibility: 'flex' }[S.tab];
  for (const k of ['subs', 'outages', 'gens', 'flex']) k === show ? layers[k].addTo(map) : layers[k].remove();
  const ring = css('--panel');
  let key = '';
  layers.areas.clearLayers();
  if (show === 'subs') {
    layers.subs.clearLayers();
    const rel = S.tab === 'reliability' && S.faults ? relStats() : null;
    const areasShown = S.areasOn && S.areas && S.tab !== 'carbon' && (S.tab === 'reliability' || S.types.Primary);
    if (areasShown) drawAreas(rel, ring);
    for (const s of S.subs) {
      let color, r = TIER[s.type].r, t;
      if (S.tab === 'reliability') {
        const st = rel?.byPk.get(s.pk);
        if (!st || st.perCust == null) continue;
        color = SEQ[st.q]; r = 5 + st.q;
        t = `${esc(s.name)}<br>${fmt(st.perCust, 1)} customer-minutes lost per customer per year`;
      } else {
        if (!S.types[s.type]) continue;
        const d = S.mode === 'demand', st = d ? s.dRag : s.gRag, h = d ? s.dh : s.gh;
        color = css(RAG[st]?.[0] || '--na');
        t = `${esc(s.name)} · ${TIER[s.type].name.toLowerCase()}<br>${d ? 'Demand' : 'Generation'} headroom ${h == null ? 'not given' : fmt(h, 1) + (d ? ' MVA' : ' MW')} · ${esc(st)}`;
      }
      const small = areasShown && s.type === 'Primary'; // the shaded area carries the value, so the primary shrinks to a locator dot
      new ShapeMarker([s.lat, s.lon], { shape: TIER[s.type].shape, radius: small ? 2.5 : r, color: ring, weight: small ? 1 : 1.5, fillColor: color, fillOpacity: .92 }).bindTooltip(t).on('click', () => selectSub(s)).addTo(layers.subs);
    }
    key = S.tab === 'reliability'
      ? `<b>Minutes lost per customer per year</b>fewer ${SEQ.map(c => sw(c)).join('')} more`
      : `<b>${S.mode === 'demand' ? 'Demand' : 'Generation'} headroom status</b>${Object.entries(RAG).map(([k, v]) => `${sw(v[0], 1)}${k}`).join(' &nbsp; ')}<br>${Object.keys(TIER).filter(t => S.types[t]).map(t => `${glyph(t)}${TIER[t].name}`).join(' &nbsp; ')}`;
  }
  if (show === 'outages') {
    layers.outages.clearLayers();
    for (const o of S.outages) {
      const color = css(o.planned ? '--s1' : '--crit'), op = o.done ? .35 : 1;
      const t = `${esc(o.postcode || 'Outage')} · ${o.planned ? 'Planned' : 'Unplanned'}${o.voltage ? ' ' + esc(o.voltage) : ''}${o.done ? ' · restored' : ''}`;
      if (o.shape) L.geoJSON(o.shape, { style: { color, weight: 2, opacity: op, fillOpacity: .2 * op } }).bindTooltip(t).on('click', () => selectOutage(o)).addTo(layers.outages);
      L.circleMarker([o.lat, o.lon], { radius: 7, color: ring, weight: 2, fillColor: color, fillOpacity: op }).bindTooltip(t).on('click', () => selectOutage(o)).addTo(layers.outages);
    }
    key = `<b>Outages</b>${sw('--crit', 1)}Unplanned &nbsp; ${sw('--s1', 1)}Planned<br>Faded once supply is restored`;
  }
  if (show === 'gens') {
    layers.gens.clearLayers();
    for (const g of S.gens) {
      if (g.lat == null || (S.genStatus !== 'all' && g.status !== S.genStatus)) continue;
      L.circleMarker([g.lat, g.lon], { radius: Math.max(3.5, Math.min(16, 2.5 + Math.sqrt(g.mw) * 1.4)), color: ring, weight: 1.5, fillColor: css(GEN_CAT[g.cat]), fillOpacity: g.status === 'connected' ? .9 : .4 })
        .bindTooltip(`${esc(g.site)}<br>${g.cat} · ${fmt(g.mw, 1)} MW · ${g.status === 'connected' ? 'connected' : 'accepted, not yet connected'}`)
        .on('click', () => selectGen(g)).addTo(layers.gens);
    }
    key = `<b>Generation, 1 MW and above</b>${Object.entries(GEN_CAT).map(([k, v]) => `${sw(v, 1)}${k}`).join(' &nbsp; ')}<br>Sized by MW · faded if not yet connected`;
  }
  if (show === 'flex') {
    layers.flex.clearLayers();
    const violet = css('--s7');
    for (const z of S.flex?.zones || []) {
      const live = z.reqs.length > 0, color = live ? violet : css('--na');
      const t = `${esc(z.name)} flexibility zone<br>${live ? `${z.reqs.length} service windows this week` : 'No day-ahead tender this week'}`;
      if (S.areasOn && S.areas) for (const a of S.areas) if (z.subs.some(s => s.pk === a.pk))
        L.geoJSON(a.geom, { style: { color: ring, weight: 1, opacity: .7, fillColor: color, fillOpacity: .4 } }).bindTooltip(t, { sticky: true }).addTo(layers.areas);
      for (const s of z.subs) new ShapeMarker([s.lat, s.lon], { shape: 'circle', radius: live ? 6.5 : 4.5, color: ring, weight: 1.5, fillColor: color, fillOpacity: .95 })
        .bindTooltip(`${esc(s.name)}<br>${t}`).on('click', () => selectSub(s)).addTo(layers.flex);
    }
    key = `<b>Flexibility zones</b>${sw('--s7', 1)}Primary in a zone tendering this week &nbsp; ${sw('--na', 1)}Listed zone, no tender`;
  }
  if ((show === 'subs' || show === 'flex') && S.areasOn && S.tab !== 'carbon') key += S.areas ? (show === 'flex' ? '<br>Shaded: supply areas of the primaries in each zone' : `<br>Shaded: area served by each primary, as modelled by SSEN<br>${sw('--na')} no matching record`) : S.areasErr ? '' : '<br>Loading supply-area boundaries, about 42 MB…';
  legend.getContainer().innerHTML = key;
}

/* ---------- supply areas (loaded on demand) ---------- */
function drawAreas(rel, ring) {
  for (const a of S.areas) {
    const sub = S.subByPk.get(a.pk), nm = esc(title(a.name));
    let color = css('--na'), op = .22, t;
    if (S.tab === 'reliability') {
      const st = rel?.byPk.get(a.pk);
      if (st && st.perCust != null) { color = SEQ[st.q]; op = .55; t = `${nm} supply area<br>${fmt(st.perCust, 1)} customer-minutes lost per customer per year`; }
      else t = `${nm} supply area<br>Not in the ranking`;
    } else if (sub) {
      const d = S.mode === 'demand', st = d ? sub.dRag : sub.gRag, h = d ? sub.dh : sub.gh;
      color = css(RAG[st]?.[0] || '--na'); op = .38;
      t = `${nm} supply area<br>${d ? 'Demand' : 'Generation'} headroom ${h == null ? 'not given' : fmt(h, 1) + (d ? ' MVA' : ' MW')} · ${esc(st)}`;
    } else t = `${nm} supply area<br>No matching headroom record`;
    L.geoJSON(a.geom, { style: { color: ring, weight: 1, opacity: .7, fillColor: color, fillOpacity: op } }).bindTooltip(t, { sticky: true }).on('click', () => sub && selectSub(sub)).addTo(layers.areas);
  }
}
// Boundaries are far more detailed than a screen can show; thin each ring to roughly 40 m and drop slivers.
function thin(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates, out = [];
  for (const poly of polys) {
    const rings = [];
    for (let i = 0; i < poly.length; i++) {
      const pts = L.LineUtil.simplify(poly[i].map(c => ({ x: c[0] * .6, y: c[1] })), .0004);
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      const tiny = pts.length < 4 || Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys) < .002;
      if (tiny && i === 0) break;   // outer ring gone: drop the whole polygon
      if (tiny) continue;           // a hole too small to see
      rings.push(pts.map(p => [+(p.x / .6).toFixed(5), +p.y.toFixed(5)]));
    }
    if (rings.length) out.push(rings);
  }
  return out.length ? { type: 'MultiPolygon', coordinates: out } : geom;
}
async function loadAreas() {
  if (S.areas) return;
  if (!S.areasP) S.areasP = (async () => {
    const files = (await getJSON(`${CKAN}package_show?id=primary-supply-areas`)).result.resources.filter(r => /geojson/i.test(r.format));
    if (!files.length) throw new Error('SSEN no longer lists GeoJSON boundary files');
    const sets = await Promise.all(files.map(r => getJSON(r.url)));
    const areas = [];
    sets.forEach((g, i) => {
      const area = /SHEPD/i.test(files[i].name) ? 'SHEPD' : 'SEPD';
      for (const f of g.features) {
        const n = parseInt(f.properties.primary_nrn_split, 10); if (!f.geometry || !Number.isFinite(n)) continue;
        const name = f.properties.primary_name_2025;
        areas.push({ pk: `${area}:${n}`, name, geom: thin(f.geometry) });
        const sub = S.subByKey.get(norm(name) + '|Primary'); // the boundary files also carry number and name together
        if (sub && sub.areaCode === area && sub.nrn == null) { sub.nrn = n; sub.pk = `${area}:${n}`; S.subByPk.set(sub.pk, sub); }
      }
    });
    S.meta.areasGeo = { name: 'Primary Supply Area Boundaries (GeoJSON)', modified: files.map(r => r.last_modified).sort().at(-1) };
    S.areas = areas;
  })().catch(e => { S.areasP = null; throw e; });
  return S.areasP;
}
const viewSeg = () => `<div class="row"><span class="small">Map shows</span><div class="seg" data-view>${[[false, 'Substations'], [true, 'Substations and supply areas']].map(([v, l]) => `<button aria-pressed="${S.areasOn === v}" data-v="${v ? 1 : ''}">${l}</button>`).join('')}</div></div>${S.areasErr ? `<p class="err">The boundary files did not load: ${esc(S.areasErr)}.</p>` : ''}`;
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-view] button'); if (!b) return;
  S.areasOn = !!b.dataset.v; S.areasErr = null;
  const rerender = () => { if (S.tab === 'capacity') renderCapacity(); if (S.tab === 'reliability') renderReliability(); if (S.tab === 'flexibility') renderFlex(); drawMap(); };
  rerender();
  if (S.areasOn && !S.areas) {
    try { await loadAreas(); } catch (err) { S.areasErr = err.message; S.areasOn = false; }
    rerender();
  }
});

/* ---------- detail ---------- */
const detail = $('#detail');
function showDetail(html) {
  detail.innerHTML = `<button class="close">Close</button>${html}`;
  detail.hidden = false; $('#scroll').scrollTop = 0;
}
detail.addEventListener('click', e => { if (e.target.closest('.close')) { detail.hidden = true; S.selected = null; layers.pin.clearLayers(); } });
function pin(lat, lon, zoom) {
  layers.pin.clearLayers();
  L.circleMarker([lat, lon], { radius: 13, color: css('--signal'), weight: 3, fill: false, interactive: false }).addTo(layers.pin);
  if (zoom) map.flyTo([lat, lon], Math.max(map.getZoom(), zoom), { duration: .6 });
}
const kv = rows => `<dl class="kv">${rows.filter(r => r[1] != null && r[1] !== '' && r[1] !== 'N/A').map(r => `<dt>${r[0]}</dt><dd>${esc(r[1])}</dd>`).join('')}</dl>`;

function selectSub(s, zoom = 0) {
  S.selected = s; pin(s.lat, s.lon, zoom);
  const lct = s.nrn != null ? S.lctByNrn.get(s.nrn) : null;
  const works = [s.upWorks && `Upstream${s.upDate ? `, due ${s.upDate}` : ''}: ${s.upWorks}`, s.subWorks && `At this site${s.subDate ? `, due ${s.subDate}` : ''}: ${s.subWorks}`].filter(Boolean);
  let html = `<h2>${esc(s.name)}</h2><div class="id">${esc(s.type)} · ${esc(s.kv)} kV · ${esc(s.area)}</div>
  <div class="pair">
    <div><div class="lab">Demand headroom</div><div class="big">${s.dh == null ? 'not given' : fmt(s.dh, 1) + ' MVA'}</div>${rag(s.dRag)}<div class="why">${esc(s.dCon || '')}</div></div>
    <div><div class="lab">Generation headroom</div><div class="big">${s.gh == null ? 'not given' : fmt(s.gh, 1) + ' MW'}</div>${rag(s.gRag)}<div class="why">${esc(s.gCon || '')}</div></div>
  </div>
  ${works.length ? `<h3>Planned reinforcement</h3><p class="note">${esc(works.join('\n\n'))}</p>` : ''}
  <h3>Loading and ratings</h3>${kv([['Upstream GSP', s.gsp], ['Upstream BSP', s.bsp], ['Transformers', s.tx],
    ['Maximum observed demand', s.maxD != null ? fmt(s.maxD, 1) + ' MVA' : null], ['Minimum observed demand', s.minD != null ? fmt(s.minD, 1) + ' MVA' : null],
    ['Contracted demand, excl. batteries', s.conD != null ? fmt(s.conD, 1) + ' MVA' : null], ['Connected generation', s.genC != null ? fmt(s.genC, 1) + ' MW' : null],
    ['Contracted generation', s.genK != null ? fmt(s.genK, 1) + ' MW' : null], ['Fault level / switchgear rating', s.fl != null && s.fr != null ? `${fmt(s.fl, 1)} / ${fmt(s.fr, 1)} kA` : null],
    ['Threshold for transmission assessment', s.tia]])}
  ${s.comment ? `<p class="note" style="margin-top:8px">${esc(s.comment)}</p>` : ''}`;
  if (lct) {
    const order = ['EV', 'HP', 'PV', 'PV/Battery', 'Battery'], lab = { EV: 'EV chargers', HP: 'Heat pumps', PV: 'Solar PV', 'PV/Battery': 'Solar with battery', Battery: 'Batteries' };
    html += `<h3>Low-carbon installations among ${fmt(lct.customers)} customers</h3>` +
      hbar(order.filter(k => lct[k]).map(k => ({ label: lab[k], value: lct[k].n, tip: `${fmt(lct[k].kw)} kW in total · ${fmt(lct[k].n / lct.customers * 100, 1)}% of customers` })));
  } else if (s.type === 'Primary') html += `<h3>Low-carbon installations</h3><p class="small">This substation could not be matched to SSEN's low-carbon technology dataset.</p>`;
  if (s.type === 'Primary') html += `<div id="sub-faults">${S.faults ? subFaultsHtml(s) : `<h3>HV fault record</h3><button class="btn ghost" id="load-faults">Load faults since 2015</button>`}</div>`;
  showDetail(html);
}
detail.addEventListener('click', async e => {
  if (e.target.id !== 'load-faults') return;
  $('#sub-faults').innerHTML = '<h3>HV fault record</h3><div class="loading">Fetching fault records from SSEN…</div>';
  try { await loadFaults(); } catch (err) { $('#sub-faults').innerHTML = `<p class="err">${esc(err.message)}</p>`; return; }
  if (S.selected && $('#sub-faults')) $('#sub-faults').innerHTML = subFaultsHtml(S.selected);
});
function subFaultsHtml(s) {
  const st = s.pk ? relStats(true).byPk.get(s.pk) : null;
  if (!st) return `<h3>HV fault record</h3><p class="small">No fault records could be matched to this substation.</p>`;
  const years = [...st.years.entries()].sort((a, b) => a[0] - b[0]);
  return `<h3>HV fault record: ${fmt(st.n)} faults, ${compact(st.cml)} customer-minutes lost</h3>
    <div class="small">Faults per reporting year</div>${cols(years.map(([y, n]) => ({ label: y, a: n })), ['Faults'])}
    <div class="small" style="margin-top:12px">Main causes, by customer-minutes lost</div>${hbar([...st.causes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, v]) => ({ label: c, value: v })))}`;
}

function selectOutage(o, zoom = 0) {
  S.selected = null; pin(o.lat, o.lon, zoom);
  const near = S.subs.filter(s => s.type === 'Primary').map(s => [km(o.lat, o.lon, s.lat, s.lon), s]).sort((a, b) => a[0] - b[0])[0];
  showDetail(`<h2>${esc(o.postcode || 'Outage')}${o.place ? ', ' + esc(o.place) : ''}</h2>
    <div class="id">${o.planned ? 'Planned' : 'Unplanned'} · ref ${esc(o.id)} · ${esc(o.area)}${o.voltage ? ' · ' + esc(o.voltage) : ''}</div>
    <div style="margin-top:12px">${kv([['SSEN status', o.status], ['Started', when(o.start)], ['Estimated restoration', o.etr ? when(o.etr) : null], ['Restored', o.restored ? when(o.restored) : null],
      ['Wind gusts at site now', o.gust != null ? fmt(o.gust) + ' mph' : null]])}</div>
    ${near ? `<p class="small" style="margin:10px 0 0">Nearest primary substation: <a href="#" data-go="${esc(near[1].key + '|Primary')}">${esc(near[1].name)}</a>, ${fmt(near[0], 1)} km away</p>` : ''}`);
}
function selectGen(g) {
  S.selected = null; pin(g.lat, g.lon);
  showDetail(`<h2>${esc(g.site)}</h2><div class="id">${esc(title(g.tech))} · ${g.status === 'connected' ? 'connected' : 'accepted to connect'}</div>
    <div style="margin-top:12px">${kv([['Registered capacity', fmt(g.mw, 2) + ' MW'], ['Connection voltage', g.kv ? g.kv + ' kV' : null], ['Postcode', g.postcode], ['Primary', title(g.primary)],
      ['Bulk supply point', title(g.bsp)], ['Grid supply point', title(g.gsp)], ['Target energisation', g.target]])}</div>`);
}
document.addEventListener('click', e => { // links that jump to a substation
  const el = e.target.closest('[data-go]'); if (!el) return;
  e.preventDefault();
  const s = S.subByKey.get(el.dataset.go) || S.subByPk.get(el.dataset.go); if (!s) return;
  if (S.tab !== 'capacity' && S.tab !== 'reliability' && S.tab !== 'flexibility') $('[data-tab=capacity]').click();
  selectSub(s, 11);
});

/* ---------- Capacity ---------- */
function renderCapacity() {
  const d = S.mode === 'demand', unit = d ? 'MVA' : 'MW';
  const vis = S.subs.filter(s => S.types[s.type]);
  const n = k => vis.filter(s => (d ? s.dRag : s.gRag) === k).length;
  $('#tab-capacity').innerHTML = `
    <h2>Substation headroom</h2>
    <p class="lede">SSEN's estimate of spare capacity at each grid supply point, bulk supply point and primary substation, with its red, amber or green status.</p>
    <div class="row"><div class="seg" id="mode"><button aria-pressed="${d}" data-m="demand">Demand</button><button aria-pressed="${!d}" data-m="generation">Generation</button></div>
      ${['GSP', 'BSP', 'Primary'].map(t => `<label class="chk"><input type="checkbox" id="type-${t}" data-type="${t}" ${S.types[t] ? 'checked' : ''}>${glyph(t)}${t}</label>`).join('')}</div>
    ${viewSeg()}
    <div class="figs">${['Green', 'Amber', 'Red'].map(k => `<div><b>${fmt(n(k))}</b><span>${rag(k)}<br>${fmt(n(k) / (vis.length || 1) * 100)}% of ${fmt(vis.length)} sites</span></div>`).join('')}</div>
    <form class="finder" id="finder">
      <label for="pc">Find ${d ? 'demand' : 'generation'} capacity near a postcode</label>
      <div class="row" style="margin-bottom:0"><input type="text" id="pc" placeholder="Postcode or district" value="${esc(S.search?.pc || '')}" required>
        <input type="number" id="need" min="0" step="0.1" value="${S.search?.need ?? 1}" aria-label="Capacity needed in ${unit}"><span class="unit">${unit}</span>
        <button class="btn">Search</button></div>
      <div id="finder-out"></div>
    </form>
    <h3>Most headroom, ${unit}</h3>
    ${hbar(vis.filter(s => (d ? s.dh : s.gh) > 0).sort((a, b) => (d ? b.dh - a.dh : b.gh - a.gh)).slice(0, 10).map(s => ({ label: s.name, value: d ? s.dh : s.gh, click: s.key + '|' + s.type, tip: s.area })), { d: 1 })}
    <h3>Constraints cited at ${d ? 'demand' : 'generation'}-constrained sites</h3>
    ${hbar(constraintCounts(vis, d), { color: '--crit' })}
    <p class="small" style="margin-top:8px">Number of sites citing each constraint. A site can cite more than one.</p>
    <p class="small">Headroom at a primary sits behind its upstream bulk and grid supply points, so figures cannot be added together. Treat them as a guide ahead of a formal connection application.</p>
    ${src('headroom', 'lct', 'areasGeo')}`;
  if (S.search) runSearch();
}
function constraintCounts(list, d) {
  const m = new Map();
  for (const s of list) for (const c of String((d ? s.dCon : s.gCon) || '').split('&').map(x => x.trim()).filter(Boolean)) m.set(c, (m.get(c) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
}
$('#tab-capacity').addEventListener('click', e => { const m = e.target.closest('#mode button'); if (m) { S.mode = m.dataset.m; renderCapacity(); drawMap(); } });
$('#tab-capacity').addEventListener('change', e => { if (e.target.dataset.type) { S.types[e.target.dataset.type] = e.target.checked; renderCapacity(); drawMap(); } });
$('#tab-capacity').addEventListener('submit', async e => {
  e.preventDefault();
  const pc = $('#pc').value.trim(), need = num($('#need').value) ?? 0, out = $('#finder-out');
  out.innerHTML = '<div class="loading">Looking up postcode…</div>';
  try {
    const clean = encodeURIComponent(pc.replace(/\s+/g, ''));
    let r = await fetch(`https://api.postcodes.io/postcodes/${clean}`).then(r => r.json());
    if (r.status !== 200) r = await fetch(`https://api.postcodes.io/outcodes/${clean}`).then(r => r.json());
    if (r.status !== 200 || r.result.latitude == null) throw new Error(`“${pc}” is not a postcode postcodes.io recognises.`);
    S.search = { pc: pc.toUpperCase(), need, lat: r.result.latitude, lon: r.result.longitude };
    runSearch(true);
  } catch (err) { out.innerHTML = `<p class="err" style="margin:10px 0 0">${esc(err.message)}</p>`; }
});
function runSearch(fly) {
  const { lat, lon, need } = S.search, d = S.mode === 'demand', unit = d ? 'MVA' : 'MW';
  const all = S.subs.filter(s => S.types[s.type]).map(s => ({ s, dist: km(lat, lon, s.lat, s.lon), h: d ? s.dh : s.gh })).sort((a, b) => a.dist - b.dist);
  const nearest = all[0], out = $('#finder-out');
  if (!nearest || nearest.dist > 60) { out.innerHTML = `<p class="err" style="margin:10px 0 0">${esc(S.search.pc)} is more than 60 km from any SSEN substation, so it is likely served by another network operator.</p>`; return; }
  const hits = all.filter(x => x.h != null && x.h >= need && x.h > 0).slice(0, 6);
  const li = x => `<li data-go="${esc(x.s.key + '|' + x.s.type)}"><div class="top"><span class="nm">${esc(x.s.name)}</span><span>${fmt(x.dist, 1)} km</span></div>
    <div class="sub">${x.h == null ? 'Headroom not given' : fmt(x.h, 1) + ' ' + unit + ' headroom'} · ${rag(d ? x.s.dRag : x.s.gRag)}</div></li>`;
  out.innerHTML = `<h3 style="margin-top:14px">Closest substation to ${esc(S.search.pc)}</h3><ul class="list">${li(nearest)}</ul>
    <h3>Closest with at least ${fmt(need, 1)} ${unit} spare</h3>${hits.length ? `<ul class="list">${hits.map(li).join('')}</ul>` : '<p class="small">No substation of the selected types has that much headroom.</p>'}`;
  if (fly) {
    layers.pin.clearLayers();
    L.circleMarker([lat, lon], { radius: 6, color: css('--ink'), weight: 2, fillColor: css('--signal'), fillOpacity: 1 }).bindTooltip(S.search.pc, { permanent: true, direction: 'top', offset: [0, -6] }).addTo(layers.pin);
    map.flyToBounds(L.latLngBounds([[lat, lon], ...hits.slice(0, 3).map(x => [x.s.lat, x.s.lon]), [nearest.s.lat, nearest.s.lon]]).pad(.3), { duration: .6, maxZoom: 12 });
  }
}

/* ---------- Outages ---------- */
function renderOutages() {
  const o = S.outages, un = o.filter(x => !x.planned), on = un.filter(x => !x.done), done = un.filter(x => x.done), pl = o.filter(x => x.planned);
  $('#outage-count').textContent = on.length || '';
  const li = x => `<li data-o="${esc(x.id)}"><div class="top"><span class="nm">${esc(x.postcode || 'No postcode')}${x.place ? ' · ' + esc(x.place) : ''}</span><span>${esc(x.area)}${x.voltage ? ' ' + esc(x.voltage) : ''}</span></div>
    <div class="sub">Since ${when(x.start)}${x.restored ? ' · restored ' + when(x.restored) : x.done ? ' · marked completed' : x.etr ? ' · restoration expected ' + when(x.etr) : ''}${x.gust != null ? ` · gusts ${fmt(x.gust)} mph` : ''}</div></li>`;
  const sec = (h, list) => list.length ? `<h3>${h}</h3><ul class="list">${list.map(li).join('')}</ul>` : '';
  $('#tab-outages').innerHTML = `<h2>Current outages</h2>
    <p class="lede">SSEN's hourly outage feed${o[0] ? `, as at ${when(o[0].asAt)}` : ''}. An outage counts as restored once SSEN records a restoration time or marks it completed. Checked again every five minutes.</p>
    <div class="figs"><div><b>${on.length}</b><span>unplanned, not yet restored</span></div><div><b>${done.length}</b><span>unplanned, restored</span></div><div><b>${pl.length}</b><span>planned works</span></div></div>
    ${sec('Unplanned, not yet restored', on)}${sec('Unplanned, restored', done)}${sec('Planned works', pl)}
    ${o.length ? '' : '<p>SSEN is reporting no outages.</p>'}
    <p class="src">${S.meta.outages ? `<b>${esc(S.meta.outages.name)}</b>, SSEN, updated ${when(S.meta.outages.modified)}<br>` : ''}Place names from postcodes.io · wind gusts from Open-Meteo</p>`;
}
$('#tab-outages').addEventListener('click', e => {
  const li = e.target.closest('li[data-o]'); if (!li) return;
  const o = S.outages.find(x => x.id === li.dataset.o); if (o) selectOutage(o, 12);
});
async function loadOutages() {
  delete S.meta.outages;
  const [rows] = await Promise.all([fetchAll(RES.outages), loadMeta('outages')]);
  const list = rows.filter(r => r.location_latitude != null).map(r => {
    let shape = null;
    try { if (r.geo_shape) shape = JSON.parse(r.geo_shape.replace(/'/g, '"')); } catch { /* unparseable polygon: the point is still shown */ }
    return { id: r.fault_id, lat: +r.location_latitude, lon: +r.location_longitude, postcode: r.postcode, area: r.licence_area, voltage: r.voltagelevel,
      status: r.status, etr: r.etr, planned: r.planned === 'TRUE', asAt: r.as_at_date, start: r.outage_start_date, restored: r.date_time_of_restoration, done: !!r.date_time_of_restoration || /^completed$/i.test(r.status || ''), shape };
  }).sort((a, b) => String(b.start).localeCompare(String(a.start)));
  S.outages = list;
  const redraw = () => { if (S.outages !== list) return; renderOutages(); if (S.tab === 'outages') drawMap(); };
  redraw();
  if (!list.length) return;
  // Local context for each outage. Both lookups are optional: the list stands without them.
  getJSON('https://api.postcodes.io/postcodes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ geolocations: list.slice(0, 100).map(o => ({ latitude: o.lat, longitude: o.lon, limit: 1, radius: 2000 })) }) })
    .then(j => { j.result.forEach((x, i) => { list[i].place = x.result?.[0]?.admin_district || ''; }); redraw(); }).catch(() => {});
  getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${list.map(o => o.lat.toFixed(3))}&longitude=${list.map(o => o.lon.toFixed(3))}&current=wind_gusts_10m&wind_speed_unit=mph`)
    .then(j => { [].concat(j).forEach((x, i) => { list[i].gust = x.current?.wind_gusts_10m ?? null; }); redraw(); }).catch(() => {});
}

/* ---------- Generation ---------- */
function renderGenerators() {
  const cats = Object.keys(GEN_CAT), sum = (c, st) => S.gens.filter(g => g.cat === c && g.status === st).reduce((a, g) => a + g.mw, 0);
  const tot = st => S.gens.filter(g => g.status === st).reduce((a, g) => a + g.mw, 0);
  const big = S.gens.filter(g => g.status === 'accepted' && g.lat != null).sort((a, b) => b.mw - a.mw).slice(0, 8);
  const unplaced = S.gens.filter(g => g.lat == null).length;
  $('#tab-generators').innerHTML = `<h2>Embedded generation and storage</h2>
    <p class="lede">Every site of 1 MW and above on SSEN's Embedded Capacity Register: what is connected, and what has an accepted offer but is still waiting.</p>
    <div class="row"><div class="seg" id="gstat">${[['all', 'All'], ['connected', 'Connected'], ['accepted', 'Accepted, waiting']].map(([k, l]) => `<button aria-pressed="${S.genStatus === k}" data-s="${k}">${l}</button>`).join('')}</div></div>
    <div class="figs"><div><b>${fmt(tot('connected'))}</b><span>MW connected</span></div><div><b>${fmt(tot('accepted'))}</b><span>MW accepted, not yet connected</span></div><div><b>${fmt(S.gens.length)}</b><span>register entries</span></div></div>
    <h3>Connected, MW</h3>${hbar(cats.map(c => ({ label: c, value: sum(c, 'connected'), color: GEN_CAT[c] })))}
    <h3>Accepted, not yet connected, MW</h3>${hbar(cats.map(c => ({ label: c, value: sum(c, 'accepted'), color: GEN_CAT[c] })))}
    <h3>Largest accepted projects</h3><ul class="list">${big.map(g => `<li data-g="${g.i}"><div class="top"><span class="nm">${esc(g.site)}</span><span>${fmt(g.mw)} MW</span></div><div class="sub">${g.cat}${g.gsp ? ' · ' + esc(title(g.gsp)) : ''}${g.target ? ' · target ' + esc(g.target) : ''}</div></li>`).join('')}</ul>
    <p class="small" style="margin-top:12px">Technology is taken from the register's energy source and conversion fields. ${unplaced ? `${unplaced} entries have no coordinates and are counted here but not mapped.` : ''}</p>
    ${src('ecr')}`;
}
$('#tab-generators').addEventListener('click', e => {
  const b = e.target.closest('#gstat button'); if (b) { S.genStatus = b.dataset.s; renderGenerators(); drawMap(); return; }
  const li = e.target.closest('li[data-g]'); if (li) { const g = S.gens[+li.dataset.g]; selectGen(g); map.flyTo([g.lat, g.lon], 11, { duration: .6 }); }
});
const NA = v => !v || /^DATA NOT/i.test(v) ? '' : String(v).trim();
function genCat(source, tech) {
  const s = `${source} ${tech}`.toUpperCase();
  if (/STORED|STORAGE/.test(s)) return 'Storage';
  if (/SOLAR|PHOTOVOLTAIC/.test(s)) return 'Solar';
  if (/WIND/.test(s)) return 'Wind';
  if (/WATER|HYDRO|TIDAL/.test(s)) return 'Hydro';
  return 'Other';
}

/* ---------- Faults ---------- */
async function loadFaults() {
  if (S.faults) return S.faults;
  if (!S.faultsP) S.faultsP = (async () => {
    const f = ['REPORTING_YEAR', 'CAUSE', 'HV_CUST_MINS_LOST', 'EXCEPTIONAL_EVENT'];
    const [n, s] = await Promise.all([fetchAll(RES.hvNorth, ['PRIMARY_NRN', 'PRIMARY_NAME', ...f]), fetchAll(RES.hvSouth, ['NRN_SOUTH', ...f]), loadMeta('hvNorth'), loadMeta('hvSouth')]);
    const row = (r, area, nrn, name) => ({ area, pk: nrn != null ? `${area}:${nrn}` : null, name, year: r.REPORTING_YEAR, cause: r.CAUSE || 'Not recorded', cml: +r.HV_CUST_MINS_LOST || 0, exc: r.EXCEPTIONAL_EVENT === 'Yes' });
    const north = n.map(r => row(r, 'SHEPD', r.PRIMARY_NRN, r.PRIMARY_NAME));
    // SEPD references are either a 4-digit primary number or primary number + 3-digit feeder.
    const south = s.map(r => {
      const p = r.NRN_SOUTH == null ? null : r.NRN_SOUTH < 10000 ? r.NRN_SOUTH : Math.floor(r.NRN_SOUTH / 1000);
      const ok = p != null && p >= S.sepdMin;
      return row(r, 'SEPD', ok ? p : null, ok ? S.sepdName.get(p) || S.lctByNrn.get(p)?.name || null : null);
    });
    for (const r of n) { // SHEPD fault rows carry number and name together: use them to place substations the other datasets missed
      const k = norm(r.PRIMARY_NAME); if (!k || r.PRIMARY_NRN == null) continue;
      const sub = S.subByKey.get(k + '|Primary');
      if (sub && sub.areaCode === 'SHEPD' && sub.nrn == null) { sub.nrn = r.PRIMARY_NRN; sub.pk = `SHEPD:${sub.nrn}`; S.subByPk.set(sub.pk, sub); }
    }
    S.faults = north.concat(south);
    return S.faults;
  })().catch(e => { S.faultsP = null; throw e; });
  return S.faultsP;
}
function relStats(everything) {
  const rows = S.faults.filter(f => everything || ((S.relArea === 'all' || f.area === S.relArea) && (S.relExc || !f.exc)));
  const byPk = new Map(), years = new Map(), causes = new Map(), yrs = { SEPD: new Set(), SHEPD: new Set() };
  let placed = 0;
  for (const f of rows) {
    yrs[f.area].add(f.year);
    const y = years.get(f.year) || { SEPD: 0, SHEPD: 0 }; y[f.area]++; years.set(f.year, y);
    causes.set(f.cause, (causes.get(f.cause) || 0) + f.cml);
    if (!f.pk) continue;
    placed++;
    let p = byPk.get(f.pk);
    if (!p) byPk.set(f.pk, p = { pk: f.pk, nrn: +f.pk.split(':')[1], name: f.name, area: f.area, n: 0, cml: 0, years: new Map(), causes: new Map() });
    p.n++; p.cml += f.cml; p.years.set(f.year, (p.years.get(f.year) || 0) + 1); p.causes.set(f.cause, (p.causes.get(f.cause) || 0) + f.cml);
  }
  const ranked = [];
  for (const p of byPk.values()) {
    const cust = S.lctByNrn.get(p.nrn)?.customers;
    // Grid sites feed customers who are counted under other primaries, and tiny customer bases give unstable ratios.
    p.perCust = cust >= 200 && p.name && !/\bGRID\b/i.test(p.name) ? p.cml / cust / (yrs[p.area].size || 1) : null;
    if (p.perCust != null) ranked.push(p);
  }
  ranked.sort((a, b) => a.perCust - b.perCust).forEach((p, i) => p.q = Math.min(4, Math.floor(i / ranked.length * 5)));
  return { rows, byPk, years, causes, ranked, placed };
}
async function renderReliability() {
  const el = $('#tab-reliability');
  if (!S.faults) {
    el.innerHTML = `<h2>High-voltage fault record</h2><div class="loading">Fetching fault records from SSEN…</div>`;
    try { await loadFaults(); } catch (e) { el.innerHTML = `<h2>High-voltage fault record</h2><p class="err">The fault data did not load: ${esc(e.message)}. Reload to try again.</p>`; return; }
    if (S.tab === 'reliability') drawMap();
  }
  const st = relStats(), yr = [...st.years.entries()].sort((a, b) => a[0] - b[0]);
  const cml = st.rows.reduce((a, f) => a + f.cml, 0), both = S.relArea === 'all';
  el.innerHTML = `<h2>High-voltage fault record</h2>
    <p class="lede">Planned and unplanned HV interruptions that SSEN reports under the national fault scheme, NaFIRS, for reporting years ${yr[0]?.[0] ?? ''} to ${yr.at(-1)?.[0] ?? ''}. The map shades primaries by customer-minutes lost per customer per year.</p>
    <div class="row"><div class="seg" id="rarea">${[['all', 'Both areas'], ['SEPD', 'South'], ['SHEPD', 'North']].map(([k, l]) => `<button aria-pressed="${S.relArea === k}" data-a="${k}">${l}</button>`).join('')}</div>
      <label class="chk"><input type="checkbox" id="rexc" ${S.relExc ? 'checked' : ''}>Include exceptional events</label></div>
    ${viewSeg()}
    <div class="figs"><div><b>${fmt(st.rows.length)}</b><span>HV incidents</span></div><div><b>${compact(cml)}</b><span>customer-minutes lost</span></div>
      <div><b>${fmt(st.rows.filter(f => f.exc).length / (st.rows.length || 1) * 100, 1)}%</b><span>flagged by SSEN as exceptional events</span></div></div>
    <h3>Incidents per reporting year</h3>
    ${both ? `<div class="key"><span>${sw('--s1', 1)}South (SEPD)</span><span>${sw('--s2', 1)}North (SHEPD)</span></div>` : ''}
    ${cols(yr.map(([y, v]) => both ? { label: y, a: v.SEPD, b: v.SHEPD } : { label: y, a: v[S.relArea] }), both ? ['SEPD', 'SHEPD'] : ['Incidents'])}
    <p class="small" style="margin-top:6px">The first and latest reporting years may be incomplete.</p>
    <h3>Causes, by customer-minutes lost</h3>
    ${hbar([...st.causes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ label, value })))}
    <h3>Most minutes lost per customer per year</h3>
    ${hbar(st.ranked.slice(-10).reverse().map(p => ({ label: title(p.name), value: p.perCust, click: S.subByPk.has(p.pk) ? p.pk : null, tip: `${fmt(p.n)} incidents · ${p.area}` })), { d: 1 })}
    <p class="small" style="margin-top:8px">${fmt(st.placed)} of ${fmt(st.rows.length)} incidents carry a usable primary substation reference. The ranking covers the ${fmt(st.ranked.length)} primaries that also have a customer count of 200 or more in the low-carbon technology dataset, and leaves out grid sites.</p>
    ${src('hvSouth', 'hvNorth', 'lct', 'areas', 'areasGeo')}`;
}
$('#tab-reliability').addEventListener('click', e => { const b = e.target.closest('#rarea button'); if (b) { S.relArea = b.dataset.a; renderReliability(); drawMap(); } });
$('#tab-reliability').addEventListener('change', e => { if (e.target.id === 'rexc') { S.relExc = e.target.checked; renderReliability(); drawMap(); } });

/* ---------- Flexibility (day-ahead tenders) ---------- */
// SSEN publishes these only as Excel workbooks, so they are downloaded and read in the browser.
// Columns are found by their header text, so reordering them will not break this; renaming them will.
const loadScript = url => new Promise((ok, fail) => { const s = document.createElement('script'); s.src = url; s.onload = ok; s.onerror = () => fail(new Error('the spreadsheet reader did not load')); document.head.appendChild(s); });
const xlDate = v => typeof v === 'number' ? new Date(Math.round((v - 25569) * 864e5)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : String(v ?? '');
const xlTime = v => { if (typeof v !== 'number') return String(v ?? ''); const m = Math.round(v * 1440); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
async function loadFlex() {
  if (S.flex) return;
  if (!S.flexP) S.flexP = (async () => {
    if (!window.XLSX) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    const all = (await getJSON(`${CKAN}package_show?id=flexibility-day-ahead-bidding`)).result.resources.filter(r => /xlsx/i.test(r.format));
    const newest = re => all.filter(r => re.test(r.name)).sort((a, b) => String(b.last_modified || b.created).localeCompare(String(a.last_modified || a.created)))[0];
    const tender = newest(/tender requirements/i);
    if (!tender) throw new Error('SSEN has not published a current tender workbook');
    const lists = [newest(/postcode list.*SEPD/i), newest(/postcode list.*SHEPD/i)].filter(Boolean);
    const sheets = async (r, re) => {
      const wb = XLSX.read(await (await fetch(r.url)).arrayBuffer());
      const name = wb.SheetNames.find(n => re.test(n));
      return { wb, rows: name ? XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null }) : [] };
    };
    const table = (rows, first) => { // -> { rows after the header, col(regex) -> column index }
      const hi = rows.findIndex(r => first.test(String(r[0] ?? '')));
      if (hi < 0) throw new Error('the workbook layout has changed');
      const hdr = rows[hi].map(h => String(h ?? '').replace(/\s+/g, ' '));
      return { body: rows.slice(hi + 1).filter(r => r.some(v => v != null)), col: re => hdr.findIndex(h => re.test(h)) };
    };
    const zones = new Map(), zone = (name, area) => { const k = name.trim(); if (!zones.has(k)) zones.set(k, { name: k, area, reqs: [], primaries: new Set(), postcodes: 0 }); return zones.get(k); };
    const areaOf = v => /SHEPD/i.test(v) ? 'SHEPD' : 'SEPD';

    const t = await sheets(tender, /tender/i), tt = table(t.rows, /licence area/i);
    const c = { area: tt.col(/licence area/i), zone: tt.col(/constraint/i), product: tt.col(/product type/i), bidEnd: tt.col(/bidding ends/i), kv: tt.col(/voltage/i), dir: tt.col(/direction/i),
      mw: tt.col(/estimated volume/i), gbp: tt.col(/estimated budget/i), date: tt.col(/period start/i), ws: tt.col(/window start/i), we: tt.col(/window end/i), hrs: tt.col(/utilisation hours/i) };
    if (c.zone < 0 || c.date < 0) throw new Error('the tender sheet layout has changed');
    for (const r of tt.body) {
      if (!r[c.zone]) continue;
      zone(String(r[c.zone]), areaOf(r[c.area])).reqs.push({ product: r[c.product], dir: r[c.dir], kv: r[c.kv], bidEnd: r[c.bidEnd], mw: num(r[c.mw]), gbp: num(r[c.gbp]), sort: +r[c.date] || 0, date: xlDate(r[c.date]), ws: xlTime(r[c.ws]), we: xlTime(r[c.we]), hrs: num(r[c.hrs]) });
    }
    const intro = String(XLSX.utils.sheet_to_json(t.wb.Sheets[t.wb.SheetNames[0]], { header: 1, defval: null })[0]?.[0] ?? '');
    const week = intro.match(/week commencing\s+(.+?)\s+day ahead/i)?.[1] || tender.name.replace(/tender requirements|day ahead markets?/gi, '').trim();

    const pc = new Map();
    for (const f of lists) {
      const pt = table((await sheets(f, /postcode list/i)).rows, /area/i);
      const ci = { area: 0, prim: pt.col(/primary/i), zone: pt.col(/cmz/i), pc: pt.col(/postcode/i) };
      if (ci.zone < 0 || ci.pc < 0) continue;
      for (const r of pt.body) {
        if (!r[ci.zone] || !r[ci.pc]) continue;
        const z = zone(String(r[ci.zone]), areaOf(r[ci.area]));
        const code = String(r[ci.pc]).toUpperCase().replace(/\s+/g, '');
        if (r[ci.prim]) z.primaries.add(String(r[ci.prim]).trim());
        if (!pc.has(code)) { z.postcodes++; pc.set(code, { zone: z.name, primary: r[ci.prim] }); } // the lists repeat some postcodes
      }
    }
    for (const z of zones.values()) { // place each zone on the map through its primaries; a zone with no postcode list is tried by its own name
      const names = z.primaries.size ? [...z.primaries] : [z.name];
      z.subs = names.map(n => S.subByKey.get(norm(n) + '|Primary')).filter(s => s && s.areaCode === z.area);
      z.unplaced = names.filter(n => !S.subByKey.get(norm(n) + '|Primary'));
      z.reqs.sort((a, b) => a.sort - b.sort);
    }
    S.flex = { week, zones: [...zones.values()].sort((a, b) => b.reqs.length - a.reqs.length || a.name.localeCompare(b.name)), pc, files: [tender, ...lists].map(r => ({ name: r.name, modified: r.last_modified })) };
  })().catch(e => { S.flexP = null; throw e; });
  return S.flexP;
}
async function renderFlex() {
  const el = $('#tab-flexibility'), head = '<h2>Day-ahead flexibility tenders</h2>';
  if (!S.flex) {
    el.innerHTML = head + '<div class="loading">Reading SSEN\'s tender workbooks…</div>';
    try { await loadFlex(); } catch (e) { el.innerHTML = head + `<p class="err">The tender workbooks could not be read: ${esc(e.message)}.</p>`; return; }
    if (S.tab === 'flexibility') drawMap();
  }
  const f = S.flex, live = f.zones.filter(z => z.reqs.length), reqs = live.flatMap(z => z.reqs);
  const chk = S.flexCheck;
  el.innerHTML = `${head}
    <p class="lede">The zones and time windows where SSEN plans to buy flexibility a day ahead, for the week commencing ${esc(f.week)}. Providers with a signed agreement bid on SSEN's ElectronConnect platform.</p>
    ${viewSeg()}
    <div class="figs"><div><b>${live.length}</b><span>zones tendering this week</span></div><div><b>${reqs.length}</b><span>service windows</span></div>
      <div><b>£${fmt(reqs.reduce((a, r) => a + (r.gbp || 0), 0))}</b><span>estimated budget, all windows</span></div></div>
    <form class="finder" id="flexcheck">
      <label for="fpc">Is a postcode in a flexibility zone?</label>
      <div class="row" style="margin-bottom:0"><input type="text" id="fpc" placeholder="Full postcode" value="${esc(chk?.pc || '')}" required><button class="btn">Check</button></div>
      ${chk ? `<p style="margin:10px 0 0">${chk.hit ? `${esc(chk.pc)} is on SSEN's list for the <b>${esc(chk.hit.zone)}</b> zone${chk.hit.primary ? `, fed from ${esc(title(chk.hit.primary))}` : ''}. ${f.zones.find(z => z.name === chk.hit.zone)?.reqs.length ? 'That zone is tendering this week.' : 'That zone has no day-ahead tender this week.'}` : `${esc(chk.pc)} is not on SSEN's postcode lists for this round.`}</p>` : ''}
      <p class="small" style="margin:8px 0 0">Checked against ${fmt(f.pc.size)} postcodes SSEN lists as potential areas. SSEN describes the lists as a guide.</p>
    </form>
    ${f.zones.map(z => {
      const r0 = z.reqs[0];
      return `<h3>${esc(z.name)} · ${z.area}</h3>
      ${kv([['Service', r0?.product], ['Direction', r0?.dir], ['Constraint voltage', r0?.kv], ['Postcodes listed', z.postcodes ? fmt(z.postcodes) : 'no list published'],
        ['Primary substations', z.subs.length ? z.subs.map(s => s.name.replace(/ Primary$/, '')).join(', ') : null]])}
      ${z.unplaced.length ? `<p class="small" style="margin:6px 0 0">Not found among SSEN's headroom substations, so not mapped: ${esc(z.unplaced.map(title).join(', '))}.</p>` : ''}
      ${z.subs.length ? `<button class="zone-go" data-zone="${esc(z.name)}">Show on map</button>` : ''}
      ${z.reqs.length ? `<table class="days"><thead><tr><th>Service day</th><th>Window</th><th class="n">Est. MW</th><th class="n">Est. budget</th></tr></thead><tbody>
        ${z.reqs.map(r => `<tr><td>${esc(r.date)}</td><td>${esc(r.ws)}–${esc(r.we)}</td><td class="n">${fmt(r.mw, r.mw < 1 ? 3 : 1)}</td><td class="n">£${fmt(r.gbp)}</td></tr>`).join('')}</tbody></table>` : '<p class="small">No day-ahead tender this week.</p>'}`;
    }).join('')}
    <p class="small" style="margin-top:14px">Volumes are SSEN's maximum estimated requirement and budgets its forecast spend, both published for information only.</p>
    <p class="src">${f.files.map(x => `<b>${esc(x.name)}</b>, SSEN, updated ${day(x.modified)}`).join('<br>')}</p>`;
}
$('#tab-flexibility').addEventListener('submit', e => {
  if (e.target.id !== 'flexcheck') return;
  e.preventDefault();
  const pc = $('#fpc').value.trim().toUpperCase();
  S.flexCheck = { pc, hit: S.flex.pc.get(pc.replace(/\s+/g, '')) || null };
  renderFlex();
});
$('#tab-flexibility').addEventListener('click', e => {
  const b = e.target.closest('[data-zone]'); if (!b) return;
  const z = S.flex.zones.find(x => x.name === b.dataset.zone);
  if (z?.subs.length) map.flyToBounds(L.latLngBounds(z.subs.map(s => [s.lat, s.lon])).pad(.4), { duration: .6, maxZoom: 11 });
});

/* ---------- Carbon ---------- */
const REGIONS = [[12, 'South England', 'SEPD licence area'], [1, 'North Scotland', 'SHEPD licence area']]; // NESO region ids for SSEN's two areas
const CI_COL = { 'very low': '--good', low: '--good', moderate: '--warn', high: '--crit', 'very high': '--crit' };
async function loadCarbon() {
  const j = await getJSON('https://api.carbonintensity.org.uk/regional');
  const d = j.data[0];
  S.carbon = { from: d.from, to: d.to, regions: new Map(d.regions.map(r => [r.regionid, r])) };
  S.carbonFw = null; // refetch the forecast alongside the current reading
  const el = carbonBox.getContainer();
  el.hidden = false; el.title = 'Open the carbon forecast';
  el.innerHTML = `<b>Carbon intensity now</b><div class="carbonbar">${REGIONS.map(([id, nm]) => { const r = S.carbon.regions.get(id); return `<span>${nm} <b>${fmt(r.intensity.forecast)}</b> g/kWh</span>`; }).join('')}</div>`;
  if (S.tab === 'carbon') renderCarbon();
}
async function renderCarbon() {
  const el = $('#tab-carbon');
  if (!S.carbon) { el.innerHTML = '<h2>Carbon intensity of electricity</h2><div class="loading">Fetching from the Carbon Intensity API…</div>'; return; }
  if (!S.carbonFw) {
    el.innerHTML = '<h2>Carbon intensity of electricity</h2><div class="loading">Fetching the 48-hour forecast…</div>';
    try {
      const from = new Date().toISOString().slice(0, 16) + 'Z';
      const res = await Promise.all(REGIONS.map(([id]) => getJSON(`https://api.carbonintensity.org.uk/regional/intensity/${from}/fw48h/regionid/${id}`)));
      S.carbonFw = new Map(res.map((j, i) => [REGIONS[i][0], j.data.data.map(p => ({ t: new Date(p.from), v: p.intensity.forecast, label: p.intensity.index }))]));
    } catch (e) { el.innerHTML = `<h2>Carbon intensity of electricity</h2><p class="err">The forecast did not load: ${esc(e.message)}.</p>`; return; }
  }
  const yMax = Math.max(50, Math.ceil(Math.max(...[...S.carbonFw.values()].flat().map(p => p.v)) / 50) * 50);
  const best = pts => { // lowest two-hour average in the next 24 hours
    let b = null;
    for (let i = 0; i + 4 <= Math.min(48, pts.length); i++) { const v = (pts[i].v + pts[i + 1].v + pts[i + 2].v + pts[i + 3].v) / 4; if (!b || v < b.v) b = { v, t: pts[i].t }; }
    return b;
  };
  el.innerHTML = `<h2>Carbon intensity of electricity</h2>
    <p class="lede">NESO's regional estimate for the two areas SSEN serves, for the half hour from ${hm(new Date(S.carbon.from))}. These are modelled figures, in grams of CO₂ per kWh consumed.</p>
    ${REGIONS.map(([id, nm, sub]) => {
      const r = S.carbon.regions.get(id), pts = S.carbonFw.get(id), b = best(pts);
      const mix = r.generationmix.filter(m => m.perc > 0).sort((a, b) => b.perc - a.perc);
      return `<div class="region"><h3>${nm} · ${sub}</h3>
        <div class="now"><b>${fmt(r.intensity.forecast)}</b><span class="unit">gCO₂/kWh</span><span class="rag"><i style="color:var(${CI_COL[r.intensity.index] || '--na'})">●</i>${esc(title(r.intensity.index))}</span></div>
        <div class="small">Generation mix now, %</div>${hbar(mix.map(m => ({ label: title(m.fuel), value: m.perc })), { d: 1 })}
        <div class="small" style="margin-top:14px">Forecast, next 48 hours, gCO₂/kWh</div>${lineChart(pts, yMax, 'gCO₂/kWh')}
        ${b ? `<p class="small" style="margin-top:6px">Lowest two-hour window in the next 24 hours: ${b.t.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm(b.t)} to ${hm(new Date(+b.t + 72e5))}, averaging ${fmt(b.v)} gCO₂/kWh.</p>` : ''}</div>`;
    }).join('')}
    <p class="src"><b>Carbon Intensity API</b>, National Energy System Operator, regional forecast · both charts share one scale</p>`;
}

/* ---------- tabs and boot ---------- */
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  S.tab = b.dataset.tab; detail.hidden = true; S.selected = null; layers.pin.clearLayers();
  for (const t of document.querySelectorAll('#tabs button')) t.setAttribute('aria-selected', t === b);
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== 'tab-' + S.tab;
  if (S.tab === 'reliability') renderReliability();
  if (S.tab === 'carbon') renderCarbon();
  if (S.tab === 'flexibility') renderFlex();
  drawMap();
});
async function loadMeta(key) { // dataset title and last-modified date, read from the portal rather than typed in here
  if (S.meta[key]) return S.meta[key];
  try { const r = (await getJSON(`${CKAN}resource_show?id=${RES[key]}`)).result; S.meta[key] = { name: r.name + ({ hvNorth: ' (SHEPD)', hvSouth: ' (SEPD)' }[key] || ''), modified: r.last_modified }; } catch { /* the source line is omitted if this fails */ }
  return S.meta[key];
}

async function boot() {
  $('#tab-capacity').innerHTML = '<div class="loading">Fetching network data from SSEN…</div>';
  try {
    await resolveLatest();
    const [head, lct, ecr, areas] = await Promise.all([
      fetchAll(RES.headroom), fetchAll(RES.lct),
      fetchAll(RES.ecr, ['Customer Site', 'Postcode', 'Grid Supply Point', 'Bulk Supply Point', 'Primary', 'Energy Source 1', 'Energy Conversion Technology 1', 'Connection Status',
        'already_connected_registered_capacity__mw_', 'accepted_to_connect_registered_capacity__mw_', 'Target Energisation Date', 'Latitude', 'Longitude', 'point_of_connection__poc__voltage__kv_']),
      fetchAll(RES.areas, ['primary_nrn_split', 'primary_name_2025']),
      ...['headroom', 'lct', 'ecr', 'areas'].map(loadMeta),
    ]);
    // Primary substation numbers are the join key between datasets; names are only used to reach a number.
    for (const r of areas) {
      const n = parseInt(r.primary_nrn_split, 10); if (!Number.isFinite(n)) continue;
      if (!S.sepdName.has(n)) S.sepdName.set(n, r.primary_name_2025);
      S.sepdMin = Math.min(S.sepdMin, n);
      const k = norm(r.primary_name_2025); if (!S.nrnByKey.has(k)) S.nrnByKey.set(k, { nrn: n, area: 'SEPD' });
    }
    for (const r of lct) {
      const e = S.lctByNrn.get(r.PRIMARY_NRN) || { name: r.PRIMARY_NAME, customers: r.TOTAL_CUSTOMERS };
      e[r.LCT] = { n: r.count_LCT, kw: r.capacity__kw_ }; S.lctByNrn.set(r.PRIMARY_NRN, e);
      const k = norm(r.PRIMARY_NAME); if (!S.nrnByKey.has(k)) S.nrnByKey.set(k, { nrn: r.PRIMARY_NRN, area: S.sepdName.has(r.PRIMARY_NRN) ? 'SEPD' : r.PRIMARY_NRN < S.sepdMin ? 'SHEPD' : null });
    }
    S.subs = head.filter(r => r['Location Latitude'] != null && r['Location Longitude'] != null).map(r => ({
      name: r.Substation, key: norm(r.Substation), type: r['Substation Type'], area: r.map___license_area, areaCode: /SEPD/.test(r.map___license_area) ? 'SEPD' : 'SHEPD', kv: r.voltage__kv_,
      lat: +r['Location Latitude'], lon: +r['Location Longitude'], gsp: r['Upstream GSP'], bsp: r['Upstream BSP'], tx: r['Transformer Nameplate Ratings'], comment: r['Substation Comment'], tia: r['TIA Threshold'],
      maxD: num(r.maximum_observed_gross_demand__mva_), minD: num(r.minimum_observed_gross_demand__mva_), conD: num(r.contracted_demand_excl_bess__mva_),
      dh: num(r.estimated_demand_headroom__mva_), dRag: r['Substation Demand RAG Status'], dCon: r['Demand Constraint'],
      genC: num(r.connected_generation__mw_), genK: num(r.contracted_generation__mw_), gh: num(r.estimated_generation_headroom__mw_), gRag: r['Substation Generation RAG Status'], gCon: r['Generation Constraint'],
      fr: num(r.unsafe_3_phase_break_fault_rating__ka_), fl: num(r.unsafe_3_phase_break_fault_level__ka_),
      upWorks: r['Upstream Reinforcement Works'], upDate: r['Upstream Reinforcement Completion Date'], subWorks: r['Substation Reinforcement Works'], subDate: r['Substation Reinforcement Completion Date'],
    }));
    for (const s of S.subs) {
      S.subByKey.set(s.key + '|' + s.type, s);
      if (s.type !== 'Primary') continue;
      const e = S.nrnByKey.get(s.key);
      if (e && (!e.area || e.area === s.areaCode)) { s.nrn = e.nrn; s.pk = `${s.areaCode}:${e.nrn}`; S.subByPk.set(s.pk, s); }
    }
    S.gens = ecr.map((r, i) => {
      const connected = r['Connection Status'] === 'CONNECTED';
      return { i, site: NA(r['Customer Site']) || NA(r.Postcode) || 'Unnamed site', postcode: NA(r.Postcode), gsp: NA(r['Grid Supply Point']), bsp: NA(r['Bulk Supply Point']), primary: NA(r.Primary),
        tech: NA(r['Energy Conversion Technology 1']) || NA(r['Energy Source 1']) || 'Technology not given', cat: genCat(r['Energy Source 1'], r['Energy Conversion Technology 1']),
        status: connected ? 'connected' : 'accepted', mw: num(connected ? r.already_connected_registered_capacity__mw_ : r.accepted_to_connect_registered_capacity__mw_) || 0,
        target: NA(r['Target Energisation Date']), lat: num(r.Latitude), lon: num(r.Longitude), kv: NA(r.point_of_connection__poc__voltage__kv_) };
    });
    $('#asof').textContent = 'fetched ' + hm(new Date());
    renderCapacity(); renderGenerators(); drawMap();
    map.fitBounds(L.latLngBounds(S.subs.map(s => [s.lat, s.lon])).pad(.02), { animate: false });
  } catch (e) {
    $('#tab-capacity').innerHTML = `<h2>Substation headroom</h2><p class="err">SSEN's data did not load: ${esc(e.message)}. Check your connection and reload.</p>`;
    return;
  }
  const outages = () => loadOutages().catch(e => { if (!S.outages.length) $('#tab-outages').innerHTML = `<h2>Current outages</h2><p class="err">The outage feed did not load: ${esc(e.message)}.</p>`; });
  outages(); setInterval(outages, 5 * 60 * 1000);
  const carbon = () => loadCarbon().catch(() => { if (!S.carbon) $('#tab-carbon').innerHTML = '<h2>Carbon intensity of electricity</h2><p class="err">The Carbon Intensity API did not respond.</p>'; });
  carbon(); setInterval(carbon, 15 * 60 * 1000);
}
boot();
