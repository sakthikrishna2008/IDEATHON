const HOUR_MS = 60 * 60 * 1000;
        const USE_MOCK = true;
        const API_BASE = "http://localhost:8000";
        // Edit the west-side points to follow the coast, then adjust the north/east/south limits.
        const SEA_POLYGON = [
            [10.3,80.05],[10.6,80.02],[11,80.0],[11.5,80.06],[12,80.15],
            [12.5,80.22],[13.0827,80.2707],[13.5,80.32],[14,80.35],[14.5,80.37],
            [15,80.35],[15.5,80.3],[16,80.3],[16.5,80.4],[16.5,84.5],[10.3,84.5]
        ];
        const CHENNAI_PORT = { lat: 13.0827, lon: 80.2707 };

        function isWater(lat, lon) {
            const point = { lat, lon };
            let inside = false;
            for (let i = 0, j = SEA_POLYGON.length - 1; i < SEA_POLYGON.length; j = i++) {
                const [latI, lonI] = SEA_POLYGON[i], [latJ, lonJ] = SEA_POLYGON[j];
                const cross = (lon - lonJ) * (latI - latJ) - (lat - latJ) * (lonI - lonJ);
                if (Math.abs(cross) < 1e-10
                    && lon >= Math.min(lonI, lonJ) - 1e-10 && lon <= Math.max(lonI, lonJ) + 1e-10
                    && lat >= Math.min(latI, latJ) - 1e-10 && lat <= Math.max(latI, latJ) + 1e-10) return true;
                const crosses = (latI > point.lat) !== (latJ > point.lat)
                    && point.lon < (lonJ - lonI) * (point.lat - latI) / (latJ - latI) + lonI;
                if (crosses) inside = !inside;
            }
            return inside;
        }

        function seaBoundaryDistanceKm(lat, lon) {
            const cosLat = Math.cos(lat * Math.PI / 180);
            let nearest = Infinity;
            for (let i = 0; i < SEA_POLYGON.length; i++) {
                const a = SEA_POLYGON[i], b = SEA_POLYGON[(i + 1) % SEA_POLYGON.length];
                const ax = (a[1] - lon) * 111.32 * cosLat, ay = (a[0] - lat) * 111.32;
                const bx = (b[1] - lon) * 111.32 * cosLat, by = (b[0] - lat) * 111.32;
                const length2 = (bx - ax) ** 2 + (by - ay) ** 2;
                const part = length2 ? Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / length2)) : 0;
                nearest = Math.min(nearest, Math.hypot(ax + part * (bx - ax), ay + part * (by - ay)));
            }
            return nearest;
        }

        function isNavigableWater(lat, lon, clearanceKm = 5) {
            return isWater(lat, lon) && seaBoundaryDistanceKm(lat, lon) >= clearanceKm;
        }

        function waterSegment(from, to, clearanceKm = 5) {
            for (let i = 0; i <= 6; i++) {
                const part = i / 6;
                const lat = from.lat + (to.lat - from.lat) * part;
                const lon = from.lon + (to.lon - from.lon) * part;
                if (i === 0 && clearanceKm === 0 ? !isWater(lat, lon) : !isNavigableWater(lat, lon, clearanceKm)) return false;
            }
            return true;
        }

        function distanceKm(a, b) {
            const radians = Math.PI / 180;
            const dLat = (b.lat - a.lat) * radians, dLon = (b.lon - a.lon) * radians;
            const lat1 = a.lat * radians, lat2 = b.lat * radians;
            const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
            return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
        }

        function bearingBetween(a, b) {
            const radians = Math.PI / 180;
            const lat1 = a.lat * radians, lat2 = b.lat * radians;
            const dLon = (b.lon - a.lon) * radians;
            return (Math.atan2(
                Math.sin(dLon) * Math.cos(lat2),
                Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
            ) * 180 / Math.PI + 360) % 360;
        }

        function destinationPoint(point, bearingDeg, distance) {
            const angular = distance / 6371, bearing = bearingDeg * Math.PI / 180;
            const lat1 = point.lat * Math.PI / 180, lon1 = point.lon * Math.PI / 180;
            const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular)
                + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
            const lon2 = lon1 + Math.atan2(
                Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
                Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2)
            );
            return { lat: lat2 * 180 / Math.PI, lon: (lon2 * 180 / Math.PI + 540) % 360 - 180 };
        }

        function randomFor(seed) {
            let state = 0;
            for (let i = 0; i < seed.length; i++) state = (Math.imul(state, 31) + seed.charCodeAt(i)) >>> 0;
            return () => {
                state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
                return state / 4294967296;
            };
        }

        function driftCentroid(spill, hoursFromDetection) {
            const angle = (spill.drift.directionDeg + (hoursFromDetection < 0 ? 180 : 0)) * Math.PI / 180;
            const distanceKm = spill.drift.speedKnots * Math.abs(hoursFromDetection) * 1.852;
            const lat = spill.centroid.lat + distanceKm * Math.cos(angle) / 111;
            const lon = spill.centroid.lon + distanceKm * Math.sin(angle) / (111 * Math.max(.15, Math.cos(lat * Math.PI / 180)));
            return { lat, lon };
        }

        function polygonAt(spill, centroid, scale) {
            return spill.polygon.map(([lat, lon]) => [
                centroid.lat + (lat - spill.centroid.lat) * scale,
                centroid.lon + (lon - spill.centroid.lon) * scale
            ]);
        }

        function spillSegmentIsWater(spill, from, to, fromScale, toScale) {
            for (let i = 0; i <= 6; i++) {
                const part = i / 6, center = {
                    lat: from.lat + (to.lat - from.lat) * part,
                    lon: from.lon + (to.lon - from.lon) * part
                };
                const scale = fromScale + (toScale - fromScale) * part;
                if (!isWater(center.lat, center.lon)
                    || polygonAt(spill, center, scale).some(([lat, lon]) => !isWater(lat, lon))) return false;
            }
            return true;
        }

        // Rewinds a spill, steering in small increments if land blocks the reversed drift.
        function backtrackSpill(spill, hoursBack) {
            const totalHours = Math.max(0, Math.min(48, Number(hoursBack) || 0));
            const steps = Math.ceil(totalHours * 2), detected = Date.parse(spill.detectedAt);
            const track = [{
                t: new Date(detected).toISOString(),
                polygon: polygonAt(spill, spill.centroid, 1),
                centroid: { ...spill.centroid }, uncertaintyKm: 1.5, adjusted: false
            }];
            let center = { ...spill.centroid }, previousScale = 1, uncertaintyKm = 1.5;
            for (let index = 1; index <= steps; index++) {
                const elapsed = Math.min(index * .5, totalHours);
                const scale = Math.max(.7, 1 - elapsed * .3 / 48);
                const speed = spill.drift.speedKnots * .5 * 1.852;
                const reverseBearing = (spill.drift.directionDeg + 180) % 360;
                let next = null, chosenOffset = 0;
                for (let degree = 0; degree <= 60 && !next; degree += 5) {
                    const offsets = degree ? [degree, -degree] : [0];
                    for (const offset of offsets) {
                        const candidate = destinationPoint(center, reverseBearing + offset, speed);
                        if (spillSegmentIsWater(spill, center, candidate, previousScale, scale)) {
                            next = candidate;
                            chosenOffset = offset;
                            break;
                        }
                    }
                }
                if (next) center = next;
                if (!next) uncertaintyKm += 2;
                else if (chosenOffset) uncertaintyKm += Math.abs(chosenOffset) * .12 + .2;
                track.push({
                    t: new Date(detected - elapsed * HOUR_MS).toISOString(),
                    polygon: polygonAt(spill, center, scale),
                    centroid: { ...center }, uncertaintyKm,
                    adjusted: Boolean(chosenOffset) || !next
                });
                previousScale = scale;
            }
            return track;
        }

        function forwardSpillTrack(spill, hoursForward = 48) {
            const totalHours = Math.max(0, Math.min(48, Number(hoursForward) || 0));
            const steps = Math.ceil(totalHours * 2), detected = Date.parse(spill.detectedAt);
            const track = [{
                t: new Date(detected).toISOString(),
                polygon: polygonAt(spill, spill.centroid, 1),
                centroid: { ...spill.centroid }, beached: false
            }];
            let center = { ...spill.centroid }, beached = false;
            for (let index = 1; index <= steps; index++) {
                const elapsed = Math.min(index * .5, totalHours);
                if (!beached) {
                    const distance = spill.drift.speedKnots * .5 * 1.852;
                    const candidate = destinationPoint(center, spill.drift.directionDeg, distance);
                    if (spillSegmentIsWater(spill, center, candidate, 1, 1)) center = candidate;
                    else {
                        let low = 0, high = 1;
                        for (let attempt = 0; attempt < 14; attempt++) {
                            const part = (low + high) / 2;
                            const partial = destinationPoint(center, spill.drift.directionDeg, distance * part);
                            if (spillSegmentIsWater(spill, center, partial, 1, 1)) low = part;
                            else high = part;
                        }
                        if (low > 0) center = destinationPoint(center, spill.drift.directionDeg, distance * low);
                        beached = true;
                    }
                }
                track.push({
                    t: new Date(detected + elapsed * HOUR_MS).toISOString(),
                    polygon: polygonAt(spill, center, 1),
                    centroid: { ...center }, beached
                });
            }
            return track;
        }

        function interpolateTrackState(track, time) {
            if (!track.length) throw new Error("Spill trajectory was empty.");
            for (let i = 0; i < track.length - 1; i++) {
                const firstTime = Date.parse(track[i].t), secondTime = Date.parse(track[i + 1].t);
                if (time < Math.min(firstTime, secondTime) || time > Math.max(firstTime, secondTime)) continue;
                const part = (time - firstTime) / (secondTime - firstTime);
                const state = {
                    t: new Date(time).toISOString(),
                    centroid: {
                        lat: track[i].centroid.lat + (track[i + 1].centroid.lat - track[i].centroid.lat) * part,
                        lon: track[i].centroid.lon + (track[i + 1].centroid.lon - track[i].centroid.lon) * part
                    },
                    polygon: track[i].polygon.map((point, index) => [
                        point[0] + (track[i + 1].polygon[index][0] - point[0]) * part,
                        point[1] + (track[i + 1].polygon[index][1] - point[1]) * part
                    ]),
                    uncertaintyKm: (track[i].uncertaintyKm || 0)
                        + ((track[i + 1].uncertaintyKm || 0) - (track[i].uncertaintyKm || 0)) * part,
                    beached: track[i].beached || track[i + 1].beached
                };
                if (!isWater(state.centroid.lat, state.centroid.lon)
                    || state.polygon.some(([lat, lon]) => !isWater(lat, lon))) return track[i];
                return state;
            }
            return track.reduce((closest, state) =>
                Math.abs(Date.parse(state.t) - time) < Math.abs(Date.parse(closest.t) - time) ? state : closest
            );
        }

        function moveShipSafely(position, heading, speedKnots, clearanceKm = 5) {
            const offsets = [0];
            for (let degrees = 15; degrees <= 180; degrees += 15) offsets.push(degrees, -degrees);
            const speeds = [];
            for (let speed = Math.max(1, speedKnots); speed > 1; speed -= 1.5) speeds.push(speed);
            speeds.push(1);
            for (const speed of speeds) {
                for (const offset of offsets) {
                    const next = destinationPoint(position, heading + offset, speed * .5 * 1.852);
                    if (waterSegment(position, next, clearanceKm)) {
                        return { position: next, heading: (heading + offset + 360) % 360, speed };
                    }
                }
            }
            return { position, heading, speed: 0 };
        }

        // A 30-minute, steerable track generator; each segment is checked against the water mask.
        const MOCK_DATA = (() => {
            const now = Date.now();
            const region = { name: "Bay of Bengal · Chennai", center: [13.2, 81.65] };
            const spills = [
                {
                    id: "SP-01", detectedAt: new Date(now - 8 * HOUR_MS).toISOString(),
                    centroid: { lat: 13.22, lon: 81.85 },
                    polygon: [[13.18,81.79],[13.27,81.8],[13.3,81.86],[13.27,81.92],[13.22,81.95],[13.17,81.89]],
                    areaKm2: 18.4, drift: { speedKnots: .75, directionDeg: 315 }
                },
                {
                    id: "SP-02", detectedAt: new Date(now - 22 * HOUR_MS).toISOString(),
                    centroid: { lat: 12.88, lon: 82.02 },
                    polygon: [[12.84,81.96],[12.91,81.94],[12.95,82.0],[12.93,82.07],[12.88,82.1],[12.83,82.05]],
                    areaKm2: 11.7, drift: { speedKnots: .8, directionDeg: 230 }
                },
                {
                    id: "SP-03", detectedAt: new Date(now - 35 * HOUR_MS).toISOString(),
                    centroid: { lat: 14.15, lon: 81.72 },
                    polygon: [[14.11,81.66],[14.19,81.66],[14.22,81.72],[14.19,81.79],[14.14,81.81],[14.1,81.75]],
                    areaKm2: 24.2, drift: { speedKnots: 3.1, directionDeg: 270 }
                }
            ];
            const backtracks = new Map(spills.map((spill) => [spill.id, backtrackSpill(spill, 48)]));
            const forwardTracks = new Map(spills.map((spill) => [spill.id, forwardSpillTrack(spill, 48)]));
            const stateForHoursAgo = (spill, hoursAgo) => {
                const time = now - hoursAgo * HOUR_MS;
                return time < Date.parse(spill.detectedAt)
                    ? interpolateTrackState(backtracks.get(spill.id), time)
                    : interpolateTrackState(forwardTracks.get(spill.id), time);
            };
            const seeds = [
                { id:"V-01", name:"Bay Pearl", type:"Product tanker", flag:"IN", start:{lat:12.0,lon:81.0}, heading:20, speed:7, crossing:{spillId:"SP-01",hoursAgo:18}, gaps:[[20,17.5]] },
                { id:"V-02", name:"Coromandel Trader", type:"Container", flag:"SG", start:{lat:14.5,lon:81.4}, heading:205, speed:8, crossing:{spillId:"SP-01",hoursAgo:24}, gaps:[[25,23.5]] },
                { id:"V-03", name:"Eastern Crown", type:"Chemical tanker", flag:"LK", start:{lat:11.4,lon:82.5}, heading:10, speed:9, crossing:{spillId:"SP-02",hoursAgo:30}, gaps:[[31,29]] },
                { id:"V-04", name:"Aqua Meridian", type:"Bulk carrier", flag:"IN", start:{lat:14.7,lon:81.5}, heading:215, speed:12, crossing:{spillId:"SP-03",hoursAgo:40}, gaps:[[41,39]] },
                { id:"V-05", name:"Chola Voyager", type:"Container", flag:"IN", start:{lat:15.3,lon:83.0}, heading:180, speed:6.5 },
                { id:"V-06", name:"Eastern Lantern", type:"Cargo", flag:"BD", start:{lat:10.6,lon:83.2}, heading:5, speed:6 },
                { id:"V-07", name:"Kaveri Spirit", type:"Tanker", flag:"IN", start:{lat:15.6,lon:82.2}, heading:90, speed:5.5 },
                { id:"V-08", name:"Sundarbans Star", type:"General cargo", flag:"BD", start:{lat:11.1,lon:83.5}, heading:260, speed:5.8 },
                { id:"V-09", name:"Lanka Breeze", type:"Container", flag:"LK", start:{lat:16.0,lon:82.3}, heading:110, speed:5.5 },
                { id:"V-10", name:"Eastern Comet", type:"Fishing vessel", flag:"IN", start:{lat:10.7,lon:81.7}, heading:270, speed:5.5 },
                { id:"V-11", name:"Bay Sentinel", type:"Research", flag:"IN", start:{lat:15.1,lon:84.0}, heading:200, speed:5.2, gaps:[[8,7]] },
                { id:"V-12", name:"Monsoon Carrier", type:"Bulk carrier", flag:"SG", start:CHENNAI_PORT, heading:90, speed:4.5, portDeparture:true }
            ];
            const generateShip = (seed) => {
                const random = randomFor(seed.id), path = [];
                const target = seed.crossing
                    ? stateForHoursAgo(spills.find((spill) => spill.id === seed.crossing.spillId), seed.crossing.hoursAgo).centroid
                    : null;
                const targetIndex = seed.crossing ? Math.round((48 - seed.crossing.hoursAgo) * 2) : -1;
                let position = { ...seed.start }, heading = seed.heading;
                for (let index = 0; index <= 96; index++) {
                    let speed = seed.speed * (.92 + random() * .16);
                    if (index > 0) {
                        if (seed.portDeparture && index === 1) speed = Math.max(6.5, speed);
                        const remaining = targetIndex - (index - 1);
                        if (target && index <= targetIndex) {
                            const distance = distanceKm(position, target);
                            const needed = distance / Math.max(1, remaining) / (.5 * 1.852);
                            heading = bearingBetween(position, target);
                            if (index === targetIndex && needed <= seed.speed * 1.5
                                && waterSegment(position, target, 5)) {
                                position = { ...target };
                                speed = Math.max(1, needed);
                            } else {
                                speed = Math.max(1, Math.min(seed.speed * 1.5, needed));
                                heading = (heading + (random() - .5) * 5 + 360) % 360;
                                const moved = moveShipSafely(position, heading, speed, 5);
                                position = moved.position;
                                heading = moved.heading;
                                speed = moved.speed;
                            }
                        } else {
                            if (seed.portDeparture && index <= 3) heading = 90;
                            else if (seed.portDeparture && index === 4) heading = 0;
                            else heading = (heading + (random() - .5) * (seed.portDeparture ? 8 : 12) + 360) % 360;
                            const moved = moveShipSafely(position, heading, speed, seed.portDeparture && index === 1 ? 0 : 5);
                            position = moved.position;
                            heading = moved.heading;
                            speed = moved.speed;
                        }
                    }
                    const hoursAgo = 48 - index * .5;
                    path.push({
                        t: new Date(now - hoursAgo * HOUR_MS).toISOString(),
                        lat: position.lat, lon: position.lon, speed,
                        aisOn: !seed.gaps || !seed.gaps.some(([start, end]) => hoursAgo <= start && hoursAgo >= end)
                    });
                }
                return {
                    id: seed.id, name: seed.name, type: seed.type, flag: seed.flag,
                    portDeparture: Boolean(seed.portDeparture), path
                };
            };
            const ships = seeds.map(generateShip);
            return { now, region, spills, ships, regenerateShip: (id) => generateShip(seeds.find((seed) => seed.id === id)) };
        })();

        const MOCK_NOW = MOCK_DATA.now;
        const MOCK_SPILLS = MOCK_DATA.spills;
        const MOCK_SHIPS = MOCK_DATA.ships;
        let apiFallbackSpills = MOCK_SPILLS;

        function validateShips(shipList) {
            const failures = [];
            shipList.forEach((ship) => {
                ship.path.forEach((point, index) => {
                    if (!isWater(point.lat, point.lon)) failures.push({ shipId: ship.id, sample: index, point });
                    if (index > 0) {
                        const previous = ship.path[index - 1];
                        for (let step = 1; step < 6; step++) {
                            const part = step / 6;
                            const lat = previous.lat + (point.lat - previous.lat) * part;
                            const lon = previous.lon + (point.lon - previous.lon) * part;
                            if (!isWater(lat, lon)) failures.push({ shipId: ship.id, segment: index - 1, part, lat, lon });
                        }
                    }
                });
            });
            if (failures.length) console.warn("Ship water-mask validation found land points.", failures);
            else console.info(`Ship water-mask validation passed for ${shipList.length} vessels.`);
            return failures;
        }

        function validateSpills(spills, backtracks, forwardTracks) {
            const failures = [];
            const check = (spillId, state, source) => {
                if (!isWater(state.centroid.lat, state.centroid.lon)) failures.push({ spillId, source, point: state.centroid });
                (state.polygon || []).forEach(([lat, lon], vertex) => {
                    if (!isWater(lat, lon)) failures.push({ spillId, source, vertex, lat, lon });
                });
            };
            spills.forEach((spill) => {
                check(spill.id, { centroid: spill.centroid, polygon: spill.polygon }, "detected");
                (backtracks.get(spill.id) || []).forEach((state) => check(spill.id, state, "backtrack"));
                (forwardTracks.get(spill.id) || []).forEach((state) => check(spill.id, state, "forward"));
            });
            if (failures.length) console.warn("Spill water-mask validation found land points.", failures);
            else console.info(`Spill water-mask validation passed for ${spills.length} spills and their trajectories.`);
            return failures;
        }

        /** Returns `[{id,detectedAt,centroid:{lat,lon},polygon:[[lat,lon],...],areaKm2,drift:{speedKnots,directionDeg}}]`. */
        async function getSpills() {
            if (USE_MOCK) return MOCK_SPILLS;
            try {
                const response = await fetch(`${API_BASE}/spills`);
                if (!response.ok) throw new Error(`Spill API returned ${response.status}`);
                apiFallbackSpills = await response.json();
                return apiFallbackSpills;
            } catch (error) {
                console.warn("Spill API unavailable; using mock spills.", error);
                apiFallbackSpills = MOCK_SPILLS;
                return MOCK_SPILLS;
            }
        }

        /** Returns `[{id,name,type,flag,portDeparture?,path:[{t,lat,lon,speed,aisOn}]}]`; each path is time-ordered. */
        async function getShips() {
            if (USE_MOCK) return MOCK_SHIPS;
            try {
                const response = await fetch(`${API_BASE}/ships`);
                if (!response.ok) throw new Error(`Ship API returned ${response.status}`);
                return await response.json();
            } catch (error) {
                console.warn("Ship API unavailable; using mock ships.", error);
                return MOCK_SHIPS;
            }
        }

        /** Returns `[{t,polygon:[[lat,lon],...],centroid:{lat,lon},uncertaintyKm?,beached?}]` at 30-minute steps. */
        async function getBacktrack(spillId, hoursBack) {
            const fallback = () => {
                const spill = apiFallbackSpills.find((item) => item.id === spillId)
                    || MOCK_SPILLS.find((item) => item.id === spillId);
                if (!spill) throw new Error(`No spill found for ${spillId}`);
                return backtrackSpill(spill, hoursBack);
            };
            if (USE_MOCK) return fallback();
            try {
                const query = new URLSearchParams({ spillId, hoursBack: String(hoursBack) });
                const response = await fetch(`${API_BASE}/backtrack?${query}`);
                if (!response.ok) throw new Error(`Backtrack API returned ${response.status}`);
                return await response.json();
            } catch (error) {
                console.warn(`Backtrack API unavailable for ${spillId}; using mock trajectory.`, error);
                return fallback();
            }
        }

        const byId = (id) => document.getElementById(id);
        const mapError = byId("mapError");
        if (!window.L) {
            mapError.hidden = false;
            mapError.textContent = "Leaflet did not load. Check your internet connection and reload.";
        } else {
            const minZoom = 1, maxZoom = 18, timelineStart = MOCK_NOW - 48 * HOUR_MS;
            const map = L.map("map", {
                zoomControl: false, preferCanvas: true, scrollWheelZoom: true, touchZoom: true,
                minZoom, maxZoom, zoomSnap: .25, zoomDelta: .5
            }).setView(MOCK_DATA.region.center, 6);
            const baseMapAttribution = "Tiles &copy; Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS user community";
            const baseMaps = {
                light: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
                    maxZoom: 18, maxNativeZoom: 16, attribution: baseMapAttribution
                }),
                dark: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
                    maxZoom: 18, maxNativeZoom: 16, attribution: baseMapAttribution
                })
            };
            let activeBaseMap = baseMaps.light;
            activeBaseMap.addTo(map);
            L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);

            const layers = {
                ships: L.layerGroup(),
                spills: L.layerGroup(),
                weather: L.layerGroup(),
                waterMask: L.layerGroup()
            };
            const selectedRoute = L.layerGroup();
            layers.ships.addLayer(selectedRoute);
            const markers = new Map(), spillLayers = new Map(), suspectRows = new Map();
            let backtracks = new Map(), forwardTracks = new Map();
            const toast = byId("crossingToast"), slider = byId("timeSlider");
            const weightInputs = [
                { id: "proximityWeight", output: "proximityValue", key: "proximityToSpillOrigin" },
                { id: "overlapWeight", output: "overlapValue", key: "timeOverlapWithSpill" },
                { id: "speedWeight", output: "speedValue", key: "speedAnomaly" },
                { id: "gapWeight", output: "gapValue", key: "aisGap" }
            ];
            let spills = [], ships = [], crossingEvents = [], selectedSpillId = "";
            let currentTime = MOCK_NOW, playDirection = -1, animationFrame = 0, previousFrame = 0, reportRun = 0, toastTimer = 0;
            const notifiedCrossings = new Set();

            L.polygon(SEA_POLYGON, {
                color: "#65baff", weight: 2, opacity: .8,
                fillColor: "#328bd1", fillOpacity: .2, dashArray: "7 6"
            }).bindTooltip("Configured ocean mask").addTo(layers.waterMask);
            L.circleMarker([CHENNAI_PORT.lat, CHENNAI_PORT.lon], {
                radius: 5, color: "#fff2bf", weight: 2, fillColor: "#ffbd69", fillOpacity: 1
            }).bindTooltip("Chennai port · departure origin").addTo(layers.ships);

            [
                { center: [13.0, 81.25], radius: 42000, color: "#4b8cff", label: "Chennai coast · Clear" },
                { center: [13.5, 81.8], radius: 53000, color: "#45c8e8", label: "Bay of Bengal · Moderate swell" },
                { center: [12.4, 82.1], radius: 62000, color: "#8f83ff", label: "Southern sector · Forecast cell" },
                { center: [14.2, 81.35], radius: 35000, color: "#4b8cff", label: "Northern sector · Light winds" }
            ].forEach((zone) => {
                L.circle(zone.center, { radius: zone.radius, color: zone.color, weight: 1, opacity: .55, fillColor: zone.color, fillOpacity: .1 })
                    .bindTooltip(zone.label)
                    .addTo(layers.weather);
            });

            function interpolateSpillTrack(track, time) {
                return interpolateTrackState(track, time);
            }

            function spillStateAt(spill, time) {
                const detected = Date.parse(spill.detectedAt);
                if (time < detected) return interpolateSpillTrack(backtracks.get(spill.id), time);
                const forward = forwardTracks.get(spill.id);
                if (forward && forward.length) return interpolateSpillTrack(forward, time);
                const centroid = driftCentroid(spill, Math.min(48, (time - detected) / HOUR_MS));
                return { t: new Date(time).toISOString(), centroid, polygon: polygonAt(spill, centroid, 1), beached: false };
            }

            function pointInPolygon(point, polygon) {
                let inside = false;
                for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
                    const [latI, lonI] = polygon[i], [latJ, lonJ] = polygon[j];
                    const crosses = (latI > point.lat) !== (latJ > point.lat)
                        && point.lon < (lonJ - lonI) * (point.lat - latI) / (latJ - latI) + lonI;
                    if (crosses) inside = !inside;
                }
                return inside;
            }

            function distanceToPolygonKm(point, polygon) {
                if (pointInPolygon(point, polygon)) return 0;
                const cosLat = Math.cos(point.lat * Math.PI / 180);
                let nearest = Infinity;
                for (let i = 0; i < polygon.length; i++) {
                    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
                    const ax = (a[1] - point.lon) * 111.32 * cosLat, ay = (a[0] - point.lat) * 111.32;
                    const bx = (b[1] - point.lon) * 111.32 * cosLat, by = (b[0] - point.lat) * 111.32;
                    const length2 = (bx - ax) ** 2 + (by - ay) ** 2;
                    const part = length2 ? Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / length2)) : 0;
                    nearest = Math.min(nearest, Math.hypot(ax + part * (bx - ax), ay + part * (by - ay)));
                }
                return nearest;
            }

            function interpolateShip(ship, time) {
                const path = ship.path;
                let low = 0, high = path.length - 1;
                while (low < high) {
                    const middle = Math.ceil((low + high) / 2);
                    if (Date.parse(path[middle].t) <= time) low = middle;
                    else high = middle - 1;
                }
                const from = path[low], to = path[Math.min(low + 1, path.length - 1)];
                const span = Date.parse(to.t) - Date.parse(from.t);
                const part = span ? Math.max(0, Math.min(1, (time - Date.parse(from.t)) / span)) : 0;
                const state = {
                    lat: from.lat + (to.lat - from.lat) * part,
                    lon: from.lon + (to.lon - from.lon) * part,
                    speed: from.speed + (to.speed - from.speed) * part,
                    aisOn: from.aisOn && to.aisOn
                };
                if (isWater(state.lat, state.lon)) return state;
                for (let index = low; index >= 0; index--) {
                    if (isWater(path[index].lat, path[index].lon)) return { ...path[index] };
                }
                return state;
            }

            function pointNearSpill(point, spill, time) {
                return distanceToPolygonKm(point, spillStateAt(spill, time).polygon) <= 2;
            }

            function findCrossings() {
                crossingEvents = [];
                ships.forEach((ship) => spills.forEach((spill) => {
                    let inside = false;
                    ship.path.forEach((sample) => {
                        if (!isWater(sample.lat, sample.lon)) {
                            inside = false;
                            return;
                        }
                        const time = Date.parse(sample.t);
                        const hit = pointNearSpill(sample, spill, time);
                        if (hit && !inside) {
                            crossingEvents.push({ ship, spill, time, aisOn: sample.aisOn });
                        }
                        inside = hit;
                    });
                }));
                crossingEvents.sort((a, b) => a.time - b.time);
                byId("crossingCount").textContent = crossingEvents.length;
            }

            function calculateFeatures(ship, spill) {
                const backtrack = backtracks.get(spill.id);
                let closest = { distance: Infinity, time: Date.parse(spill.detectedAt) };
                let overlap = 0, near = [], validSamples = [];
                ship.path.forEach((sample) => {
                    if (!isWater(sample.lat, sample.lon)) return;
                    validSamples.push(sample);
                    const time = Date.parse(sample.t);
                    const point = { lat: sample.lat, lon: sample.lon };
                    const state = spillStateAt(spill, time);
                    const distance = distanceKm(point, state.centroid);
                    if (distance < closest.distance) closest = { distance, time };
                    if (distance <= 25) near.push(sample);
                    if (distanceToPolygonKm(point, state.polygon) <= 2) overlap++;
                });
                const baseline = validSamples.length
                    ? validSamples.reduce((sum, point) => sum + point.speed, 0) / validSamples.length : 0;
                const localSpeed = near.length ? near.reduce((sum, point) => sum + point.speed, 0) / near.length : baseline;
                ship.proximityToSpillOrigin = Math.max(0, 100 * (1 - closest.distance / 50));
                ship.timeOverlapWithSpill = Math.min(100, overlap * 22);
                ship.speedAnomaly = near.length ? Math.max(0, Math.min(100, 100 * (baseline - localSpeed) / Math.max(baseline, 1))) : 0;
                ship.aisGap = near.length ? 100 * near.filter((point) => !point.aisOn).length / near.length : 0;
                ship.closestApproachTime = closest.time;
                ship.backtrackOrigin = backtrack[backtrack.length - 1].centroid;
            }

            function shipIcon(ship) {
                const risk = ship.score >= 72 ? "high" : ship.score >= 52 ? "medium" : "";
                const status = ship.isCrossing ? "crossing" : risk;
                return L.divIcon({
                    className: "ship-icon-shell",
                    html: `<div class="ship-mark"><span class="ship-dot ${status}"></span><span class="ship-code">${ship.id}</span></div>`,
                    iconSize: [42, 22], iconAnchor: [9, 11]
                });
            }

            function popupContent(ship) {
                const state = ship.currentState || {};
                const popup = document.createElement("div");
                popup.className = "ship-popup";
                const name = document.createElement("strong");
                name.textContent = `${ship.flag} · ${ship.name}`;
                const details = document.createElement("span");
                details.textContent = `${ship.type} · ${(state.speed || 0).toFixed(1)} kn`;
                const ais = document.createElement("span");
                ais.textContent = `AIS ${state.aisOn ? "ON" : "GAP"} · mock track`;
                popup.append(name, details, ais);
                return popup;
            }

            function addMapData() {
                spills.forEach((spill) => {
                    const track = backtracks.get(spill.id);
                    const polygon = L.polygon(track[0].polygon, {
                        className: "spill-shape", color: "#c084fc", weight: 2, opacity: .9,
                        fillColor: "#1c1028", fillOpacity: .58
                    }).bindTooltip(`Oil spill · ${spill.id}`).addTo(layers.spills);
                    const trajectory = L.polyline(track.map((state) => [state.centroid.lat, state.centroid.lon]), {
                        className: "spill-trajectory", color: "#c084fc", weight: 2, opacity: .75, dashArray: "7 8"
                    }).addTo(layers.spills);
                    const uncertainty = L.circle(track[track.length - 1].centroid, {
                        radius: 1800, color: "#c084fc", weight: 1, opacity: .55, fillOpacity: .05, dashArray: "4 6"
                    }).addTo(layers.spills);
                    const origin = L.marker(track[track.length - 1].centroid, {
                        icon: L.divIcon({ className: "origin-marker-shell", html: '<span class="origin-pulse"></span>', iconSize: [14, 14], iconAnchor: [7, 7] })
                    }).bindTooltip(`Estimated origin · ${spill.id}`).addTo(layers.spills);
                    const detected = L.circleMarker([spill.centroid.lat, spill.centroid.lon], {
                        radius: 4, color: "#f4d5ff", weight: 1, fillColor: "#a855f7", fillOpacity: 1
                    }).bindTooltip(`Detected position · ${spill.id}`).addTo(layers.spills);
                    const beachLabel = L.marker(spill.centroid, {
                        interactive: false,
                        icon: L.divIcon({
                            className: "beached-label-shell",
                            html: '<span class="beached-label">Reached shore</span>',
                            iconSize: [100, 20], iconAnchor: [50, 10]
                        })
                    });
                    spillLayers.set(spill.id, { polygon, trajectory, uncertainty, origin, detected, beachLabel });
                });

                ships.forEach((ship) => {
                    const points = ship.path.map((point) => [point.lat, point.lon]);
                    L.polyline(points, { color: "#54e6f2", weight: 1.2, opacity: .22, dashArray: "4 8" }).addTo(layers.ships);
                    const marker = L.marker(points[0], { icon: shipIcon(ship), title: `${ship.name} · simulated AIS` })
                        .bindPopup(() => popupContent(ship));
                    marker.addTo(layers.ships);
                    markers.set(ship.id, marker);
                });
            }

            function currentSpill() {
                return spills.find((spill) => spill.id === selectedSpillId) || spills[0];
            }

            function setLayer(inputId, layer, counterId, count) {
                const input = byId(inputId);
                const update = () => {
                    if (input.checked && !map.hasLayer(layer)) map.addLayer(layer);
                    if (!input.checked && map.hasLayer(layer)) map.removeLayer(layer);
                    if (counterId) byId(counterId).textContent = input.checked ? count : "0";
                };
                input.addEventListener("change", update);
                update();
            }

            function updateSpillLayers(time) {
                const states = new Map();
                spills.forEach((spill) => {
                    const state = spillStateAt(spill, time);
                    const layer = spillLayers.get(spill.id);
                    const selected = spill.id === selectedSpillId;
                    const hoursBack = Math.max(0, Math.min(48, (Date.parse(spill.detectedAt) - time) / HOUR_MS));
                    const beached = Boolean(state.beached);
                    layer.polygon.setLatLngs(state.polygon);
                    layer.polygon.setStyle({
                        color: beached ? "#59404a" : selected ? "#e1b4ff" : "#a875d2",
                        fillColor: beached ? "#21191e" : selected ? "#261432" : "#1c1028",
                        weight: beached ? 2 : selected ? 2.5 : 1.5,
                        dashArray: beached ? "4 3" : ""
                    });
                    layer.polygon.setTooltipContent(beached ? `Reached shore · ${spill.id}` : `Oil spill · ${spill.id}`);
                    layer.trajectory.setLatLngs(backtracks.get(spill.id).map((point) => [point.centroid.lat, point.centroid.lon]));
                    layer.trajectory.setStyle({ opacity: selected ? .9 : .4 });
                    const originState = backtracks.get(spill.id).at(-1);
                    const origin = originState.centroid;
                    layer.origin.setLatLng([origin.lat, origin.lon]);
                    layer.uncertainty.setLatLng([origin.lat, origin.lon]);
                    layer.uncertainty.setRadius((1.5 + hoursBack * .32 + (originState.uncertaintyKm || 0)) * 1000);
                    layer.beachLabel.setLatLng([state.centroid.lat, state.centroid.lon]);
                    if (beached && !layers.spills.hasLayer(layer.beachLabel)) layers.spills.addLayer(layer.beachLabel);
                    if (!beached && layers.spills.hasLayer(layer.beachLabel)) layers.spills.removeLayer(layer.beachLabel);
                    states.set(spill.id, state);
                });
                return states;
            }

            function updateShipMarkers(time, states) {
                ships.forEach((ship) => {
                    const state = interpolateShip(ship, time);
                    ship.currentState = state;
                    const point = { lat: state.lat, lon: state.lon };
                    ship.isCrossing = isWater(point.lat, point.lon) && spills.some((spill) =>
                        distanceToPolygonKm(point, states.get(spill.id).polygon) <= 2
                    );
                    const marker = markers.get(ship.id);
                    marker.setLatLng([state.lat, state.lon]);
                    marker.setOpacity(state.aisOn ? 1 : .38);
                    marker.setIcon(shipIcon(ship));
                });
            }

            function formatTime(time, includeDate = true) {
                return new Date(time).toLocaleString([], includeDate
                    ? { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
                    : { hour: "2-digit", minute: "2-digit", hour12: false });
            }

            function showCrossingToast(event) {
                toast.textContent = `Ship ${event.ship.name} crossed spill ${event.spill.id} at ${formatTime(event.time, false)}`;
                toast.classList.add("visible");
                window.clearTimeout(toastTimer);
                toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 4200);
            }

            function notifyCrossings(previous, next) {
                if (previous == null || previous === next) return;
                const min = Math.min(previous, next), max = Math.max(previous, next);
                const event = crossingEvents.find((item) => {
                    const key = `${item.ship.id}:${item.spill.id}:${item.time}`;
                    return item.time > min && item.time <= max && !notifiedCrossings.has(key);
                });
                if (event) {
                    notifiedCrossings.add(`${event.ship.id}:${event.spill.id}:${event.time}`);
                    showCrossingToast(event);
                }
            }

            function updateTimeline(time, notify = true) {
                const previous = currentTime;
                currentTime = Math.max(timelineStart, Math.min(MOCK_NOW, time));
                slider.value = Math.round((currentTime - timelineStart) / (48 * HOUR_MS) * 1000);
                byId("timeValue").textContent = formatTime(currentTime);
                const states = updateSpillLayers(currentTime);
                updateShipMarkers(currentTime, states);
                if (notify) notifyCrossings(previous, currentTime);
            }

            function bindSpillSelect() {
                const select = byId("spillSelector");
                select.replaceChildren();
                spills.forEach((spill) => {
                    const option = document.createElement("option");
                    option.value = spill.id;
                    option.textContent = `${spill.id} · ${spill.areaKm2.toFixed(1)} km²`;
                    select.append(option);
                });
                selectedSpillId = spills[0].id;
                select.value = selectedSpillId;
                select.addEventListener("change", () => {
                    selectedSpillId = select.value;
                    findCrossings();
                    ships.forEach((ship) => calculateFeatures(ship, currentSpill()));
                    updateSuspects();
                    updateTimeline(currentTime, false);
                });
            }

            function updateClock() {
                const now = new Date();
                byId("clockTime").textContent = now.toLocaleTimeString([], { hour12: false });
                byId("clockDate").textContent = now.toLocaleDateString([], { weekday: "short", month: "short", day: "2-digit" }).toUpperCase();
            }

            function updateZoom() {
                const zoom = map.getZoom();
                byId("zoomValue").textContent = `${zoom.toFixed(1)}×`;
                byId("zoomIn").disabled = zoom <= minZoom;
                byId("zoomOut").disabled = zoom >= maxZoom;
            }

            function createSuspectRow(ship) {
                const row = document.createElement("button");
                row.className = "suspect-row";
                row.type = "button";
                row.dataset.shipId = ship.id;
                row.innerHTML = '<div class="suspect-top"><span class="rank"></span><span class="risk-name"></span><span class="risk-score"></span></div><div class="risk-meta"></div><div class="score-track"><span class="score-fill"></span></div>';
                row.addEventListener("click", () => focusShip(ship));
                suspectRows.set(ship.id, row);
                return row;
            }

            function updateSuspects() {
                const total = weightInputs.reduce((sum, item) => sum + Number(byId(item.id).value), 0);
                ships.forEach((ship) => {
                    ship.score = total ? weightInputs.reduce((sum, item) =>
                        sum + ship[item.key] * Number(byId(item.id).value), 0
                    ) / total : 0;
                    markers.get(ship.id).setIcon(shipIcon(ship));
                });
                const list = byId("suspectList");
                const before = new Map([...list.children].map((row) => [row.dataset.shipId, row.getBoundingClientRect().top]));
                const ranked = [...ships].sort((a, b) => b.score - a.score).slice(0, 5);
                const visible = new Set(ranked.map((ship) => ship.id));
                ranked.forEach((ship, index) => {
                    const row = suspectRows.get(ship.id) || createSuspectRow(ship);
                    const score = Math.round(ship.score);
                    const level = score >= 72 ? "high" : score >= 52 ? "medium" : "";
                    row.setAttribute("aria-label", `Rank ${index + 1}: ${ship.name}, score ${score}. Focus vessel.`);
                    row.querySelector(".rank").textContent = `0${index + 1}`;
                    row.querySelector(".risk-name").textContent = ship.name;
                    row.querySelector(".risk-score").textContent = score;
                    row.querySelector(".risk-score").className = `risk-score ${level ? `risk-${level}` : ""}`;
                    row.querySelector(".risk-meta").textContent = `${ship.flag} · ${ship.type} · overlap ${Math.round(ship.timeOverlapWithSpill)}%`;
                    const bar = row.querySelector(".score-fill");
                    bar.className = `score-fill ${level}`;
                    bar.style.width = `${score}%`;
                    list.append(row);
                });
                [...list.children].forEach((row) => { if (!visible.has(row.dataset.shipId)) row.remove(); });
                [...list.children].forEach((row) => {
                    const oldTop = before.get(row.dataset.shipId);
                    const shift = oldTop == null ? 0 : oldTop - row.getBoundingClientRect().top;
                    if (shift) row.animate([{ transform: `translateY(${shift}px)` }, { transform: "translateY(0)" }], { duration: 320, easing: "ease-out" });
                });
                byId("alertCount").textContent = ships.filter((ship) => ship.score >= 72).length;
            }

            function focusShip(ship) {
                const toggle = byId("shipsToggle");
                if (!toggle.checked) {
                    toggle.checked = true;
                    toggle.dispatchEvent(new Event("change"));
                }
                selectedRoute.clearLayers();
                const path = ship.path.map((point) => [point.lat, point.lon]);
                selectedRoute.addLayer(L.polyline(path, { className: "selected-route", color: "#54e6f2", weight: 8, opacity: .2 }));
                selectedRoute.addLayer(L.polyline(path, { color: "#9af4ff", weight: 2.5, opacity: .95 }));
                updateTimeline(ship.closestApproachTime, false);
                map.flyTo([ship.currentState.lat, ship.currentState.lon], Math.max(map.getZoom(), 7), { duration: 1.1 });
                window.setTimeout(() => markers.get(ship.id).openPopup(), 1150);
            }

            function buildReport() {
                const spill = currentSpill();
                const origin = backtracks.get(spill.id).at(-1);
                const top = [...ships].sort((a, b) => b.score - a.score).slice(0, 3);
                const events = crossingEvents.filter((event) => event.spill.id === spill.id);
                const confidence = events.length >= 3 ? "HIGH" : events.length ? "MODERATE" : "LOW";
                return [
                    "OIL SPILL BACKWARD-TRACKING BRIEF",
                    "──────────────────────────────────",
                    `Generated: ${new Date().toLocaleString()}`,
                    "Classification: SIMULATED / TRAINING",
                    `Selected spill: ${spill.id} · ${spill.areaKm2.toFixed(1)} km²`,
                    `Detected: ${formatTime(Date.parse(spill.detectedAt))}`,
                    `Estimated origin: ${origin.centroid.lat.toFixed(4)}°N, ${origin.centroid.lon.toFixed(4)}°E`,
                    `Origin time: ${formatTime(Date.parse(origin.t))}`,
                    `Confidence: ${confidence}`,
                    "",
                    "TOP 3 SUSPECTS",
                    ...top.map((ship, index) => `${index + 1}. ${ship.name} (${ship.flag}) — ${Math.round(ship.score)}/100`),
                    "",
                    "CROSSING TIMELINE",
                    ...(events.length
                        ? events.map((event) => `${formatTime(event.time)} · ${event.ship.name} · AIS ${event.aisOn ? "ON" : "GAP"}`)
                        : ["No modeled crossings for this spill."]),
                    "",
                    "All vessel tracks, spill measurements, and confidence scores are mock data; verify against trusted sources."
                ].join("\n");
            }

            function typeReport(text) {
                const run = ++reportRun, output = byId("reportOutput");
                output.textContent = "";
                return new Promise((resolve) => {
                    let position = 0;
                    const typeChunk = () => {
                        if (run !== reportRun) return resolve();
                        position += 4;
                        output.textContent = text.slice(0, position);
                        if (position < text.length) window.setTimeout(typeChunk, 10);
                        else resolve();
                    };
                    typeChunk();
                });
            }

            function downloadPdf(reportText) {
                const encoder = new TextEncoder();
                const lines = reportText
                    .replace(/[^\x20-\x7E\n]/g, " ")
                    .split("\n")
                    .flatMap((line) => {
                        const wrapped = [];
                        while (line.length > 92) {
                            let cut = line.lastIndexOf(" ", 92);
                            if (cut < 1) cut = 92;
                            wrapped.push(line.slice(0, cut));
                            line = line.slice(cut).trimStart();
                        }
                        wrapped.push(line);
                        return wrapped;
                    });
                const pageLines = [];
                for (let index = 0; index < lines.length; index += 48) pageLines.push(lines.slice(index, index + 48));
                const objects = [
                    "<< /Type /Catalog /Pages 2 0 R >>",
                    "",
                    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
                ];
                const pageIds = pageLines.map((_, index) => 4 + index * 2);
                objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
                pageLines.forEach((page, index) => {
                    const pageId = 4 + index * 2, contentId = pageId + 1;
                    const commands = [
                        "BT",
                        "/F1 10 Tf",
                        "50 750 Td",
                        "14 TL",
                        ...page.map((line) => `(${line.replace(/([\\()])/g, "\\$1")}) Tj T*`),
                        "ET"
                    ].join("\n");
                    objects.push(
                        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
                        `<< /Length ${encoder.encode(commands).length} >>\nstream\n${commands}\nendstream`
                    );
                });
                let pdf = "%PDF-1.4\n";
                const offsets = [0];
                objects.forEach((object, index) => {
                    offsets.push(encoder.encode(pdf).length);
                    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
                });
                const xrefOffset = encoder.encode(pdf).length;
                pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
                offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, "0")} 00000 n \n`; });
                pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
                const blob = new Blob([pdf], { type: "application/pdf" });
                const url = URL.createObjectURL(blob), anchor = document.createElement("a");
                const spillId = currentSpill().id.toLowerCase();
                anchor.href = url;
                anchor.download = `incident-report-${spillId}.pdf`;
                document.body.append(anchor);
                anchor.click();
                anchor.remove();
                window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }

            function initializeDraggablePanels() {
                const panels = [...document.querySelectorAll(".draggable-panel")];
                const viewportMargin = 8;
                const initialRects = new Map(panels.map((panel) => [panel.id, panel.getBoundingClientRect()]));
                const rightTop = Math.max(8, document.querySelector(".topbar").getBoundingClientRect().bottom + 12);
                const rightHeights = {
                    suspectsPanel: 286,
                    weightsPanel: 212,
                    reportPanel: 236
                };
                const rightIds = ["suspectsPanel", "weightsPanel", "reportPanel"];
                const availableRightHeight = Math.max(160, window.innerHeight - rightTop - viewportMargin - 24);
                const requestedRightHeight = rightIds.reduce((sum, id) => sum + rightHeights[id], 0);
                if (requestedRightHeight > availableRightHeight) {
                    rightIds.forEach((id) => {
                        rightHeights[id] = Math.max(48, Math.floor(rightHeights[id] * availableRightHeight / requestedRightHeight));
                    });
                }
                const rightPositions = new Map();
                let nextRightTop = rightTop;
                rightIds.forEach((id) => {
                    rightPositions.set(id, nextRightTop);
                    nextRightTop += rightHeights[id] + 12;
                });
                document.body.classList.add("panels-ready");
                const clampPanel = (panel) => {
                    const maxLeft = Math.max(viewportMargin, window.innerWidth - panel.offsetWidth - viewportMargin);
                    const maxTop = Math.max(viewportMargin, window.innerHeight - panel.offsetHeight - viewportMargin);
                    panel.style.left = `${Math.max(viewportMargin, Math.min(maxLeft, parseFloat(panel.style.left) || 0))}px`;
                    panel.style.top = `${Math.max(viewportMargin, Math.min(maxTop, parseFloat(panel.style.top) || 0))}px`;
                };
                panels.forEach((panel) => {
                    const rect = initialRects.get(panel.id);
                    const panelName = [...panel.querySelector("h2").childNodes]
                        .filter((node) => node.nodeType === Node.TEXT_NODE)
                        .map((node) => node.textContent.trim())
                        .join(" ");
                    const width = Math.min(rect.width, window.innerWidth - viewportMargin * 2);
                    const height = rightHeights[panel.id] || Math.min(rect.height, window.innerHeight - viewportMargin * 2);
                    panel.style.width = `${width}px`;
                    panel.style.height = `${height}px`;
                    const left = rightIds.includes(panel.id)
                        ? window.innerWidth - width - viewportMargin : rect.left;
                    const top = rightPositions.has(panel.id)
                        ? rightPositions.get(panel.id)
                        : panel.id === "timePanel" ? window.innerHeight - height - 12 : rect.top;
                    panel.style.left = `${left}px`;
                    panel.style.top = `${top}px`;
                    panel.querySelector(".panel-minimize").addEventListener("click", (event) => {
                        const button = event.currentTarget;
                        const collapsed = panel.classList.toggle("collapsed");
                        button.setAttribute("aria-expanded", String(!collapsed));
                        button.setAttribute("aria-label", `${collapsed ? "Expand" : "Minimize"} ${panelName}`);
                        button.textContent = collapsed ? "+" : "−";
                    });
                    const handle = panel.querySelector(".panel-drag-handle");
                    handle.addEventListener("pointerdown", (event) => {
                        if (window.matchMedia("(max-width: 560px)").matches) return;
                        if (event.button !== 0 || event.target.closest("button, input, select, a")) return;
                        event.preventDefault();
                        panel.style.zIndex = String(710 + panels.indexOf(panel));
                        const startX = event.clientX, startY = event.clientY;
                        const startLeft = parseFloat(panel.style.left) || 0;
                        const startTop = parseFloat(panel.style.top) || 0;
                        const move = (pointerEvent) => {
                            const maxLeft = Math.max(viewportMargin, window.innerWidth - panel.offsetWidth - viewportMargin);
                            const maxTop = Math.max(viewportMargin, window.innerHeight - panel.offsetHeight - viewportMargin);
                            panel.style.left = `${Math.max(viewportMargin, Math.min(maxLeft, startLeft + pointerEvent.clientX - startX))}px`;
                            panel.style.top = `${Math.max(viewportMargin, Math.min(maxTop, startTop + pointerEvent.clientY - startY))}px`;
                        };
                        const stop = () => {
                            window.removeEventListener("pointermove", move);
                            window.removeEventListener("pointerup", stop);
                            window.removeEventListener("pointercancel", stop);
                        };
                        window.addEventListener("pointermove", move);
                        window.addEventListener("pointerup", stop);
                        window.addEventListener("pointercancel", stop);
                    });
                    clampPanel(panel);
                });
                window.addEventListener("resize", () => panels.forEach(clampPanel));
            }

            function setPlayback(playing) {
                const button = byId("playButton");
                button.setAttribute("aria-pressed", String(playing));
                button.setAttribute("aria-label", playing ? "Pause playback" : "Play playback");
                byId("playIcon").textContent = playing ? "Ⅱ" : "▶";
                byId("playText").textContent = playing ? "Pause" : "Play";
                if (!playing) cancelAnimationFrame(animationFrame);
            }

            function animateTimeline(timestamp) {
                if (!previousFrame) previousFrame = timestamp;
                const elapsed = Math.min(timestamp - previousFrame, 100);
                previousFrame = timestamp;
                updateTimeline(currentTime + elapsed * HOUR_MS / 1000 * Number(byId("playSpeed").value) * playDirection);
                if ((playDirection < 0 && currentTime <= timelineStart) || (playDirection > 0 && currentTime >= MOCK_NOW)) {
                    setPlayback(false);
                    return;
                }
                animationFrame = requestAnimationFrame(animateTimeline);
            }

            function bindControls() {
                byId("zoomIn").addEventListener("click", () => map.zoomIn());
                byId("zoomOut").addEventListener("click", () => map.zoomOut());
                map.on("zoomend", updateZoom);
                byId("basemapTheme").addEventListener("change", (event) => {
                    const theme = event.currentTarget.value;
                    const nextBaseMap = baseMaps[theme];
                    if (!nextBaseMap || nextBaseMap === activeBaseMap) return;
                    map.removeLayer(activeBaseMap);
                    activeBaseMap = nextBaseMap;
                    activeBaseMap.addTo(map);
                    document.body.classList.toggle("map-dark-theme", theme === "dark");
                    byId("map").setAttribute("aria-label", `${theme === "dark" ? "Dark" : "Light"} maritime operations map`);
                });
                byId("playButton").addEventListener("click", () => {
                    const playing = byId("playButton").getAttribute("aria-pressed") !== "true";
                    setPlayback(playing);
                    if (playing) {
                        previousFrame = 0;
                        animationFrame = requestAnimationFrame(animateTimeline);
                    }
                });
                byId("directionButton").addEventListener("click", () => {
                    playDirection *= -1;
                    byId("directionButton").textContent = playDirection < 0 ? "⟵ Backward" : "Forward ⟶";
                });
                slider.addEventListener("input", () => updateTimeline(timelineStart + Number(slider.value) / 1000 * 48 * HOUR_MS));
                weightInputs.forEach(({ id, output }) => byId(id).addEventListener("input", () => {
                    byId(output).textContent = `${byId(id).value}%`;
                    updateSuspects();
                }));
                byId("generateReport").addEventListener("click", () => typeReport(buildReport()));
                byId("downloadReport").addEventListener("click", async () => {
                    const report = buildReport();
                    await typeReport(report);
                    downloadPdf(report);
                });
            }

            async function startDashboard() {
                [spills, ships] = await Promise.all([getSpills(), getShips()]);
                backtracks = new Map(await Promise.all(spills.map(async (spill) =>
                    [spill.id, await getBacktrack(spill.id, 48)]
                )));
                forwardTracks = new Map(spills.map((spill) => [
                    spill.id, USE_MOCK ? forwardSpillTrack(spill, 48) : []
                ]));
                let shipFailures = validateShips(ships);
                if (USE_MOCK && shipFailures.length) {
                    const invalidIds = new Set(shipFailures.map((failure) => failure.shipId));
                    ships = ships.map((ship) => invalidIds.has(ship.id) ? MOCK_DATA.regenerateShip(ship.id) : ship);
                    shipFailures = validateShips(ships);
                }
                const spillFailures = validateSpills(spills, backtracks, forwardTracks);
                const landPoints = shipFailures.length + spillFailures.length;
                const badge = byId("validationBadge");
                badge.textContent = `Simulation validated: ${landPoints} points on land`;
                badge.classList.toggle("invalid", landPoints > 0);
                console.info("Water mask startup validation", {
                    waterMaskVertices: SEA_POLYGON.length,
                    ships: ships.length,
                    spills: spills.length,
                    pointsOnLand: landPoints
                });
                selectedSpillId = spills[0].id;
                bindSpillSelect();
                addMapData();
                setLayer("shipsToggle", layers.ships, "trackCount", ships.length);
                setLayer("waterMaskToggle", layers.waterMask);
                setLayer("spillsToggle", layers.spills, "spillCount", spills.length);
                setLayer("weatherToggle", layers.weather, "zoneCount", 4);
                findCrossings();
                ships.forEach((ship) => calculateFeatures(ship, currentSpill()));
                updateSuspects();
                initializeDraggablePanels();
                bindControls();
                updateTimeline(MOCK_NOW, false);
                updateClock();
                updateZoom();
                window.setInterval(updateClock, 1000);
            }

            startDashboard().catch((error) => {
                console.error("Could not initialize the incident dashboard.", error);
                mapError.hidden = false;
                mapError.textContent = "The incident data could not be loaded.";
            });
        }
