# Karteikarten – Anleitung für Claude

Dieses Repo ist eine statische Lern-App (`index.html`, `app.js`, `style.css`). Die Karten liegen als JSON in `decks/`, der Lernfortschritt im Browser (localStorage) – Claude ändert nur die Karten.

## Pull Requests

Nach **jeder** Änderung (Karten, App, Doku) ohne Nachfrage einen Pull Request nach `main` erstellen und den Link nennen – die App auf GitHub Pages zeigt nur, was auf `main` liegt. Ist der vorherige PR des Arbeitsbranches schon gemergt, den Branch vorher neu von `main` aufsetzen.

## Module

| Modul | Datei | ID-Präfix |
|---|---|---|
| Internes Rechnungswesen | `decks/internes-rechnungswesen.json` | `irw` |
| Externes Rechnungswesen | `decks/externes-rechnungswesen.json` | `erw` |
| Marketing | `decks/marketing.json` | `mkt` |
| Analogtechnik | `decks/analogtechnik.json` | `ana` |

## Ablauf, wenn der Nutzer ein Dokument hochlädt

1. **Modul bestimmen.** Nennt der Nutzer es nicht, aus dem Inhalt ableiten und kurz sagen, welches gewählt wurde. Passt das Dokument zu keinem Modul, nachfragen.
2. **Dokument vollständig lesen** und die prüfungsrelevanten Inhalte herausarbeiten: Definitionen, Abgrenzungen, Formeln, Rechenschemata, Ablaufschritte, Vor-/Nachteile, typische Klausurfragen.
3. **Bestehendes Set lesen**, damit keine Frage doppelt entsteht. Vorhandene Karten nicht verändern oder löschen (ihre IDs hängen am Lernfortschritt), außer der Nutzer bittet ausdrücklich darum.
4. **Karten erstellen** und ans Ende von `cards` anhängen. IDs fortlaufend weiterzählen (höchste vorhandene Nummer + 1, vierstellig: `irw-0001`, `irw-0002`, …).
5. `node scripts/validate.mjs` ausführen und Fehler beheben.
6. Committen (`Karten: <Modul> – <Dokument/Thema> (+N)`) und pushen, danach einen Pull Request nach `main` erstellen (siehe oben).
7. Dem Nutzer kurz berichten: wie viele Karten, welche Themen.

## Kartenformat

```json
{
  "id": "irw-0001",
  "front": "Was ist der Unterschied zwischen Kosten und Aufwand?",
  "back": "**Aufwand**: gesamter periodisierter Werteverzehr (externes ReWe).\n**Kosten**: betriebsbedingter, bewerteter Güterverzehr zur Leistungserstellung (internes ReWe).\n\n- neutraler Aufwand ≠ Kosten\n- kalkulatorische Kosten ≠ Aufwand",
  "topic": "Grundbegriffe",
  "source": "Skript Kapitel 1, S. 4"
}
```

- `front`: eine klare Frage oder Aufgabe. `back`: knappe, vollständige Antwort.
- `topic`: Kapitel/Themenblock aus dem Dokument – einheitliche Schreibweise innerhalb eines Moduls, damit der Themenfilter funktioniert.
- `source`: Dokumentname plus Kapitel/Seite, wenn erkennbar.
- Formatierung in `front`/`back`: `**fett**`, `*kursiv*`, `` `code` ``, Listen mit `- ` oder `1. `, Leerzeile = neuer Absatz, Formeln in LaTeX mit `$…$` bzw. `$$…$$` (in JSON Backslashes verdoppeln: `"$U = R \\cdot I$"`).

## Gute Karten

- Eine Karte = ein Lerninhalt (atomar). Lange Aufzählungen lieber auf mehrere Karten verteilen.
- Nicht nur Definitionen abfragen: auch „Warum…?“, „Wie berechnet man…?“, Abgrenzungen und kleine Rechenaufgaben mit Lösungsweg (besonders Rechnungswesen und Analogtechnik).
- Antworten aus dem Dokument ableiten, nichts erfinden. Ergänzungen aus Allgemeinwissen nur, wenn sie eindeutig korrekt sind.
- Richtwert: ca. 1 Karte pro wesentlichem Absatz/Folie; lieber gründlich als lückenhaft.
