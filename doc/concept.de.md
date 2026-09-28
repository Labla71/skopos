# Skopos — Konzept

Skopos ist ein schlanker Monitor: Auf jeder Maschine läuft derselbe Node.js-Code, eine lokale
Konfigurationsdatei legt fest, was dort geprüft wird. Messwerte landen in einer lokalen
SQLite-DB. Ein externer Auswerter (ein Agent oder ein Skript) holt sie per SSH ab und wertet
sie aus; mitgeliefert ist dafür der Sammler `skopos collect` ([collector.de.md](collector.de.md)). Diese Seite hält das allgemeine „Warum“ fest; die einzelnen Entscheidungen stehen in
[decisions.de.md](decisions.de.md). English: [concept.md](concept.md).

## Anlass

Ein Dienst lief sechs Tage lang täglich in das Anfragelimit eines externen Anbieters. Er
bekam dauerhaft Ablehnungen, obwohl er nur einen Bruchteil seines Tagesbedarfs durchsetzen
konnte. Aufgefallen ist das niemandem, aus zwei Gründen:

- **Momentaufnahmen sehen keine Tagesmuster.** Die vorhandene Morgenroutine misst einmal
  nachts. Ein Fehler, der tagsüber kommt und geht, ist darin unsichtbar.
- **Die Hochrechnung fehlte, wo sie gebraucht wurde.** Die vorhandene Kontingent-Auswertung
  deckte nur die Hauptinstallation ab; auf den anderen Maschinen lieferte sie „unbekannt“ und
  wurde als „in Ordnung“ gelesen.

Daraus folgt, was Skopos leisten muss: **Verlauf statt Momentaufnahme**, und **„unbekannt“
darf nie wie „ok“ aussehen**.

## Warum kein bestehendes Werkzeug

Etablierte Monitoring-Werkzeuge gibt es, und sie wurden geprüft. Drei Gründe haben die
Entscheidung zu einem neuen, kleinen Werkzeug kippen lassen:

- **Ressourcenbudget.** Die zu überwachenden Maschinen laufen alle mit Node.js und
  reichen hinunter bis 2 Kerne, 2 GB RAM und 15 GB Disk. Jede geprüfte etablierte
  Lösung war für einen derart schmalen Einsatzzweck zu umfangreich.
- **Einbettung in die bestehende Automatisierung.** Das Ergebnis sollte sich über eine
  stabile, scriptbare Schnittstelle (JSON-Config rein, JSON-Report raus) in bereits
  vorhandene, skript- und ticketgetriebene Abläufe einfügen, statt eine eigene
  Oberfläche zu verlangen — und für ein LLM allein anhand der Doku konfigurierbar sein,
  ohne dass ein Mensch erst ein Handbuch liest.
- Und ehrlich gesagt auch: Neugier — die Gelegenheit, so ein Werkzeug selbst einmal von
  Grund auf zu bauen.

## Grundsätze

1. **Nur lesen, nie eingreifen.** Kein Start, Stopp oder Reparieren, kein Schreiben in fremde
   Dateien oder Datenbanken; fremde SQLite-DBs nur lesend. Ein Monitor, der eingreift, wird
   selbst zur Fehlerquelle.
2. **Pull, kein Push.** Skopos sendet nichts. Der Auswerter holt ab. So braucht keine
   Installation eine ausgehende Verbindung, und nichts verlässt eine Maschine ohne Zutun.
3. **„Unbekannt“ ist nicht „ok“.** Nicht messbar heißt `unknown` mit Grund, nie 0 oder ein
   Vorgabewert. Genau diese Falle hat den Anlass verdeckt.
4. **Laut scheitern.** Jeder Lauf schreibt einen Heartbeat. Fehlen frische Daten, ist das
   selbst ein Befund.
5. **Generischer Kern, Unterschiede nur in der Konfiguration.** Kein Host-Sonderfall im Code;
   dieselbe Codebasis auf allen Maschinen bedeutet, dass ein Fehler einmal behoben wird.
6. **Checks als kleine, getestete Module.** Das begrenzt das Risiko „ein Bug, überall falsche
   Daten“ (Vorbild: das Plugin-Modell von Nagios). Zusätzlich misst der Auswerter gelegentlich
   einen Wert selbst nach, als Stichprobe gegen systematische Messfehler.
7. **Schlank.** Kein Dashboard, keine Alarmierung, kein Webserver, begrenzte Retention.
   Skopos muss auch auf kleiner Hardware laufen (2 Kerne, 2 GB RAM, 15 GB Disk).
8. **Erst rechnen, dann lesen.** Schwellen werden in Skopos deterministisch bewertet. Der
   Auswerter liest Ergebnis und Verlauf, statt Prüflogik in einem Prompt zu tragen.

## Erste Kandidaten für Checks

- **System:** RAM, Swap, CPU-Last, Disk-Belegung, OOM-Kills
- **Dienste:** systemd-Units gegen einen konfigurierten Soll-Zustand (aktiv/inaktiv)
- **Mounts:** Erreichbarkeit konfigurierter Einhängepunkte
- **Logs:** Fehlermuster in konfigurierten Logfiles oder Journal-Units seit dem letzten Lauf
- **Fachlich, generisch:**
  - `sqlite-query`: eine fremde SQLite-DB lesend öffnen, eine konfigurierte SQL-Abfrage
    ausführen und das Ergebnis gegen Schwellen prüfen;
  - `json-file`: Feld und Dateialter einer JSON-Datei gegen Schwellen prüfen.

  Die konkreten Abfragen (welche DB, welches Feld) stehen in der Config des jeweiligen Hosts,
  nie im Code.

## Was Skopos nicht ist

Kein Dashboard, kein Alarmsystem, kein Konfigurationsmanagement, kein Agent, der repariert.
Es misst und speichert.
