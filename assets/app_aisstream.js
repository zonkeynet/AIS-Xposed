// TrackWarships — client WebSocket per il relay Cloudflare Worker
// Il Worker tiene segreta la APIKey AISStream e inoltra frame già normalizzati.
//
// Requisiti HTML (già presenti nel tuo index.html):
//  - Leaflet caricato da CDN
//  - elementi: #map, #status, #q, #chk-military, #chk-israeli, #chk-potential,
//              #quick-port, #btn-reconnect, #result-list

(function () {
  // === CONFIG ===
  const RELAY_URL = "wss://trackwarship.zonkeynet.workers.dev/ws"; // <-- cambia qui se usi altro dominio
  const RESUBSCRIBE_MOVE_THRESHOLD = 0.20;   // ~0.2°: cambia bbox → resubscribe
  const LIST_REFRESH_MS = 1500;              // rinfresca la lista a intervalli

  // === MAPPA ===
  const map = L.map("map", { worldCopyJump: true }).setView([48.5, 10.0], 5); // centro UE
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18 }).addTo(map);

  // === UI ===
  const statusEl = document.getElementById("status");
  const qEl = document.getElementById("q");
  const chkMil = document.getElementById("chk-military");
  const chkIl = document.getElementById("chk-israeli");
  const chkPot = document.getElementById("chk-potential");
  const quickPort = document.getElementById("quick-port");
  const btnReconnect = document.getElementById("btn-reconnect");
  const listEl = document.getElementById("result-list");

  // === STATO ===
  let ws = null;
  let reconnectDelay = 1000; // ms (backoff esponenziale, max 30s)
  let currentBbox = null;    // [south, west, north, east]
  const markers = new Map(); // id -> Leaflet marker
  const objects = new Map(); // id -> ultimo oggetto normalizzato

  // === HELPERS ===
  function getBboxFromMap() {
    const b = map.getBounds();
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();
    return [sw.lat, sw.lng, ne.lat, ne.lng]; // [S W N E]
  }

  function wantedBuckets() {
    const s = new Set();
    if (chkMil.checked) s.add("military");
    if (chkIl.checked) s.add("israeli");
    if (chkPot.checked) s.add("potential_arms");
    return s;
  }

  function matchesText(v) {
    const q = qEl.value.trim().toLowerCase();
    if (!q) return true;
    return (
      (v.name || "").toLowerCase().includes(q) ||
      String(v.mmsi || "").includes(q) ||
      String(v.imo || "").includes(q)
    );
  }

  function toNumber(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }

  // Fallback locale se il Worker non mette _bucket (ma il nostro lo mette)
  function classifyLocal(v) {
    const code = toNumber(v.ais_shiptype);
    const flag = (v.flag || "").toUpperCase();
    const mmsi = String(v.mmsi || "");
    const t = (v.type || "").toLowerCase();
    if (code === 35) return "military";
    if (flag === "IL" || mmsi.startsWith("428")) return "israeli";
    if (/(vehicle|pctc|ro-?ro)/.test(t) || /heavy.?lift|project/.test(t) || /multi.?purpose|mpp/.test(t)) {
      return "potential_arms";
    }
    return null;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function popupHtml(v) {
    const url = v.name ? `https://www.vesselfinder.com/vessels/${encodeURIComponent(v.name)}` : "#";
    const label =
      v._bucket === "military"
        ? "Militare"
        : v._bucket === "israeli"
        ? "Bandiera IL/MID 428"
        : "Potenziale (RO-RO/HL/MPP)";
    const lat = (v.lat || "").toString().slice(0, 8);
    const lon = (v.lon || "").toString().slice(0, 8);
    return `<div>
      <b>${escapeHtml(v.name || "—")}</b><br/>
      ${label}<br/>
      Flag: ${escapeHtml(v.flag || "—")} — MMSI: ${escapeHtml(v.mmsi || "—")} — IMO: ${escapeHtml(v.imo || "—")}<br/>
      Tipo: ${escapeHtml(v.type || "—")} — Dest: ${escapeHtml(v.destination || "—")}<br/>
      Pos: ${lat}, ${lon}<br/>
      <a href="${url}" target="_blank" rel="noopener">Dettagli</a>
    </div>`;
  }

  function upsertMarker(id, v) {
    if (!v.lat || !v.lon) return;
    if (!markers.has(id)) {
      const m = L.marker([v.lat, v.lon]).addTo(map).bindPopup(popupHtml(v));
      markers.set(id, m);
    } else {
      markers.get(id).setLatLng([v.lat, v.lon]).setPopupContent(popupHtml(v));
    }
  }

  function renderList() {
    const wanted = wantedBuckets();
    const arr = Array.from(objects.values())
      .filter((v) => (v._bucket || classifyLocal(v)) && wanted.has(v._bucket || classifyLocal(v)) && matchesText(v))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    listEl.innerHTML = "";
    for (const v of arr) {
      const li = document.createElement("li");
      li.innerHTML = `<b>${escapeHtml(v.name || "—")}</b>
        <div class="muted small">${escapeHtml(v._bucket || classifyLocal(v) || "—")} • Flag ${escapeHtml(v.flag || "—")} • MMSI ${escapeHtml(v.mmsi || "—")} • IMO ${escapeHtml(v.imo || "—")}</div>
        <div>${escapeHtml(v.type || "—")} — Dest: ${escapeHtml(v.destination || "—")}</div>`;
      li.onclick = () => {
        if (v.lat && v.lon) map.setView([v.lat, v.lon], 10);
      };
      listEl.appendChild(li);
    }
  }

  // === WEBSOCKET al RELAY ===
  function openStream() {
    // Chiudi eventuale socket precedente
    if (ws) {
      try { ws.close(); } catch (e) {}
      ws = null;
    }

    // BBOX corrente e memorizzazione
    const bbox = getBboxFromMap();
    currentBbox = bbox;

    // Costruisci payload di subscribe per il Worker
    const payload = {
      type: "subscribe",
      bbox: [[bbox[0], bbox[1]], [bbox[2], bbox[3]]], // [[S,W],[N,E]]
      // messageTypes: ["PositionReport","StaticDataReport"], // opzionale
      // mmsi: ["123456789"]                                 // opzionale
    };

    ws = new WebSocket(RELAY_URL);

    ws.onopen = () => {
      reconnectDelay = 1000; // reset backoff
      ws.send(JSON.stringify(payload));
      statusEl.textContent = "Connesso al relay… (subscription inviata)";
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);

        if (msg.type === "status") {
          // debug / UX
          statusEl.textContent = `Relay: ${msg.status || "ok"}`;
          return;
        }
        if (msg.type === "error") {
          statusEl.textContent = `Errore relay: ${msg.error || "unknown"}`;
          return;
        }
        if (msg.type !== "vessel" || !msg.data) return;

        const v = msg.data;               // già normalizzato dal Worker
        const bucket = v._bucket || classifyLocal(v);
        if (!bucket) return;
        v._bucket = bucket;

        // Stato locale
        const id = String(v.mmsi || v.imo || v.name || Math.random());
        objects.set(id, v);

        // Disegna solo se passa i filtri correnti
        const wanted = wantedBuckets();
        if (wanted.has(bucket) && matchesText(v)) {
          upsertMarker(id, v);
        }
      } catch (e) {
        // ignora frame non parse-abili
      }
    };

    ws.onclose = () => {
      statusEl.textContent = "Disconnesso. Riprovo…";
      setTimeout(openStream, Math.min(30000, reconnectDelay));
      reconnectDelay *= 2;
    };

    ws.onerror = () => {
      statusEl.textContent = "Errore connessione relay.";
      try { ws.close(); } catch (e) {}
    };
  }

  // === EVENTI UI ===
  btnReconnect.addEventListener("click", openStream);
  [chkMil, chkIl, chkPot].forEach((el) => el.addEventListener("change", renderList));
  qEl.addEventListener("input", renderList);

  quickPort.addEventListener("change", () => {
    const v = quickPort.value;
    if (!v) return;
    const [lat, lon, z] = v.split(",").map(Number);
    map.setView([lat, lon], z || 12);
  });

  // Resubscribe quando il bbox cambia “abbastanza”
  map.on("moveend", () => {
    const b2 = getBboxFromMap();
    const moved = !currentBbox || b2.some((v, i) => Math.abs(v - currentBbox[i]) > RESUBSCRIBE_MOVE_THRESHOLD);
    if (moved) openStream();
  });

  // Refresh lista periodico
  setInterval(renderList, LIST_REFRESH_MS);

  // Avvio
  openStream();
})();
