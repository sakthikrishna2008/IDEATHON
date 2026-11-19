const oceanMapElement = document.getElementById("oceanMap");
const mapStatus = document.getElementById("mapStatus");
const shipStatus = document.getElementById("shipStatus");
const shipStatusMessage = document.getElementById("shipStatusMessage");
const resetMapButton = document.getElementById("resetMap");
const defaultMapView = { center: [-155, 4], zoom: 3 };
const maxNativeZoom = 10;
const apiOrigin = window.location.protocol === "file:" ? "http://127.0.0.1:8000" : "";

if (typeof maplibregl === "undefined") {
    mapStatus.textContent = "The map library could not load. Check your internet connection and reload.";
    mapStatus.dataset.error = "true";
    shipStatusMessage.textContent = "The map library could not load.";
    shipStatus.dataset.error = "true";
} else {
    const isDark = document.body.classList.contains("dark-mode");
    const oceanMap = new maplibregl.Map({
        container: oceanMapElement,
        center: defaultMapView.center,
        zoom: defaultMapView.zoom,
        minZoom: 1,
        maxZoom: maxNativeZoom,
        projection: { type: "globe" },
        renderWorldCopies: false,
        attributionControl: false,
        style: {
            version: 8,
            sources: {
                "ocean-light": {
                    type: "raster",
                    tiles: [
                        "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}"
                    ],
                    tileSize: 256,
                    maxzoom: maxNativeZoom,
                    attribution:
                        'Tiles &copy; <a href="https://www.esri.com/">Esri</a>, GEBCO, NOAA, National Geographic, Garmin, HERE, Geonames.org and other contributors'
                },
                "ocean-reference": {
                    type: "raster",
                    tiles: [
                        "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}"
                    ],
                    tileSize: 256,
                    maxzoom: maxNativeZoom,
                    attribution:
                        'Ocean names and feature labels &copy; <a href="https://www.esri.com/">Esri</a> and contributors'
                },
                "ocean-dark": {
                    type: "raster",
                    tiles: [
                        "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
                    ],
                    tileSize: 256,
                    maxzoom: maxNativeZoom,
                    attribution:
                        "Tiles &copy; Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS user community"
                }
            },
            layers: [
                {
                    id: "ocean-light-layer",
                    type: "raster",
                    source: "ocean-light",
                    layout: { visibility: isDark ? "none" : "visible" }
                },
                {
                    id: "ocean-dark-layer",
                    type: "raster",
                    source: "ocean-dark",
                    layout: { visibility: isDark ? "visible" : "none" }
                },
                {
                    id: "ocean-reference-layer",
                    type: "raster",
                    source: "ocean-reference",
                    layout: { visibility: isDark ? "none" : "visible" }
                }
            ]
        }
    });

    oceanMap.addControl(new maplibregl.NavigationControl(), "bottom-right");
    oceanMap.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    oceanMap.addControl(
        new maplibregl.AttributionControl({ compact: true }),
        "bottom-left"
    );

    let mapLoaded = false;
    let shipLayersReady = false;
    let requestedDarkTheme = isDark;
    let boundsUpdateTimer;

    const setMapTheme = (darkTheme) => {
        requestedDarkTheme = darkTheme;
        if (!mapLoaded) {
            return;
        }

        oceanMap.setLayoutProperty("ocean-light-layer", "visibility", darkTheme ? "none" : "visible");
        oceanMap.setLayoutProperty("ocean-reference-layer", "visibility", darkTheme ? "none" : "visible");
        oceanMap.setLayoutProperty("ocean-dark-layer", "visibility", darkTheme ? "visible" : "none");

        if (shipLayersReady) {
            oceanMap.setPaintProperty("live-ship-points", "circle-color", darkTheme ? "#55e6ff" : "#075b83");
            oceanMap.setPaintProperty("live-ship-points", "circle-stroke-color", darkTheme ? "#f5fcff" : "#ffffff");
        }
    };

    const setShipStatus = (message, isError) => {
        shipStatusMessage.textContent = message;
        if (isError) {
            shipStatus.dataset.error = "true";
        } else {
            delete shipStatus.dataset.error;
        }
    };

    const makeShipFeatureCollection = (ships) => ({
        type: "FeatureCollection",
        features: ships.map((ship) => ({
            type: "Feature",
            geometry: {
                type: "Point",
                coordinates: [ship.longitude, ship.latitude]
            },
            properties: {
                name: ship.name || "Unknown vessel",
                mmsi: ship.mmsi || "Unknown",
                speed: ship.speed,
                course: ship.course,
                lastSeen: ship.lastSeen
            }
        }))
    });

    const displayShipPopup = (event) => {
        const feature = event.features && event.features[0];
        if (!feature) {
            return;
        }

        const properties = feature.properties;
        const content = document.createElement("div");
        content.className = "ship-popup";
        const name = document.createElement("strong");
        name.textContent = properties.name || "Unknown vessel";
        content.appendChild(name);

        const details = [
            ["MMSI", properties.mmsi],
            ["Speed", properties.speed == null ? null : `${properties.speed} kn`],
            ["Course", properties.course == null ? null : `${properties.course}°`],
            ["Last received", properties.lastSeen]
        ];

        details.forEach(([label, value]) => {
            if (value == null || value === "") {
                return;
            }
            const row = document.createElement("div");
            row.textContent = `${label}: ${value}`;
            content.appendChild(row);
        });

        new maplibregl.Popup({ closeButton: true, maxWidth: "280px" })
            .setLngLat(event.lngLat)
            .setDOMContent(content)
            .addTo(oceanMap);
    };

    const normalizeLongitude = (longitude) => ((longitude + 180) % 360 + 360) % 360 - 180;

    const getAISBoundingBoxes = () => {
        const center = oceanMap.getCenter();
        const visibleBounds = oceanMap.getBounds();
        const zoom = oceanMap.getZoom();
        const maxLongitudeSpan = zoom < 4 ? 30 : 60;
        const maxLatitudeSpan = zoom < 4 ? 20 : 40;
        const longitudeSpan = Math.max(8, Math.min(maxLongitudeSpan, visibleBounds.getEast() - visibleBounds.getWest()));
        const latitudeSpan = Math.max(6, Math.min(maxLatitudeSpan, visibleBounds.getNorth() - visibleBounds.getSouth()));
        const normalizedCenter = normalizeLongitude(center.lng);
        const west = normalizedCenter - longitudeSpan / 2;
        const east = normalizedCenter + longitudeSpan / 2;
        const north = Math.min(85, center.lat + latitudeSpan / 2);
        const south = Math.max(-85, center.lat - latitudeSpan / 2);

        if (west < -180) {
            return [
                [[north, west + 360], [south, 180]],
                [[north, -180], [south, east]]
            ];
        }
        if (east > 180) {
            return [
                [[north, west], [south, 180]],
                [[north, -180], [south, east - 360]]
            ];
        }
        return [[[north, west], [south, east]]];
    };

    const sendAISBounds = async () => {
        try {
            const response = await fetch(`${apiOrigin}/api/bounds`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ bounds: getAISBoundingBoxes() })
            });
            if (!response.ok) {
                throw new Error(`AIS server returned ${response.status}`);
            }
        } catch {
            setShipStatus("Start server.py and open the map at http://127.0.0.1:8000/map.html.", true);
        }
    };

    const scheduleAISBoundsUpdate = () => {
        window.clearTimeout(boundsUpdateTimer);
        boundsUpdateTimer = window.setTimeout(sendAISBounds, 750);
    };

    const refreshShips = async () => {
        try {
            const response = await fetch(`${apiOrigin}/api/ships`, { cache: "no-store" });
            if (!response.ok) {
                throw new Error(`AIS server returned ${response.status}`);
            }

            const data = await response.json();
            if (shipLayersReady) {
                oceanMap.getSource("live-ships").setData(makeShipFeatureCollection(data.ships));
            }

            if (!data.configured) {
                setShipStatus("Create a free AISStream key and set AISSTREAM_API_KEY on the server.");
            } else if (!data.connected) {
                setShipStatus(data.message || "Connecting to the live AIS feed…");
            } else if (data.ships.length === 0) {
                setShipStatus("AIS connected · waiting for ship reports in this area.");
            } else {
                setShipStatus(`${data.ships.length} live ships in this area · click a marker for details.`);
            }
        } catch {
            setShipStatus("Start server.py and open the map at http://127.0.0.1:8000/map.html.", true);
            if (shipLayersReady) {
                oceanMap.getSource("live-ships").setData(makeShipFeatureCollection([]));
            }
        } finally {
            window.setTimeout(refreshShips, 5000);
        }
    };

    oceanMap.on("load", () => {
        mapLoaded = true;
        oceanMap.setProjection({ type: "globe" });
        mapStatus.hidden = true;
        setMapTheme(requestedDarkTheme);

        oceanMap.addSource("live-ships", {
            type: "geojson",
            data: makeShipFeatureCollection([])
        });
        oceanMap.addLayer({
            id: "live-ship-points",
            type: "circle",
            source: "live-ships",
            paint: {
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 3, 10, 7],
                "circle-color": requestedDarkTheme ? "#55e6ff" : "#075b83",
                "circle-stroke-width": 1.5,
                "circle-stroke-color": requestedDarkTheme ? "#f5fcff" : "#ffffff"
            }
        });
        shipLayersReady = true;
        setMapTheme(requestedDarkTheme);

        oceanMap.on("click", "live-ship-points", displayShipPopup);
        oceanMap.on("mouseenter", "live-ship-points", () => {
            oceanMap.getCanvas().style.cursor = "pointer";
        });
        oceanMap.on("mouseleave", "live-ship-points", () => {
            oceanMap.getCanvas().style.cursor = "";
        });

        scheduleAISBoundsUpdate();
        refreshShips();
    });

    oceanMap.on("error", () => {
        if (!mapLoaded) {
            mapStatus.textContent = "The map could not load. Check your internet connection and reload.";
            mapStatus.dataset.error = "true";
        }
    });

    document.addEventListener("site-theme-change", (event) => {
        setMapTheme(event.detail.isDark);
    });
    oceanMap.on("moveend", scheduleAISBoundsUpdate);

    resetMapButton.addEventListener("click", () => {
        oceanMap.flyTo({
            center: defaultMapView.center,
            zoom: defaultMapView.zoom,
            bearing: 0,
            pitch: 0
        });
    });
}
