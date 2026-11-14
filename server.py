#!/usr/bin/env python3
"""Kleiner Server für den Pokémon-Karten-Scanner.

- liefert die Web-App aus dem Ordner public/ aus
- /api/ebay sucht die billigsten Angebote über die offizielle eBay Browse API
  (nur wenn in config.json eBay-Zugangsdaten eingetragen sind)

Start:  python3 server.py
"""
import base64
import json
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
CONFIG_PATH = os.path.join(ROOT, "config.json")
SCANS = os.path.join(ROOT, "scans")
PORT = int(os.environ.get("PORT", "8000"))

DEFAULT_CONFIG = {
    "ebay_client_id": "",
    "ebay_client_secret": "",
    "ebay_marketplace": "EBAY_DE",
    "ebay_delivery_country": "LU",
}

# Wörter, die bei Einzelkarten-Suchen meist Müll liefern (Lots, gegradete Karten, Fakes)
EXCLUDE_WORDS = ["psa", "bgs", "cgc", "lot", "konvolut", "sammlung", "proxy", "custom", "fake"]


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg.update(json.load(f))
    for key in DEFAULT_CONFIG:
        env = os.environ.get(key.upper())
        if env:
            cfg[key] = env
    return cfg


_token = {"value": None, "expires": 0}


def ebay_token(cfg):
    if _token["value"] and time.time() < _token["expires"] - 60:
        return _token["value"]
    auth = base64.b64encode(f'{cfg["ebay_client_id"]}:{cfg["ebay_client_secret"]}'.encode()).decode()
    body = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "scope": "https://api.ebay.com/oauth/api_scope",
    }).encode()
    req = urllib.request.Request(
        "https://api.ebay.com/identity/v1/oauth2/token",
        data=body,
        headers={"Authorization": f"Basic {auth}", "Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.load(resp)
    _token["value"] = data["access_token"]
    _token["expires"] = time.time() + int(data.get("expires_in", 7200))
    return _token["value"]


def ebay_search(query, number, cfg):
    params = {
        "q": query,
        "sort": "price",  # Preis + Versand aufsteigend
        "limit": "50",
        "filter": f'buyingOptions:{{FIXED_PRICE}},deliveryCountry:{cfg["ebay_delivery_country"]}',
    }
    req = urllib.request.Request(
        "https://api.ebay.com/buy/browse/v1/item_summary/search?" + urllib.parse.urlencode(params),
        headers={
            "Authorization": f"Bearer {ebay_token(cfg)}",
            "X-EBAY-C-MARKETPLACE-ID": cfg["ebay_marketplace"],
            "X-EBAY-C-ENDUSERCTX": f'contextualLocation=country={cfg["ebay_delivery_country"]}',
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.load(resp)

    items = []
    for it in data.get("itemSummaries", []):
        title = it.get("title", "")
        low = title.lower()
        if any(re.search(rf"\b{w}\b", low) for w in EXCLUDE_WORDS):
            continue
        # Nur Angebote, deren Titel die Kartennummer enthält (z.B. 58/102 oder 058/102)
        if number and not number_in_title(number, title):
            continue
        price = float(it.get("price", {}).get("value", 0))
        shipping = 0.0
        opts = it.get("shippingOptions") or []
        if opts and opts[0].get("shippingCost"):
            shipping = float(opts[0]["shippingCost"].get("value", 0))
        items.append({
            "title": title,
            "price": price,
            "shipping": shipping,
            "total": round(price + shipping, 2),
            "currency": it.get("price", {}).get("currency", "EUR"),
            "condition": it.get("condition", ""),
            "url": it.get("itemWebUrl"),
            "image": (it.get("image") or {}).get("imageUrl"),
        })
    items.sort(key=lambda x: x["total"])
    return items[:10]


def number_in_title(number, title):
    m = re.match(r"0*(\d+)\s*/\s*0*(\d+)", number)
    if not m:
        return number.lower() in title.lower()
    a, b = m.groups()
    return re.search(rf"(?<!\d)0*{a}\s*/\s*0*{b}(?!\d)", title) is not None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC, **kwargs)

    def end_headers(self):
        # Immer die neueste Version der App laden (wichtig nach Updates, v.a. auf dem Handy)
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/api/ebay":
            return self.handle_ebay(urllib.parse.parse_qs(url.query))
        return super().do_GET()

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/api/scan":
            return self.handle_scan(urllib.parse.parse_qs(url.query))
        if url.path == "/api/index":
            return self.handle_index(urllib.parse.parse_qs(url.query))
        self.send_error(404)

    def handle_index(self, qs):
        """Speichert die Bild-Datenbank (von build-index.html) in public/data/."""
        name = (qs.get("file") or [""])[0]
        if name not in ("fingerprints.bin", "cards.json"):
            return self.send_json(400, {"ok": False})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= 60_000_000:
            return self.send_json(400, {"ok": False})
        data = self.rfile.read(length)
        os.makedirs(os.path.join(PUBLIC, "data"), exist_ok=True)
        with open(os.path.join(PUBLIC, "data", name), "wb") as f:
            f.write(data)
        return self.send_json(200, {"ok": True, "bytes": length})

    def handle_scan(self, qs):
        """Speichert Scan-Bilder im Ordner scans/, um die Erkennung mit echten Fotos zu verbessern."""
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= 15_000_000:
            return self.send_json(400, {"ok": False})
        data = self.rfile.read(length)
        scan_id = re.sub(r"[^0-9A-Za-z-]", "", (qs.get("id") or ["scan"])[0])[:40]
        kind = "foto" if (qs.get("kind") or [""])[0] == "foto" else "ausschnitt"
        os.makedirs(SCANS, exist_ok=True)
        with open(os.path.join(SCANS, f"{scan_id}-{kind}.jpg"), "wb") as f:
            f.write(data)
        return self.send_json(200, {"ok": True})

    def handle_ebay(self, qs):
        cfg = load_config()
        if not cfg["ebay_client_id"] or not cfg["ebay_client_secret"]:
            return self.send_json(200, {"configured": False, "items": []})
        query = (qs.get("q") or [""])[0]
        number = (qs.get("num") or [""])[0]
        try:
            items = ebay_search(query, number, cfg)
            return self.send_json(200, {"configured": True, "items": items})
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            return self.send_json(502, {"configured": True, "error": f"eBay HTTP {e.code}: {detail}"})
        except Exception as e:  # Netzwerkfehler usw.
            return self.send_json(502, {"configured": True, "error": str(e)})

    def log_message(self, fmt, *args):
        # Anfragen vom Mac selbst nicht protokollieren, nur die vom Handy und alle API-Aufrufe
        if self.client_address[0] != "127.0.0.1" or "/api/" in (str(args[0]) if args else ""):
            super().log_message(fmt, *args)


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Karten-Scanner läuft:  http://localhost:{PORT}")
    ip = lan_ip()
    host = socket.gethostname().split(".")[0]
    print(f"Auf dem Handy (gleiches WLAN):  http://{host}.local:{PORT}")
    if ip:
        print(f"            oder über die IP:  http://{ip}:{PORT}  (kann sich ändern)")
    cfg = load_config()
    print("eBay-Preise:", "aktiv" if cfg["ebay_client_id"] else "nicht eingerichtet (nur Such-Link)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
