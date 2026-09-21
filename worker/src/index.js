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
  }).then((data) => {
    // El shapeId (para dibujar el recorrido real del colectivo) viene en
    // references.trips, no en cada arribo - lo copiamos a cada arribo para que
    // el resto del código no tenga que andar cruzando ambas listas.
    const shapeIdByTrip = {};
    ((data.references && data.references.trips) || []).forEach((t) => {
      if (t.shapeId) shapeIdByTrip[t.id] = t.shapeId;
    });
    (((data.entry && data.entry.arrivalsAndDepartures)) || []).forEach((a) => {
      a.shapeId = shapeIdByTrip[a.tripId] || null;
    });
    return data;
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

// Cloudflare limita cuántas peticiones salientes puede hacer un mismo Worker
// por invocación. findDirectCandidates, buildReachableMap y buildCoverageMap
// terminan pidiendo trip-details para muchos de los MISMOS viajes (todos
// escanean los arribos de las paradas de origen/destino), así que memoizamos
// por tripId durante todo el pedido para no pagar esa consulta dos veces.
function fetchTripDetails(tripId, cache) {
  if (cache && cache.has(tripId)) return cache.get(tripId);
  const promise = fetchOBA("trip-details-for-trip/" + encodeURIComponent(tripId) + ".json", {
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
  if (cache) cache.set(tripId, promise);
  return promise;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// En zonas densas puede haber muchas más de 8-10 paradas dentro del radio de
// caminata (verificado: 19 a menos de 700m en un caso real), y la línea que
// buscamos puede no ser la que tiene la parada más cercana de TODAS - sólo la
// más cercana entre las que sirven esa línea. Por eso, si hay paradas dentro
// del radio, las usamos casi todas en vez de cortar a un top-N general que
// mezcla paradas de otras líneas. OJO: subir este número de más hace que el
// pedido entero falle en silencio (Cloudflare corta la invocación por
// exceso de peticiones salientes: confirmado en un caso real donde 15
// paradas por lado tiraban abajo TODA la búsqueda de transbordos). 10 es un
// compromiso entre cobertura y no pasarnos del límite.
const MAX_NEARBY_STOPS = 10;

// stops-for-location.json de Mendotran es inconsistente: para el mismo centro,
// una parada puede aparecer con un recuadro de búsqueda chico y desaparecer con
// uno más grande (verificado con un caso real: aparece hasta latSpan/lonSpan
// 0.015 y desaparece de 0.018 en adelante, sin relación con la cantidad total
// de paradas devueltas). No hay un tamaño "seguro" único, así que pedimos dos
// tamaños distintos y combinamos lo que devuelva cada uno.
function fetchStopsForLocation(lat, lon) {
  return Promise.all([
    fetchOBA("stops-for-location.json", { lat, lon, latSpan: 0.012, lonSpan: 0.012 }),
    fetchOBA("stops-for-location.json", { lat, lon, latSpan: 0.025, lonSpan: 0.025 }),
  ]).then(([small, big]) => {
    const byId = {};
    [small, big].forEach((data) => {
      (data.list || data.stops || []).forEach((s) => { byId[s.id] = s; });
    });
    return Object.values(byId);
  });
}

// Devuelve las paradas más cercanas a (lat, lon), cada una con walkMeters: la distancia
// a pie hasta ese punto. Si maxMeters está definido, prioriza las que caen dentro de ese
// radio (para poder ofrecer "caminá hasta acá"); si ninguna entra, no descarta todo el
// resultado, sino que sigue con las más cercanas igual, aunque estén más lejos.
function findNearestStops(lat, lon, fallbackLimit, maxMeters) {
  return fetchStopsForLocation(lat, lon)
    .then((list) => {
      if (!list.length) throw new Error("Sin paradas cercanas");
      const withDist = list
        .map((s) => ({ stop: s, meters: haversine(lat, lon, s.lat, s.lon) * 1000 }))
        .sort((a, b) => a.meters - b.meters);
      const toStop = (x) => Object.assign({}, x.stop, { walkMeters: Math.round(x.meters) });
      if (maxMeters) {
        const within = withDist.filter((x) => x.meters <= maxMeters);
        if (within.length) return within.slice(0, MAX_NEARBY_STOPS).map(toStop);
      }
      return withDist.slice(0, fallbackLimit || 5).map(toStop);
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
function findDirectCandidates(originResults, destStops, limit, tripCache) {
  const destByCode = {};
  destStops.forEach((s) => { destByCode[s.name] = s; });
  const toProbe = flattenSoonestTrips(originResults, 4);

  return Promise.all(toProbe.map((item) =>
    fetchTripDetails(item.arrival.tripId, tripCache).then((details) => ({ item, details }))
  )).then((results) => {
    let candidates = [];
    results.forEach((r) => {
      const { stopTimes, codeById } = r.details;
      if (!stopTimes.length) return;
      // Algunos colectivos hacen un circuito y pasan por la misma zona más de
      // una vez (por ejemplo, se alejan y vuelven antes de encarar hacia el
      // destino). Si tomábamos siempre la PRIMERA vez que el trip pisa la
      // parada de origen, podíamos terminar recomendando subirse justo antes
      // de ese desvío en lugar de esperar el paso directo. Por eso probamos
      // cada vez que el trip pasa por la parada de origen.
      //
      // Del lado del destino pasa algo parecido pero distinto: el trip suele
      // pasar cerca de VARIAS paradas candidatas seguidas (a veces con
      // segundos de diferencia), y quedarnos con la primera que aparece en
      // el recorrido - en vez de la que menos hay que caminar después - podía
      // hacer bajar 300m más lejos por una parada que pasaba 40 segundos
      // antes. Por eso comparamos todas las paradas de destino alcanzables
      // y elegimos la que minimiza viaje en el bondi + caminata final juntos.
      let firstOriginEntry = null;
      let best = null;
      for (let i = 0; i < stopTimes.length; i++) {
        if (codeById[stopTimes[i].stopId] !== r.item.stop.name) continue;
        const originEntry = stopTimes[i];
        if (!firstOriginEntry) firstOriginEntry = originEntry;
        for (let j = i + 1; j < stopTimes.length; j++) {
          const code = codeById[stopTimes[j].stopId];
          if (!code || !destByCode[code]) continue;
          const destEntry = stopTimes[j];
          const destStop = destByCode[code];
          const rideSeconds = destEntry.arrivalTime - originEntry.arrivalTime;
          const destWalkSeconds = ((destStop.walkMeters || 0) / WALK_SPEED_M_PER_MIN) * 60;
          const totalSeconds = rideSeconds + destWalkSeconds;
          if (!best || totalSeconds < best.totalSeconds) {
            best = { originEntry, destEntry, destStop, rideSeconds, totalSeconds };
          }
        }
      }
      if (!best) return;
      const a = r.item.arrival;
      // El horario "en vivo" que reporta Mendotran es para la primera vez que
      // el colectivo pasa por esta parada. Si conviene abordarlo en otro paso
      // (el del circuito que va directo), trasladamos ese mismo desfasaje
      // en-vivo-vs-programado al horario programado de ese otro paso.
      const liveOffsetMs = (best.originEntry.arrivalTime - firstOriginEntry.arrivalTime) * 1000;
      const originPredicted = (a.predictedArrivalTime || a.scheduledArrivalTime) + liveOffsetMs;
      const destPredicted = originPredicted + best.rideSeconds * 1000;
      const destStop = best.destStop;
      const originWalkMeters = r.item.stop.walkMeters || 0;
      const destWalkMeters = destStop.walkMeters || 0;
      const destWalkMs = (destWalkMeters / WALK_SPEED_M_PER_MIN) * 60000;
      candidates.push({
        route: a.routeShortName || a.routeId || "",
        headsign: a.tripHeadsign || "",
        shapeId: a.shapeId || null,
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
function buildReachableMap(originResults, limit, tripCache) {
  const toProbe = flattenSoonestTrips(originResults, limit);
  return Promise.all(toProbe.map((item) =>
    fetchTripDetails(item.arrival.tripId, tripCache).then((details) => ({ item, details }))
  )).then((results) => {
    const reachable = {};
    results.forEach((r) => {
      const { stopTimes, codeById, refByCode } = r.details;
      if (!stopTimes.length) return;
      const a = r.item.arrival;
      const reportedPredicted = a.predictedArrivalTime || a.scheduledArrivalTime;
      // Igual que en findDirectCandidates: si el trip pasa por la parada de
      // origen más de una vez (circuito), probamos abordarlo en cada paso y
      // nos quedamos, para cada parada alcanzable, con la que llega antes -
      // así no arrastramos un rodeo por haber tomado el primer paso nomás.
      let firstOriginEntry = null;
      for (let i = 0; i < stopTimes.length; i++) {
        if (codeById[stopTimes[i].stopId] !== r.item.stop.name) continue;
        const originEntry = stopTimes[i];
        if (!firstOriginEntry) firstOriginEntry = originEntry;
        const liveOffsetMs = (originEntry.arrivalTime - firstOriginEntry.arrivalTime) * 1000;
        const originPredicted = reportedPredicted + liveOffsetMs;
        for (let j = i + 1; j < stopTimes.length; j++) {
          const code = codeById[stopTimes[j].stopId];
          if (!code) continue;
          const arrivalTime = originPredicted + (stopTimes[j].arrivalTime - originEntry.arrivalTime) * 1000;
          if (!reachable[code] || arrivalTime < reachable[code].arrivalTime) {
            reachable[code] = {
              stopRef: refByCode[code],
              arrivalTime,
              route: a.routeShortName || a.routeId || "",
              headsign: a.tripHeadsign || "",
              shapeId: a.shapeId || null,
              originStop: r.item.stop,
              originTime: originPredicted,
            };
          }
        }
      }
    });
    return reachable;
  });
}

// Búsqueda "hacia atrás": para cada colectivo que está por llegar a una parada cerca
// del destino, en qué paradas anteriores de su recorrido se lo podría abordar y a qué hora.
function buildCoverageMap(destResults, destStops, limit, tripCache) {
  const destCodes = {};
  destStops.forEach((s) => { destCodes[s.name] = s; });
  const toProbe = flattenSoonestTrips(destResults, limit);

  return Promise.all(toProbe.map((item) =>
    fetchTripDetails(item.arrival.tripId, tripCache).then((details) => ({ item, details }))
  )).then((results) => {
    const coverage = {};
    results.forEach((r) => {
      const { stopTimes, codeById, refByCode } = r.details;
      if (!stopTimes.length) return;
      const a = r.item.arrival;
      const reportedPredicted = a.predictedArrivalTime || a.scheduledArrivalTime;
      // Mismo criterio que en las otras dos búsquedas: si el trip pasa dos
      // veces cerca del destino (circuito), probamos cada paso y nos
      // quedamos, por cada posible parada de subida, con la que implica el
      // tramo más directo (el boardTime más tardío = el viaje más corto).
      let firstDestEntry = null;
      for (let i = 0; i < stopTimes.length; i++) {
        const destCode = codeById[stopTimes[i].stopId];
        if (!destCode || !destCodes[destCode]) continue;
        const destEntry = stopTimes[i];
        if (!firstDestEntry) firstDestEntry = destEntry;
        const liveOffsetMs = (destEntry.arrivalTime - firstDestEntry.arrivalTime) * 1000;
        const destPredicted = reportedPredicted + liveOffsetMs;
        for (let j = 0; j < i; j++) {
          const code = codeById[stopTimes[j].stopId];
          if (!code) continue;
          const boardTime = destPredicted - (destEntry.arrivalTime - stopTimes[j].arrivalTime) * 1000;
          if (!coverage[code] || boardTime > coverage[code].boardTime) {
            coverage[code] = {
              stopRef: refByCode[code],
              boardTime,
              route: a.routeShortName || a.routeId || "",
              headsign: a.tripHeadsign || "",
              shapeId: a.shapeId || null,
              destStop: destCodes[destCode],
              destTime: destPredicted,
            };
          }
        }
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
        leg1Route: reach.route, leg1Headsign: reach.headsign, leg1ShapeId: reach.shapeId,
        originStop: reach.originStop, originTime: reach.originTime, originWalkMeters,
        transferStop: reach.stopRef, transferArrival: reach.arrivalTime,
        walkMeters: transferWalkMeters,
        boardStop: transferWalkMeters > 0 ? best.cov.stopRef : null,
        transferBoard: best.cov.boardTime,
        leg2Route: best.cov.route, leg2Headsign: best.cov.headsign, leg2ShapeId: best.cov.shapeId,
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
      findNearestStops(fromLat, fromLon, 6, MAX_WALK_METERS),
      findNearestStops(toLat, toLon, 6, MAX_WALK_METERS),
    ]);
  } catch (err) {
    return json({ code: 502, text: "No se encontraron paradas cercanas: " + err.message }, 502);
  }

  console.log("originStops: " + originStops.map((s) => s.name).join(",") + " | destStops: " + destStops.map((s) => s.name).join(","));

  // Cloudflare corta la invocación si hace demasiadas peticiones salientes;
  // este cache (por tripId) evita pedir el mismo trip-details más de una vez
  // aunque lo toquen findDirectCandidates, buildReachableMap y buildCoverageMap.
  const tripCache = new Map();

  const originResults = await buildStopArrivals(originStops);
  console.log("origin arrivals counts: " + originResults.map((r) => r.stop.name + "=" + r.arrivals.length).join(", "));
  const direct = await findDirectCandidates(originResults, destStops, 5, tripCache);

  if (direct.length) {
    return json({ code: 200, data: { direct, transfer: [], fallback: null } });
  }

  const destResults = await buildStopArrivals(destStops);
  console.log("dest arrivals counts: " + destResults.map((r) => r.stop.name + "=" + r.arrivals.length).join(", "));
  const [reachable, coverage] = await Promise.all([
    buildReachableMap(originResults, 3, tripCache),
    buildCoverageMap(destResults, destStops, 4, tripCache),
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
