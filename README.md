# AIS Xposed
🚢 AIS Xposed - Vessel Tracking Intelligence
Una piattaforma di tracciamento in tempo reale che espone le posizioni delle navi mercantili e logistiche che sono state identificate e collegate a categorie specifiche (es. affiliazioni a gruppi, sanzioni, logistica militare) tramite fonti aperte e indagini documentate.

Utilizza AIS Stream per i dati in tempo reale e un Cloudflare Worker come proxy e come Durable Object per mantenere lo stato e applicare i tag investigativi.

⚙️ Architettura del Progetto
Il progetto si compone di tre parti principali:

AIS Stream (Upstream Data Source): Fornisce i dati AIS in tempo reale.

Worker/Proxy (Backend, aisxposed.js o worker.js):

Gestisce la singola connessione WebSocket persistente verso AIS Stream.

Mantiene una lista statica di navi da tracciare, arricchita con categorie e tag (la fonte di verità investigativa).

Filtra i dati AIS in arrivo, li arricchisce con i tag e ritrasmette solo i dati rilevanti ai client web connessi.

Frontend (Client Web, index.html):

Visualizza la mappa interattiva (Leaflet) e la lista delle navi.

Si connette al Worker tramite WebSocket per ricevere gli aggiornamenti in tempo reale.

Permette di filtrare le navi per categoria e destinazione.

📋 Setup e Avvio (Per Sviluppatori)
1. Ottenere la Chiave API
Avrai bisogno di una chiave API gratuita da AIS Stream.

2. Configurazione del Worker
Modifica il file backend (es. aisxposed.js) e sostituisci la placeholder key:

JavaScript

const API_KEY = 'la-tua-chiave-api-qui'; // <-- ESSENZIALE
3. Data Set Navi
La lista delle navi da tracciare, insieme ai loro tag e categorie, si trova all'inizio del file del Worker (VESSELS_TO_TRACK). Questa lista è l'output dell'indagine e non va modificata senza validazione della fonte.

4. Deploy del Worker
Questo progetto è ottimizzato per Cloudflare Workers / Durable Objects.

Installa wrangler (CLI di Cloudflare).

Esegui il deploy utilizzando il tuo tool di gestione dei Worker (es. wrangler publish).

Annota l'URL del tuo Worker, che sarà usato nel frontend (vedi WORKER_URL nel codice HTML).

🔎 Funzionalità Principali (Frontend)
Tracciamento Live: Aggiornamento della posizione delle navi in tempo reale.

Filtri Categoria: Visualizza solo le navi classificate come Affiliati, Militari o Potenziale Trasporto Armi.

Filtro Destinazione: Ricerca testuale sulla destinazione dichiarata (es. Haifa, Livorno).

Schede Dettaglio: Ogni nave nella lista è cliccabile per zoomare sulla mappa e mostrare un popup dettagliato con i dati AIS e tutti i tag investigativi.

Sistema di Tagging: I colori e i badge (es. tag--invest, tag--israel) sono mappati nel codice HTML/CSS (index.html) e riflettono le diverse fonti o motivazioni che hanno portato all'inclusione della nave.

⚠️ Disclaimer Importante
AIS Xposed è un progetto di intelligence open source. I dati AIS (posizione, rotta, destinazione) sono pubblici ma non garantiti. I tag applicati alle navi sono basati su analisi documentali e non costituiscono una prova legale o definitiva di una determinata attività. L'obiettivo è quello di fornire un livello di trasparenza e consapevolezza tracciando i movimenti marittimi di entità precedentemente identificate.