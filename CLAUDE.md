# CLAUDE.md — Skopos

Skopos (griech. „Späher, Ausguck“) ist ein schlanker, generischer Monitor in Node.js: Auf
jeder Maschine läuft derselbe Code, eine lokale Konfigurationsdatei legt fest, was dort
geprüft wird (Ressourcen, Dienste, Mounts, Logfiles, fachliche Kennzahlen). Messwerte landen
in einer lokalen SQLite-DB; ein externer Auswerter holt sie ab.

Dieses Repo ist so gebaut, dass es **komplett öffentlich sein kann**. Nichts Privates gehört
hinein (siehe „Konventionen“).

## Grundsätze

Sie sind die tragenden Annahmen des Projekts. Begründung: `doc/concept.md`, Entscheidungen:
`doc/decisions.md` (deutsch: `doc/concept.de.md`, `doc/decisions.de.md`).

- **Nur lesen, nie eingreifen.** Skopos misst. Es startet, stoppt oder repariert nichts und
  schreibt in keine fremde Datenbank oder Datei. Fremde SQLite-DBs nur lesend öffnen.
- **Pull, kein Push.** Skopos sendet von sich aus nichts nach außen.
- **„Unbekannt“ ist nicht „ok“.** Kann ein Check nicht messen (fehlende Datei, Rechte,
  Timeout), speichert er `unknown` mit Grund — nie eine Null oder einen Vorgabewert.
- **Laut scheitern.** Jeder Lauf schreibt einen Heartbeat. Fehlen frische Daten, ist das
  selbst ein Befund.
- **Generischer Kern, Unterschiede nur in der Konfiguration.** Kein Sonderfall für einen
  bestimmten Host im Code.
- **Checks sind kleine, getestete Module.** Jede Messlogik hat Unit-Tests.
- **Schlank bleiben.** Kein Dashboard, keine eigene Alarmierung, kein Webserver.
- **Ressourcen schonen.** Skopos muss auf kleiner Hardware laufen (2 Kerne, 2 GB RAM);
  die Retention der DB ist begrenzt.
- **Null Abhängigkeiten.** SQLite über das eingebaute `node:sqlite`, kein `npm ci` auf dem
  Ziel.

## Konventionen

- Node ≥ 22.13, ES-Module, `node --test` als Testrunner (`npm test`).
- 🔒 **Sprache:** Code, Bezeichner, Kommentare, Tests, CLI-Parameter, Config-Schlüssel,
  Check-Namen, Report-Felder, DB-Spalten, Meldungen und Dateinamen sind **englisch**. Die
  Doku unter `doc/` ist zweisprachig wie die READMEs: `<name>.md` englisch (Standard ohne
  Suffix, wie bei GitHub-Lokalisierung üblich), `<name>.de.md` deutsch (`doc/decisions.md`,
  Nr. 11 und Nr. 14).
- 🔒 **Nichts Privates im Repo:** keine Hostnamen, IPs, Nutzernamen, Heimatpfade,
  Domains, E-Mail-Adressen oder Schlüssel — nicht im Code, nicht in Tests, nicht in
  Fixtures, nicht in der Doku. Beispiele mit neutralen Namen (`example-host`, `example.org`).
- Echte Host-Configs gehören **nicht** hierher; im Repo liegen nur `config/example*.json`.
- Fachliche Checks sind generisch (z. B. `sqlite-query`, `json-file`); die konkrete
  Abfrage steht in der Config des jeweiligen Hosts, nie im Code.
- `test/public.test.js` prüft jede Datei, die veröffentlicht würde (auch noch nicht
  committete), auf private Muster. Er läuft mit `npm test` und darf nicht umgangen werden.
  Zusätzliche private Muster liest er aus einer Datei außerhalb des Repos (Umgebungsvariable
  `SKOPOS_LEAK_PATTERNS`, sonst die ignorierte Datei `.leak-patterns` im Repo).
- Verweise auf Schwesterprojekte stehen an genau einer Stelle: im README-Abschnitt
  „Related projects / Verwandte Projekte“ (von `test/public.test.js` erzwungen).
- Kein Autorenname in öffentlichen Dateien außer an dieser einen Stelle.

## Dokumentation — ein Ort pro Frage

| Frage | Ort |
|---|---|
| **Warum** ist das so? | `doc/concept.md` (Anlass, Grundsätze), `doc/decisions.md` (Entscheidungen) |
| **Was** wurde geändert? | Commit-Nachricht, kurz |
| **Wie** funktioniert ein Check / das Schema? | `doc/`, sobald vorhanden — altert mit dem Code |
| **Wie starte ich?** | `README.md` (Englisch), `README.de.md` (Deutsch) |

Jedes Dokument unter `doc/` gibt es zweisprachig (`<name>.md` Englisch, `<name>.de.md`
Deutsch, gegenseitig verlinkt), wie die READMEs, mit gleicher Gliederung.
