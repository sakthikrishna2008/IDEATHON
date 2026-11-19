import asyncio
import json
import math
import os
import random
import threading
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from websockets.asyncio.client import connect


ROOT = Path(__file__).resolve().parent
AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream"
API_KEY = os.environ.get("AISSTREAM_API_KEY", "").strip()
DEFAULT_BOUNDS = [[[14, -168], [-14, -142]]]
POSITION_MAX_AGE_SECONDS = 15 * 60


class AISState:
    def __init__(self):
        self.lock = threading.Lock()
        self.bounds = DEFAULT_BOUNDS
        self.ships = {}
        self.connected = False
        self.message = ""
        self.last_message_at = None

    def get_bounds(self):
        with self.lock:
            return json.loads(json.dumps(self.bounds))

    def set_bounds(self, bounds):
        if not isinstance(bounds, list) or not 1 <= len(bounds) <= 4:
            raise ValueError("Provide between one and four map bounds.")

        validated = []
        for box in bounds:
            if not isinstance(box, list) or len(box) != 2:
                raise ValueError("Each bound must contain two latitude/longitude points.")

            points = []
            for point in box:
                if not isinstance(point, list) or len(point) != 2:
                    raise ValueError("Each point must contain latitude and longitude.")
                latitude, longitude = point
                if (
                    not isinstance(latitude, (int, float))
                    or not isinstance(longitude, (int, float))
                    or not math.isfinite(latitude)
                    or not math.isfinite(longitude)
                ):
                    raise ValueError("Map bounds must use finite numbers.")
                if not -85 <= latitude <= 85 or not -180 <= longitude <= 180:
                    raise ValueError("Map bounds are outside the supported range.")
                points.append([float(latitude), float(longitude)])

            north, west = points[0]
            south, east = points[1]
            if north < south or west > east:
                raise ValueError("Bounds must be ordered northwest to southeast.")
            validated.append(points)

        with self.lock:
            self.bounds = validated

    def set_connection(self, connected, message=""):
        with self.lock:
            self.connected = connected
            self.message = message

    def add_position(self, metadata, report):
        latitude = metadata.get("Latitude", report.get("Latitude"))
        longitude = metadata.get("Longitude", report.get("Longitude"))
        mmsi = metadata.get("MMSI", report.get("UserID"))

        if (
            not isinstance(latitude, (int, float))
            or not isinstance(longitude, (int, float))
            or not math.isfinite(latitude)
            or not math.isfinite(longitude)
            or not -90 <= latitude <= 90
            or not -180 <= longitude <= 180
            or mmsi is None
            or report.get("Valid") is False
        ):
            return

        received_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        ship = {
            "mmsi": str(mmsi),
            "name": str(metadata.get("ShipName") or "Unknown vessel").strip(),
            "latitude": float(latitude),
            "longitude": float(longitude),
            "speed": finite_number(report.get("Sog")),
            "course": finite_number(report.get("Cog")),
            "lastSeen": received_at,
            "_receivedAt": time.time(),
        }

        with self.lock:
            self.ships[ship["mmsi"]] = ship
            self.last_message_at = received_at

    def snapshot(self):
        now = time.time()
        with self.lock:
            expired = [
                mmsi
                for mmsi, ship in self.ships.items()
                if now - ship["_receivedAt"] > POSITION_MAX_AGE_SECONDS
            ]
            for mmsi in expired:
                del self.ships[mmsi]

            bounds = self.bounds
            visible_ships = []
            for ship in self.ships.values():
                if any(
                    south_east[0] <= ship["latitude"] <= north_west[0]
                    and north_west[1] <= ship["longitude"] <= south_east[1]
                    for north_west, south_east in bounds
                ):
                    visible_ships.append(
                        {key: value for key, value in ship.items() if not key.startswith("_")}
                    )

            visible_ships.sort(key=lambda ship: ship["lastSeen"], reverse=True)
            return {
                "configured": bool(API_KEY),
                "connected": self.connected,
                "message": self.message,
                "lastMessageAt": self.last_message_at,
                "ships": visible_ships[:1000],
            }


def finite_number(value):
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


state = AISState()


async def run_ais_stream():
    reconnect_delay = 1
    while True:
        try:
            async with connect(
                AISSTREAM_URL,
                compression="deflate",
                ping_interval=20,
                ping_timeout=20,
                open_timeout=10,
                max_size=1_000_000,
            ) as socket:
                current_bounds = state.get_bounds()
                await socket.send(
                    json.dumps(
                        {
                            "APIKey": API_KEY,
                            "BoundingBoxes": current_bounds,
                            "FilterMessageTypes": ["PositionReport"],
                        }
                    )
                )
                state.set_connection(True)
                reconnect_delay = 1
                last_subscription_update = time.monotonic()

                while True:
                    latest_bounds = state.get_bounds()
                    if (
                        latest_bounds != current_bounds
                        and time.monotonic() - last_subscription_update >= 1
                    ):
                        await socket.send(
                            json.dumps(
                                {
                                    "APIKey": API_KEY,
                                    "BoundingBoxes": latest_bounds,
                                    "FilterMessageTypes": ["PositionReport"],
                                }
                            )
                        )
                        current_bounds = latest_bounds
                        last_subscription_update = time.monotonic()

                    try:
                        raw_message = await asyncio.wait_for(socket.recv(), timeout=0.25)
                    except asyncio.TimeoutError:
                        continue

                    if isinstance(raw_message, bytes):
                        raw_message = raw_message.decode("utf-8")
                    event = json.loads(raw_message)
                    if event.get("MessageType") == "SubscriptionConfirmation":
                        state.set_connection(True)
                    elif event.get("MessageType") == "PositionReport":
                        state.set_connection(True)
                        metadata = event.get("MetaData") or {}
                        report = (event.get("Message") or {}).get("PositionReport") or {}
                        state.add_position(metadata, report)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            state.set_connection(False, f"Live AIS reconnecting ({type(error).__name__}).")
            print(f"AIS stream disconnected: {type(error).__name__}", flush=True)
            await asyncio.sleep(reconnect_delay * random.uniform(0.8, 1.2))
            reconnect_delay = min(reconnect_delay * 2, 30)


class RequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/ships":
            response = state.snapshot()
            if not response["configured"]:
                response["message"] = "Set AISSTREAM_API_KEY on the local server to enable live positions."
            elif not response["connected"] and not response["message"]:
                response["message"] = "Connecting to AISStream…"
            self.send_json(200, response)
            return
        if path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path != "/api/bounds":
            self.send_json(404, {"error": "Not found."})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0 or content_length > 16_384:
                raise ValueError("Invalid request size.")
            payload = json.loads(self.rfile.read(content_length))
            if not isinstance(payload, dict):
                raise ValueError("Request body must be a JSON object.")
            state.set_bounds(payload.get("bounds"))
        except (json.JSONDecodeError, TypeError, ValueError) as error:
            self.send_json(400, {"error": str(error)})
            return

        self.send_json(200, {"ok": True})

    def log_message(self, format_string, *args):
        print(f"{self.address_string()} - {format_string % args}", flush=True)


class LocalHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    if API_KEY:
        threading.Thread(
            target=lambda: asyncio.run(run_ais_stream()),
            name="aisstream-client",
            daemon=True,
        ).start()
        print("AISStream client started.", flush=True)
    else:
        print("AISSTREAM_API_KEY is not set; live ship positions are disabled.", flush=True)

    server = LocalHTTPServer(("127.0.0.1", 8000), RequestHandler)
    print("Open http://127.0.0.1:8000/map.html", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping local map server.", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
