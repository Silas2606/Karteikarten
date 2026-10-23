# Karteikarten

Lern-App für meine Module – die Karten erstellt Claude aus hochgeladenen Dokumenten.

**Module:** Internes Rechnungswesen · Externes Rechnungswesen · Marketing · Analogtechnik

## So funktioniert's

1. **Dokument hochladen:** In einer Claude-Code-Sitzung auf diesem Repo das Skript/die Folien/Notizen hochladen und z. B. schreiben: *„Mach Karteikarten für Marketing daraus.“*
2. **Claude erstellt die Karten**, hängt sie an das passende Set in `decks/` an, prüft sie mit `node scripts/validate.mjs` und pusht. (Die Regeln dafür stehen in [`CLAUDE.md`](CLAUDE.md).)
3. **Lernen:** App öffnen – neue Karten erscheinen automatisch.

## App öffnen

- **Online (empfohlen, auch am Handy):** GitHub Pages aktivieren: *Settings → Pages → Deploy from a branch → `main` / root*. Die App läuft dann unter `https://silas2606.github.io/Karteikarten/`.
- **Als App aufs Handy:** Seite in Chrome öffnen → Menü ⋮ → *App installieren* bzw. *Zum Startbildschirm hinzufügen* (iPhone: Teilen → *Zum Home-Bildschirm*). Die App öffnet sich dann im Vollbild mit eigenem Symbol und funktioniert auch offline. Sync-Token danach einmal in der installierten App eingeben.
- **Lokal:** `python3 -m http.server` im Repo-Ordner starten und `http://localhost:8000` öffnen (direktes Öffnen der `index.html` als Datei funktioniert nicht).

## Lernen & Fortschritt

- **Lernen:** Antwort aufdecken (Leertaste) und mit *Wiederholen* oder *Kann ich* bewerten (Tasten 1 / 2). *Kann ich* nimmt die Karte aus dem Zyklus, *Wiederholen* lässt sie in der Runde bald wiederkommen.
- **Markieren:** Jede Karte lässt sich beim Lernen (Taste M) oder in der Kartenliste mit ★ markieren.
- **Löschen:** Unwichtige Karten beim Lernen (🗑) oder in der Kartenliste löschen – mit doppelter Bestätigung. Sie verschwinden auf allen Geräten aus Lernen, Liste und Statistik und lassen sich unter *Einstellungen → Gelöschte Karten* wiederherstellen.
- **Modi:** offene Karten (Standard), alle Karten (auch gekonnte) und markierte Karten; jeweils filterbar nach Thema. Wer eine gekonnte Karte im Modus „Alle“ mit *Wiederholen* bewertet, holt sie zurück in den Zyklus – oder in der Kartenliste über *Wieder in den Zyklus*.
- **Fortschritt:** pro Modul und Thema *neu / wiederholen / gekonnt*, Markierungen, Tagesserie, Aktivitäts-Heatmap und „Kann ich“-Quote.
- Der Fortschritt liegt im Browser und lässt sich unter *Einstellungen* als Datei exportieren/importieren.

## Synchronisierung zwischen Geräten

Der Fortschritt wird automatisch über einen **privaten GitHub Gist** abgeglichen (nach dem Lernen, beim Öffnen der App und beim Zurückwechseln in den Tab).

Einrichten – einmal pro Gerät:
1. Auf GitHub einen [Fine-grained Token](https://github.com/settings/personal-access-tokens/new) erstellen: unter *Account permissions* nur **Gists → Read and write** auswählen.
2. In der App unter *Einstellungen → Synchronisierung* den Token einfügen und *Verbinden* klicken. Das erste Gerät legt den Gist an, alle weiteren finden ihn automatisch.

Beim Zusammenführen gewinnt pro Karte der zuletzt gelernte Stand; die Lernstatistik wird über alle Geräte addiert. *Importieren* und *Zurücksetzen* gelten bei aktivem Sync für alle Geräte. Der Token wird nur im Browser des jeweiligen Geräts gespeichert.

## Struktur

```
index.html, app.js, style.css   Lern-App (ohne Build-Schritt)
manifest.webmanifest, sw.js     Installierbar als App, offline nutzbar
icons/                          App-Symbol
decks/index.json                Liste der Module
decks/<modul>.json              Karten je Modul
scripts/validate.mjs            Prüft Format, IDs und Duplikate
CLAUDE.md                       Anleitung für Claude zum Erstellen der Karten
```

Ein neues Modul anlegen: Eintrag in `decks/index.json` ergänzen und `decks/<id>.json` mit `{"deck": "<id>", "name": "…", "cards": []}` anlegen (oder Claude darum bitten).
