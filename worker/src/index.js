const UPSTREAM = "https://mendotran.oba.visionblo.com/oba_api/api/where/";

function withCors(headers) {
  const h = new Headers(headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return h;
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: withCors({ "Content-Type": "application/json" }),
  });
}

// ---------- Llamadas a Mendotran (OneBusAway) ----------

function fetchOBA(path, params) {
  const url = UPSTREAM + path + "?" + Object.keys(params)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]))
    .join("&");
  return fetch(url, { cf: { cacheTtl: 15, cacheEverything: true } })
    .then((res) => {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then((body) => {
      if (body.code !== 200) throw new Error("API code " + body.code);
      return body.data;
    });
}

function fetchArrivals(stopId) {
  return fetchOBA("arrivals-and-departures-for-stop/" + encodeURIComponent(stopId) + ".json", {
    platform: "web", v: "", minutesBefore: 0, minutesAfter: 65, version: "1.0",
  });
}

// ---------- Geocodificación (Nominatim / OpenStreetMap) ----------
// Nominatim no manda Access-Control-Allow-Origin, así que lo proxeamos igual que a
// Mendotran, agregando el User-Agent que pide su política de uso.
const MENDOZA_VIEWBOX = "-69.3,-32.6,-68.5,-33.2"; // izq,arriba,der,abajo: sesga los resultados a Mendoza

function geocode(query) {
  const url = "https://nominatim.openstreetmap.org/search?" +
    "q=" + encodeURIComponent(query) +
    "&format=jsonv2&limit=6&countrycodes=ar&viewbox=" + MENDOZA_VIEWBOX + "&bounded=0";
  return fetch(url, {
    headers: { "User-Agent": "TransportArte/1.0 (https://santiagososa.com.ar/transportarte/)" },
    cf: { cacheTtl: 300, cacheEverything: true },
  }).then((res) => {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }).then((list) => (list || []).map((r) => ({
    label: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
  })));
}

function reverseGeocode(lat, lon) {
  const url = "https://nominatim.openstreetmap.org/reverse?" +
    "lat=" + encodeURIComponent(lat) + "&lon=" + encodeURIComponent(lon) + "&format=jsonv2";
  return fetch(url, {
    headers: { "User-Agent": "TransportArte/1.0 (https://santiagososa.com.ar/transportarte/)" },
    cf: { cacheTtl: 300, cacheEverything: true },
  }).then((res) => {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }).then((r) => ({ label: r.display_name || null }));
}

function fetchTripDetails(tripId) {
  return fetchOBA("trip-details-for-trip/" + encodeURIComponent(tripId) + ".json", {
    platform: "web", v: "", version: "1.0",
  }).then((data) => {
    const stopTimes = (data.entry && data.entry.schedule && data.entry.schedule.stopTimes) || [];
    const codeById = {};
    const refByCode = {};
    ((data.references && data.references.stops) || []).forEach((s) => {
      const code = s.code || s.name;
      codeById[s.id] = code;
      refByCode[code] = s;
    });
    return { stopTimes, codeById, refByCode };
  }).catch((err) => {
    console.log("fetchTripDetails failed for " + tripId + ": " + err.message);
    return { stopTimes: [], codeById: {}, refByCode: {} };
  });
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Devuelve las paradas más cercanas a (lat, lon), cada una con walkMeters: la distancia
// a pie hasta ese punto. Si maxMeters está definido, prioriza las que caen dentro de ese
// radio (para poder ofrecer "caminá hasta acá"); si ninguna entra, no descarta todo el
// resultado, sino que sigue con las más cercanas igual, aunque estén más lejos.
function findNearestStops(lat, lon, limit, maxMeters) {
  return fetchOBA("stops-for-location.json", { lat, lon, latSpan: 0.02, lonSpan: 0.02 })
    .then((data) => {
      const list = data.list || data.stops || [];
      if (!list.length) throw new Error("Sin paradas cercanas");
      let withDist = list
        .map((s) => ({ stop: s, meters: haversine(lat, lon, s.lat, s.lon) * 1000 }))
        .sort((a, b) => a.meters - b.meters);
      if (maxMeters) {
        const within = withDist.filter((x) => x.meters <= maxMeters);
        if (within.length) withDist = within;
      }
      return withDist.slice(0, limit || 5).map((x) => Object.assign({}, x.stop, { walkMeters: Math.round(x.meters) }));
    });
}

function buildStopArrivals(stops) {
  return Promise.all(stops.map((stop) =>
    fetchArrivals(stop.id)
      .then((data) => ({ stop, arrivals: (data.entry && data.entry.arrivalsAndDepartures) || [] }))
      .catch(() => ({ stop, arrivals: [] }))
  ));
}

// Toma hasta perStopLimit arribos por parada (no un top-N global), para que una esquina
// muy transitada no le gane el cupo a las demás paradas cercanas y tape conexiones reales.
function flattenSoonestTrips(stopResults, perStopLimit) {
  const seen = {};
  const flat = [];
  stopResults.forEach((r) => {
    const sorted = r.arrivals.slice().sort((a, b) =>
      (a.predictedArrivalTime || a.scheduledArrivalTime) - (b.predictedArrivalTime || b.scheduledArrivalTime));
    let taken = 0;
    for (let i = 0; i < sorted.length && taken < perStopLimit; i++) {
      const a = sorted[i];
      if (!a.tripId || seen[a.tripId]) continue;
      seen[a.tripId] = true;
      flat.push({ arrival: a, stop: r.stop });
      taken++;
    }
  });
  return flat;
}

const TRANSFER_BUFFER_MS = 3 * 60000;

// Recorre la secuencia completa de paradas de cada colectivo próximo (no solo los arribos
// ya anunciados en la parada de destino) para saber con certeza si, más adelante en su
// recorrido, ese mismo viaje pasa por alguna parada cercana al destino.
function findDirectCandidates(originResults, destStops, limit) {
  const destByCode = {};
  destStops.forEach((s) => { destByCode[s.name] = s; });
  const toProbe = flattenSoonestTrips(originResults, 5);

  return Promise.all(toProbe.map((item) =>
    fetchTripDetails(item.arrival.tripId).then((details) => ({ item, details }))
  )).then((results) => {
    let candidates = [];
    results.forEach((r) => {
      const { stopTimes, codeById } = r.details;
      if (!stopTimes.length) return;
      let originEntry = null;
      for (let i = 0; i < stopTimes.length; i++) {
        if (codeById[stopTimes[i].stopId] === r.item.stop.name) { originEntry = stopTimes[i]; break; }
      }
      if (!originEntry) return;
      let destEntry = null, destStop = null;
      for (let j = 0; j < stopTimes.length; j++) {
        const code = codeById[stopTimes[j].stopId];
        if (code && destByCode[code] && stopTimes[j].arrivalTime > originEntry.arrivalTime) {
          destEntry = stopTimes[j];
          destStop = destByCode[code];
          break;
        }
      }
      if (!destEntry) return;
      const a = r.item.arrival;
      const originPredicted = a.predictedArrivalTime || a.scheduledArrivalTime;
      const destPredicted = originPredicted + (destEntry.arrivalTime - originEntry.arrivalTime) * 1000;
      const originWalkMeters = r.item.stop.walkMeters || 0;
      const destWalkMeters = destStop.walkMeters || 0;
      const destWalkMs = (destWalkMeters / WALK_SPEED_M_PER_MIN) * 60000;
      candidates.push({
        route: a.routeShortName || a.routeId || "",
        headsign: a.tripHeadsign || "",
        originStop: r.item.stop,
        originTime: originPredicted,
        originWalkMeters,
        destStop,
        destTime: destPredicted,
        destWalkMeters,
        arrivalTime: destPredicted + destWalkMs,
        totalWalkMeters: originWalkMeters + destWalkMeters,
      });
    });
    const now = Date.now();
    // Sólo sirve si, caminando desde el origen real hasta la parada, todavía llegás a tiempo.
    candidates = candidates.filter((c) => {
      const originWalkMs = (c.originWalkMeters / WALK_SPEED_M_PER_MIN) * 60000;
      return c.originTime >= now + originWalkMs - 30000;
    });
    // Prioriza el viaje más rápido de punta a punta (incluyendo la caminata final) y,
    // ante un empate, el que implique menos caminata en total.
    candidates.sort((a, b) => (a.arrivalTime - b.arrivalTime) || (a.totalWalkMeters - b.totalWalkMeters));
    return candidates.slice(0, limit || 5);
  });
}

// Búsqueda "hacia adelante": para cada colectivo próximo cerca del origen, a qué parada
// (y a qué hora) se puede llegar en cada punto de su recorrido.
function buildReachableMap(originResults, limit) {
  const toProbe = flattenSoonestTrips(originResults, limit);
  return Promise.all(toProbe.map((item) =>
    fetchTripDetails(item.arrival.tripId).then((details) => ({ item, details }))
  )).then((results) => {
    const reachable = {};
    results.forEach((r) => {
      const { stopTimes, codeById, refByCode } = r.details;
      if (!stopTimes.length) return;
      let originIdx = -1;
      for (let i = 0; i < stopTimes.length; i++) {
        if (codeById[stopTimes[i].stopId] === r.item.stop.name) { originIdx = i; break; }
      }
      if (originIdx === -1) return;
      const a = r.item.arrival;
      const originPredicted = a.predictedArrivalTime || a.scheduledArrivalTime;
      const originOffset = stopTimes[originIdx].arrivalTime;
      for (let j = originIdx + 1; j < stopTimes.length; j++) {
        const code = codeById[stopTimes[j].stopId];
        if (!code) continue;
        const arrivalTime = originPredicted + (stopTimes[j].arrivalTime - originOffset) * 1000;
        if (!reachable[code] || arrivalTime < reachable[code].arrivalTime) {
          reachable[code] = {
            stopRef: refByCode[code],
            arrivalTime,
            route: a.routeShortName || a.routeId || "",
            headsign: a.tripHeadsign || "",
            originStop: r.item.stop,
            originTime: originPredicted,
          };
        }
      }
    });
    return reachable;
  });
}

// Búsqueda "hacia atrás": para cada colectivo que está por llegar a una parada cerca
// del destino, en qué paradas anteriores de su recorrido se lo podría abordar y a qué hora.
function buildCoverageMap(destResults, destStops, limit) {
  const destCodes = {};
  destStops.forEach((s) => { destCodes[s.name] = s; });
  const toProbe = flattenSoonestTrips(destResults, limit);

  return Promise.all(toProbe.map((item) =>
    fetchTripDetails(item.arrival.tripId).then((details) => ({ item, details }))
  )).then((results) => {
    const coverage = {};
    results.forEach((r) => {
      const { stopTimes, codeById, refByCode } = r.details;
      if (!stopTimes.length) return;
      let destIdx = -1, destCode = null;
      for (let i = 0; i < stopTimes.length; i++) {
        const c = codeById[stopTimes[i].stopId];
        if (c && destCodes[c]) { destIdx = i; destCode = c; break; }
      }
      if (destIdx === -1) return;
      const a = r.item.arrival;
      const destPredicted = a.predictedArrivalTime || a.scheduledArrivalTime;
      const destOffset = stopTimes[destIdx].arrivalTime;
      for (let j = 0; j < destIdx; j++) {
        const code = codeById[stopTimes[j].stopId];
        if (!code || coverage[code]) continue;
        coverage[code] = {
          stopRef: refByCode[code],
          boardTime: destPredicted - (destOffset - stopTimes[j].arrivalTime) * 1000,
          route: a.routeShortName || a.routeId || "",
          headsign: a.tripHeadsign || "",
          destStop: destCodes[destCode],
          destTime: destPredicted,
        };
      }
    });
    return coverage;
  });
}

// Caminar hasta otra parada para el segundo colectivo también cuenta como transbordo
// válido - no hace falta que sea exactamente la misma parada donde bajaste. El mismo tope
// aplica para la caminata inicial (origen -> parada de subida) y la final (parada de
// bajada -> destino real).
const WALK_SPEED_M_PER_MIN = 70; // paso tranquilo, con margen
const MAX_WALK_METERS = 700; // ~10 min caminando

function findTwoLegCandidates(reachable, coverage, limit) {
  const coverageList = Object.keys(coverage).map((code) => Object.assign({ code }, coverage[code]));
  let candidates = [];

  Object.keys(reachable).forEach((code) => {
    const reach = reachable[code];
    let best = null;

    coverageList.forEach((cov) => {
      let walkMeters = 0;
      if (cov.code !== code) {
        const rs = reach.stopRef, cs = cov.stopRef;
        if (!rs || !cs || rs.lat == null || cs.lat == null) return;
        walkMeters = haversine(parseFloat(rs.lat), parseFloat(rs.lon), parseFloat(cs.lat), parseFloat(cs.lon)) * 1000;
        if (walkMeters > MAX_WALK_METERS) return;
      }
      const walkMs = (walkMeters / WALK_SPEED_M_PER_MIN) * 60000;
      if (cov.boardTime < reach.arrivalTime + walkMs + TRANSFER_BUFFER_MS) return;
      if (!best || cov.destTime < best.cov.destTime) best = { cov, walkMeters };
    });

    if (best) {
      const originWalkMeters = reach.originStop.walkMeters || 0;
      const transferWalkMeters = Math.round(best.walkMeters);
      const destWalkMeters = (best.cov.destStop && best.cov.destStop.walkMeters) || 0;
      const destWalkMs = (destWalkMeters / WALK_SPEED_M_PER_MIN) * 60000;
      candidates.push({
        leg1Route: reach.route, leg1Headsign: reach.headsign,
        originStop: reach.originStop, originTime: reach.originTime, originWalkMeters,
        transferStop: reach.stopRef, transferArrival: reach.arrivalTime,
        walkMeters: transferWalkMeters,
        boardStop: transferWalkMeters > 0 ? best.cov.stopRef : null,
        transferBoard: best.cov.boardTime,
        leg2Route: best.cov.route, leg2Headsign: best.cov.headsign,
        destStop: best.cov.destStop, destTime: best.cov.destTime, destWalkMeters,
        arrivalTime: best.cov.destTime + destWalkMs,
        totalWalkMeters: originWalkMeters + transferWalkMeters + destWalkMeters,
      });
    }
  });

  const now = Date.now();
  candidates = candidates.filter((c) => {
    const originWalkMs = (c.originWalkMeters / WALK_SPEED_M_PER_MIN) * 60000;
    return c.originTime >= now + originWalkMs - 30000 && c.transferBoard > now - 30000;
  });
  candidates.sort((a, b) => (a.arrivalTime - b.arrivalTime) || (a.totalWalkMeters - b.totalWalkMeters));
  return candidates.slice(0, limit || 5);
}

// ---------- Endpoint /route.json ----------
// GET /route.json?fromLat=..&fromLon=..&toLat=..&toLon=..
// Devuelve { direct: [...], transfer: [...], fallback: {...} | null }
async function handleRoute(url) {
  const fromLat = parseFloat(url.searchParams.get("fromLat"));
  const fromLon = parseFloat(url.searchParams.get("fromLon"));
  const toLat = parseFloat(url.searchParams.get("toLat"));
  const toLon = parseFloat(url.searchParams.get("toLon"));
  if ([fromLat, fromLon, toLat, toLon].some((n) => Number.isNaN(n))) {
    return json({ code: 400, text: "Faltan o son inválidos fromLat/fromLon/toLat/toLon" }, 400);
  }

  let originStops, destStops;
  try {
    [originStops, destStops] = await Promise.all([
      findNearestStops(fromLat, fromLon, 8, MAX_WALK_METERS),
      findNearestStops(toLat, toLon, 8, MAX_WALK_METERS),
    ]);
  } catch (err) {
    return json({ code: 502, text: "No se encontraron paradas cercanas: " + err.message }, 502);
  }

  console.log("originStops: " + originStops.map((s) => s.name).join(",") + " | destStops: " + destStops.map((s) => s.name).join(","));

  const originResults = await buildStopArrivals(originStops);
  console.log("origin arrivals counts: " + originResults.map((r) => r.stop.name + "=" + r.arrivals.length).join(", "));
  const direct = await findDirectCandidates(originResults, destStops, 5);

  if (direct.length) {
    return json({ code: 200, data: { direct, transfer: [], fallback: null } });
  }

  const destResults = await buildStopArrivals(destStops);
  console.log("dest arrivals counts: " + destResults.map((r) => r.stop.name + "=" + r.arrivals.length).join(", "));
  const [reachable, coverage] = await Promise.all([
    buildReachableMap(originResults, 4),
    buildCoverageMap(destResults, destStops, 8),
  ]);
  console.log("reachable codes: " + Object.keys(reachable).length + " | coverage codes: " + Object.keys(coverage).length);
  const transfer = findTwoLegCandidates(reachable, coverage, 5);

  if (transfer.length) {
    return json({ code: 200, data: { direct: [], transfer, fallback: null } });
  }

  return json({
    code: 200,
    data: {
      direct: [],
      transfer: [],
      fallback: {
        originStop: originResults[0] ? originResults[0].stop : null,
        originArrivals: originResults[0] ? originResults[0].arrivals : [],
        destStop: destStops[0] || null,
      },
    },
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: withCors({}) });
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: withCors({}) });
    }

    const url = new URL(request.url);

    if (url.pathname === "/route.json") {
      try {
        return await handleRoute(url);
      } catch (err) {
        return json({ code: 500, text: "Error interno: " + err.message }, 500);
      }
    }

    if (url.pathname === "/geocode.json") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return json({ code: 400, text: "Falta el parámetro q" }, 400);
      try {
        const results = await geocode(q);
        return json({ code: 200, data: results });
      } catch (err) {
        return json({ code: 502, text: "No se pudo geocodificar: " + err.message }, 502);
      }
    }

    if (url.pathname === "/reverse.json") {
      const lat = parseFloat(url.searchParams.get("lat"));
      const lon = parseFloat(url.searchParams.get("lon"));
      if (Number.isNaN(lat) || Number.isNaN(lon)) return json({ code: 400, text: "Faltan lat/lon" }, 400);
      try {
        const result = await reverseGeocode(lat, lon);
        return json({ code: 200, data: result });
      } catch (err) {
        return json({ code: 502, text: "No se pudo geocodificar: " + err.message }, 502);
      }
    }

    const path = url.pathname.replace(/^\/+/, "");
    if (!path || path.includes("..") || !path.endsWith(".json")) {
      return new Response("Not found", { status: 404, headers: withCors({}) });
    }

    const upstreamUrl = UPSTREAM + path + url.search;
    const upstreamResponse = await fetch(upstreamUrl, {
      cf: { cacheTtl: 15, cacheEverything: true },
    });

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: withCors(upstreamResponse.headers),
    });
  },
};
