(function(){
  const cfg = window.SHIPWATCH_CONFIG || {};
  const map = L.map('map').setView([48.5, 10.0], 5); // centro UE
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);

  const statusEl = document.getElementById('status');
  const qEl = document.getElementById('q');
  const chkMil = document.getElementById('chk-military');
  const chkIl = document.getElementById('chk-israeli');
  const chkPot = document.getElementById('chk-potential');
  const quickPort = document.getElementById('quick-port');
  const listEl = document.getElementById('result-list');

  const markers = new Map();

  function boundsToBbox(bounds){
    return [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()].join(',');
  }

  function classify(v){
    const shiptype = Number(v.ais_shiptype || v.SHIPTYPE || v.shiptype_code || NaN);
    const flag = (v.flag||'').toUpperCase();
    const mmsi = String(v.mmsi||'');
    const t = (v.type||'').toLowerCase() + ' ' + (v.subtype||v.cargo||'').toLowerCase();

    const isMilitary = shiptype === 35;
    const isIsraeli = flag === 'IL' || mmsi.startsWith('428');
    const isPotential = /(vehicle|pctc|ro-?ro|heavy.?lift|project|multi.?purpose|mpp)/.test(t);

    if (isMilitary) return 'military';
    if (isIsraeli) return 'israeli';
    if (isPotential) return 'potential_arms';
    return null;
  }

  async function fetchShips(){
    const bbox = boundsToBbox(map.getBounds());
    const q = qEl.value.trim();
    const url = new URL(cfg.WORKER_URL + '/api/ships');
    url.searchParams.set('bbox', bbox);
    if (q) url.searchParams.set('q', q);

    statusEl.textContent = 'caricamento…';
    try {
      const resp = await fetch(url.toString(), { headers: { 'X-ShipWatch-Token': cfg.CLIENT_TOKEN } });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();

      const wanted = new Set();
      if (chkMil.checked) wanted.add('military');
      if (chkIl.checked) wanted.add('israeli');
      if (chkPot.checked) wanted.add('potential_arms');

      const toShow = [];
      for(const v of data){
        const bucket = classify(v);
        if (!bucket || !wanted.has(bucket)) continue;
        v._bucket = bucket;
        toShow.push(v);
      }

      renderMarkers(toShow);
      renderList(toShow);
      statusEl.textContent = `mostrate ${toShow.length} navi — ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      statusEl.textContent = 'errore: ' + err.message;
    }
  }

  function renderMarkers(list){
    const keep = new Set();
    for(const v of list){
      const id = String(v.mmsi || v.imo || v.name || Math.random());
      keep.add(id);
      const lat = v.lat || v.position?.lat; const lon = v.lon || v.position?.lon;
      if (!lat || !lon) continue;
      if (markers.has(id)) { markers.get(id).setLatLng([lat,lon]); continue; }
      const m = L.marker([lat,lon]).addTo(map).bindPopup(popupHtml(v));
      markers.set(id, m);
    }
    for(const [id, mk] of markers){ if (!keep.has(id)) { map.removeLayer(mk); markers.delete(id); } }
  }

  function popupHtml(v){
    const lat = (v.lat||v.position?.lat||'').toString().slice(0,8);
    const lon = (v.lon||v.position?.lon||'').toString().slice(0,8);
    const url = v.info_url || (v.name ? `https://www.vesselfinder.com/vessels/${encodeURIComponent(v.name)}` : '#');
    const bucketLabel = v._bucket === 'military' ? 'Militare' : v._bucket === 'israeli' ? 'Bandiera IL/MID 428' : 'Potenziale (RO-RO/HL/MPP)';
    return `<div>
      <b>${v.name || '—'}</b><br/>
      ${bucketLabel}<br/>
      Flag: ${v.flag || '—'} — MMSI: ${v.mmsi || '—'} — IMO: ${v.imo || '—'}<br/>
      Tipo: ${v.type || '—'} — Dest: ${v.destination || '—'}<br/>
      Pos: ${lat}, ${lon}<br/>
      <a href="${url}" target="_blank" rel="noopener">Dettagli</a>
    </div>`;
  }

  function renderList(list){
    listEl.innerHTML = '';
    for(const v of list){
      const li = document.createElement('li');
      li.innerHTML = `<b>${v.name || '—'}</b>
        <div class="muted small">${v._bucket} • Flag ${v.flag || '—'} • MMSI ${v.mmsi || '—'} • IMO ${v.imo || '—'}</div>
        <div>${v.type || '—'} — Dest: ${v.destination || '—'}</div>`;
      li.onclick = () => {
        const lat = v.lat || v.position?.lat; const lon = v.lon || v.position?.lon;
        if (lat && lon) map.setView([lat,lon], 10);
      };
      listEl.appendChild(li);
    }
  }

  document.getElementById('btn-refresh').addEventListener('click', fetchShips);
  [chkMil, chkIl, chkPot].forEach(el => el.addEventListener('change', fetchShips));
  qEl.addEventListener('keydown', e => { if (e.key === 'Enter') fetchShips(); });
  quickPort.addEventListener('change', () => {
    const val = quickPort.value; if (!val) return; const [lat, lon, z] = val.split(',').map(Number); map.setView([lat, lon], z||12); fetchShips();
  });

  fetchShips();
  setInterval(fetchShips, 60000);
})();