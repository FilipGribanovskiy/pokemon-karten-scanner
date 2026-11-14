# Karten-Scanner (Pokémon)

**Online:** <https://pokemon.3dfilips.lu> – funktioniert überall, ohne dass der Mac laufen muss.
Jede Änderung, die auf GitHub (Branch `main`) hochgeladen wird, wird automatisch dort veröffentlicht.
Online gibt es den eBay-Such-Link (keine eBay-Preise in der App) und Scans werden nicht gespeichert –
dafür die Version auf dem Mac verwenden (siehe unten).

Fotografiere eine Pokémon-Karte und die App zeigt dir den billigsten Preis auf **Cardmarket** und **eBay**.

- **💰 Wert finden**: zeigt den billigsten Preis
- **🛒 Kaufen**: dasselbe, aber mit Links direkt zum Angebot

## Starten

Im Terminal in diesem Ordner:

```bash
python3 server.py
```

Dann im Browser öffnen: <http://localhost:8000>

**Auf dem Handy:** Handy und Mac müssen im gleichen WLAN sein. Im Handy-Browser öffnen:
`http://MacBook-von-Filip.local:8000` – diese Adresse bleibt immer gleich. (Der Server zeigt beim Start
auch eine Zahlen-Adresse wie `http://192.168.1.141:8000` an, die kann sich aber ändern.)
Mit „📷 Karte scannen“ öffnet sich die Kamera.

## So funktioniert's

1. Foto von der Karte (möglichst nah, gutes Licht)
2. Die App findet die Karte im Foto automatisch, schneidet sie aus und dreht sie gerade
   (mit [OpenCV](https://opencv.org), wird beim ersten Mal geladen, ca. 10 MB).
   Klappt das nicht, kannst du die Karte von Hand einrahmen.
3. Sie vergleicht das Kartenbild mit der **Bild-Datenbank** aller ~21.000 Karten (siehe unten).
   Ist das eindeutig, öffnet sie die Karte sofort.
4. Sonst liest sie zusätzlich den **Namen** (oben) und die **Nummer** (unten, z.B. `25/165`) und
   zeigt dir die beste Übereinstimmung: „Ist es diese Karte?“
   Das klappt mit deutschen, englischen und französischen Karten (Daten von [TCGdex](https://tcgdex.dev)).

Wenn nichts klappt: Name und Nummer eintippen, z.B. `Mew 53/108`.

## Bild-Datenbank

Der Ordner `public/data/` enthält von jeder Karte einen kleinen „Fingerabdruck“ des Kartenbilds.
Neue Karten-Sets nachladen: Server starten, im Browser auf dem Mac
<http://localhost:8000/build-index.html> öffnen und auf „Datenbank bauen / aktualisieren“ klicken.
Beim ersten Mal dauert es ca. 6 Minuten, danach werden nur neue Karten geladen.
4. Preise:
   - **Cardmarket**: „ab“-Preis (billigstes Angebot, alle Zustände) und Trendpreis, täglich aktualisiert
   - **eBay**: billigste Sofort-Kaufen-Angebote inklusive Versand

Wenn das Foto nicht klappt, kannst du die Karte auch eintippen, z.B. `Glurak 4/102` oder `Pikachu`.

## eBay-Preise einschalten (optional)

Ohne Einrichtung zeigt die App einen Link zur eBay-Suche, sortiert nach „Preis + Versand: niedrigster zuerst“.
Damit die App die eBay-Preise selbst anzeigen kann, brauchst du kostenlose Zugangsdaten von eBay:

1. Auf <https://developer.ebay.com> ein Entwicklerkonto anlegen (dafür ein Erwachsener, wenn du unter 18 bist)
2. Unter „Application Keys“ einen **Production**-Schlüssel erstellen
3. **App ID (Client ID)** und **Cert ID (Client Secret)** in `config.json` eintragen:

```json
{
  "ebay_client_id": "DEINE-APP-ID",
  "ebay_client_secret": "DEINE-CERT-ID",
  "ebay_marketplace": "EBAY_DE",
  "ebay_delivery_country": "LU"
}
```

4. Server neu starten

`ebay_delivery_country` ist das Land, in das geliefert werden soll (`LU`, `DE`, `AT`, …).
Gib `config.json` mit eingetragenen Schlüsseln an niemanden weiter.

## Dateien

- `server.py`: kleiner Python-Server (liefert die App aus und fragt eBay ab)
- `public/`: die Web-App (HTML, CSS, JavaScript)
- `config.json`: Einstellungen und eBay-Schlüssel
- `scans/`: jeder Scan legt hier das Foto und den eingerahmten Ausschnitt ab (nur auf deinem Mac,
  zum Verbessern der Erkennung). Den Ordner kannst du jederzeit leeren.
