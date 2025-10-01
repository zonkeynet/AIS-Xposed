// assets/app_aisstream.js
// TrackWarships — AISStream WebSocket client
// Requisiti: in index.html deve esistere window.AISSTREAM_CONFIG.API_KEY
// Leaflet già incluso da CDN. Vedi index.html per gli ID dei controlli UI.

(function () {
  // --- Map setup ---
  const map = L.map("map", { worldCopyJump: true }).setView([48.5, 10.0], 5); // centro UE
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18 }).addTo(map);

  // --- UI handles ---
  const statusEl = document.getElementById("status");
  const qEl = document.getElementById("q");
  const chkMil = document.getElementById("chk-military");
  const chkIl = document.getElementById("chk-israeli");
  const chkPot = document.getElementById("chk-potential");
  const quickPort = document.getElementById("quick-port");
  const btnReconnect = document.getElementById("btn-reconnect");
  const listEl = document.getElementById("result-list");

  // --- State ---
  let ws = null;
  let reconnectDelay = 1000; // ms, exponential backoff up to 30s
  let currentBbox = null;
  const markers = new Map(); // id -> Leaflet marker
  const objects = new Map(); // id -> last normalized vessel object

  const AIS_KEY = (window.AISSTREAM_CONFIG && window.AISSTREAM_CONFIG.API_KEY) || "";

  // --- Helpers ---
  function getBboxFromMap() {
    const b = map.getBounds();
    // Leaflet: SW e NE
    const sw = b.getSouthWest(); // {lat, lng}
    const ne = b.getNorthEast(); // {lat, lng}
    return [sw.lat, sw.lng, ne.lat, ne.lng];
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

  // Classifica in: 'military' | 'israeli' | 'potential_arms' | null
  function classify(v) {
    const code = toNumber(v.ais_shiptype || v.SHIPTYPE || v.shiptype_code || v.type);
    const flag = (v.flag || v.country || "").toUpperCase();
    const mmsi = String(v.mmsi || "");
    const typeText = (
      (v.ship_type_text || v.type_text || v.type || "") +
      " " +
      (v.cargo || "")
    ).toLowerCase();

    const isMilitary = code === 35; // AIS 35: Military ops
    const isIsraeli = flag === "IL" || mmsi.startsWith("428"); // MID 428
    const isPotential =
      /(vehicle|pctc|ro-?ro)/.test(typeText) ||
      /heavy.?lift|project/.test(typeText) ||
      /multi.?purpose|mpp/.test(typeText);

    if (isMilitary) return "military";
    if (isIsraeli) return "israeli";
    if (isPotential) return "potential_arms";
    return null;
  }

  function toNumber(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }

  function wantedBuckets() {
    const s = new Set();
    if (chkMil.checked) s.add("military");
    if (chkIl.checked) s.add("israeli");
    if (chkPot.checked) s.add("potential_arms");
    return s;
  }

  // --- Rendering ---
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

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
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
      .filter((v) => v._bucket && wanted.has(v._bucket) && matchesText(v))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    listEl.innerHTML = "";
    for (const v of arr) {
      const li = document.createElement("li");
      li.innerHTML = `<b>${escapeHtml(v.name || "—")}</b>
        <div class="muted small">${v._bucket} • Flag ${escapeHtml(v.flag || "—")} • MMSI ${escapeHtml(v.mmsi || "—")} • IMO ${escapeHtml(v.imo || "—")}</div>
        <div>${escapeHtml(v.type || "—")} — Dest: ${escapeHtml(v.destination || "—")}</div>`;
      li.onclick = () => {
        if (v.lat && v.lon) map.setView([v.lat, v.lon], 10);
      };
      listEl.appendChild(li);
    }
  }

  // --- WebSocket handling ---
  function openStream() {
    if (!AIS_KEY) {
      statusEl.textContent = "Manca AISSTREAM_CONFIG.API_KEY in index.html";
      return;
    }

    // reset connessione se già aperta
    if (ws) {
      try {
        ws.close();
      } catch (e) {}
      ws = null;
    }

    // bbox corrente
    const bbox = getBboxFromMap();
    currentBbox = bbox;

    ws = new WebSocket("wss://stream.aisstream.io/v0/stream");

    ws.onopen = () => {
      reconnectDelay = 1000; // reset backoff

      // bbox corrente: [south, west, north, east]
      const south = bbox[0], west = bbox[1], north = bbox[2], east = bbox[3];

      // Messaggio di sottoscrizione CORRETTO secondo la doc:
      // - APIKey (camel case)
      // - BoundingBoxes: array di box, ogni box = [[lat1, lon1], [lat2, lon2]]
      //   qui usiamo [ [south, west], [north, east] ]
      const sub = {
        APIKey: AIS_KEY,
        BoundingBoxes: [
          [[south, west], [north, east]]
        ],
        // opzionali:
        // FiltersShipMMSI: ["123456789","987654321"],
        // FilterMessageTypes: ["PositionReport","StaticDataReport"]
      };

      ws.send(JSON.stringify(sub));
      statusEl.textContent = "Connesso allo stream… (subscription inviata)";
    };


    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);

        // AISStream invia diversi tipi di messaggi; qui gestiamo PositionReport & StaticDataReport
        const pr = msg?.Message?.PositionReport;
        const sd = msg?.Message?.StaticDataReport;

        if (!pr && !sd) return;

        const meta = msg?.MetaData || {};
        // normalizzazione
        const v = {
          name: sd?.Name || meta?.ShipName || null,
          mmsi: meta?.MMSI || pr?.UserID || null,
          imo: sd?.IMO || null,
          lat: pr?.Latitude ?? pr?.LatitudeDegrees ?? null,
          lon: pr?.Longitude ?? pr?.LongitudeDegrees ?? null,
          flag: meta?.Flag || sd?.Flag || null,
          type: sd?.ShipTypeText || meta?.ShipType || null,
          destination: sd?.Destination || null,
          ais_shiptype: sd?.ShipType || pr?.Type || null,
        };

        // classificazione
        const bucket = classify(v);
        if (!bucket) return;
        v._bucket = bucket;

        // id stabile
        const id = String(v.mmsi || v.imo || v.name || Math.random());

        // salvataggio stato + render
        objects.set(id, v);
        const wanted = wantedBuckets();
        if (wanted.has(bucket) && matchesText(v)) {
          upsertMarker(id, v);
        }
      } catch (e) {
        // silenzioso: alcuni frame possono non interessare
      }
    };

    ws.onclose = () => {
      statusEl.textContent = "Disconnesso. Riprovo…";
      setTimeout(openStream, Math.min(30000, reconnectDelay));
      reconnectDelay *= 2;
    };

    ws.onerror = () => {
      statusEl.textContent = "Errore stream.";
      try {
        ws.close();
      } catch (e) {}
    };
  }

  // --- UI events ---
  btnReconnect.addEventListener("click", openStream);
  [chkMil, chkIl, chkPot].forEach((el) => el.addEventListener("change", renderList));
  qEl.addEventListener("input", renderList);

  quickPort.addEventListener("change", () => {
    const v = quickPort.value;
    if (!v) return;
    const [lat, lon, z] = v.split(",").map(Number);
    map.setView([lat, lon], z || 12);
  });

  // Riapri lo stream quando il bbox cambia significativamente
  map.on("moveend", () => {
    const b2 = getBboxFromMap();
    const moved = !currentBbox || b2.some((v, i) => Math.abs(v - currentBbox[i]) > 0.2);
    if (moved) openStream();
  });

  // refresh lista periodico per ridurre lavoro su onmessage
  setInterval(renderList, 1500);

  // kick-off
  openStream();
})();
