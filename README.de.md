# Skopos

[English](README.md) · **Deutsch**

Schlanker, generischer Monitor in Node.js. Derselbe Code läuft auf jeder Maschine, eine
lokale Konfigurationsdatei bestimmt, was geprüft wird. Messwerte gehen in eine lokale
SQLite-DB; ein externer Auswerter holt sie per SSH ab und wertet sie aus.

> Stand: in Arbeit, erste Probeinstallation. Kern, System-Checks, generische fachliche
> Checks, Installer und Sammler laufen.

![skopos report: eine Tabelle mit einer CRIT-, einer WARN- und einer UNKNOWN-Zeile oben, darunter die ok-Zeilen](doc/img/01-report.png)

Der Status steht immer als Wort (`CRIT`, `WARN`, `UNKNOWN`, `ok`), nie nur als Farbe.
Probleme kommen zuerst; ein Check, der nicht messen konnte, ist `UNKNOWN` mit Grund, nie `ok`.
Die Ausgabe in den Bildern ist englisch.

## Voraussetzungen

- Linux mit systemd
- Node.js ≥ 22.13 (für `node:sqlite` ohne Flag)

## Schnellstart

Lokal ausprobieren (ohne Installation, ohne `npm ci`):

```bash
bin/skopos.js run --config config/example.json --db /tmp/skopos.db
bin/skopos.js report --db /tmp/skopos.db      # lesbare Tabelle; mit --json das Maschinenformat
```

Installation auf dem Zielhost (Kopieren von Dateien, ein Systemnutzer und ein systemd-Timer;
wiederholbar, auch für Updates):

```bash
sudo bin/install.sh --config config/example.json
```

Details, Update und Deinstallation: [doc/installation.de.md](doc/installation.de.md).

## Abgrenzung zu Netdata, Prometheus und Uptime Kuma

Das sind Monitoring-Plattformen: ein Server oder Dashboard zum Betreiben, Agenten oder
Exporter zum Installieren, Alarmregeln zum Pflegen. Skopos ist bewusst kleiner: ein Programm
je Maschine, eine lokale SQLite-Datei, kein Webserver und keine eigene Oberfläche, dazu ein
JSON-Report, den ein Skript oder ein Agent per SSH abholt. Es hat keine Abhängigkeiten und
läuft mit 2 Kernen und 2 GB RAM. Wer Dashboards und Live-Graphen will, ist mit diesen
Werkzeugen besser bedient; Skopos ist für den Fall, dass Verlauf, eine strenge
maschinenlesbare Schnittstelle und ein kleiner Fußabdruck wichtiger sind. Die Begründung
steht in [doc/concept.de.md](doc/concept.de.md).

Die Doku unter `doc/` ist zweisprachig: `<name>.md` ist Englisch, `<name>.de.md` Deutsch —
jede Seite verlinkt oben auf ihr Gegenstück.

## Was ist Skopos

Skopos (griech. „Späher, Ausguck“) misst und speichert — sonst nichts. Es greift nicht ein,
alarmiert nicht selbst, hat keine Oberfläche und sendet von sich aus keine Daten nach außen.
Auswertung und Tickets übernimmt der Auswerter. Die Begründung steht in
[doc/concept.de.md](doc/concept.de.md), die Entscheidungen in
[doc/decisions.de.md](doc/decisions.de.md).

## Grundsätze

1. Nur lesen, nie eingreifen.
2. Pull, kein Push.
3. „Unbekannt“ ist nicht „ok“: Was nicht messbar ist, wird als `unknown` mit Grund gespeichert.
4. Laut scheitern: Jeder Lauf schreibt einen Heartbeat; fehlen frische Daten, ist das selbst ein Befund.
5. Generischer Kern, Unterschiede zwischen Maschinen nur in der Konfiguration.
6. Checks sind kleine, getestete Module.
7. Schlank bleiben: kein Dashboard, keine Alarmierung, kein Webserver, begrenzte Retention.
8. Null Abhängigkeiten: SQLite über das eingebaute `node:sqlite`.

## Konfiguration

Eine JSON-Datei je Maschine (Vorgabe `/etc/skopos/config.json`, oder `--config`), streng
geprüft: unbekannter Check, unbekannter Schlüssel oder fehlender Pflichtwert brechen laut ab.
Siehe [config/example.json](config/example.json) und [doc/core.de.md](doc/core.de.md).
Konfigurationsrezepte nach Überwachungszweck (RAM/CPU, Reboot-Erkennung, eine Kennzahl aus
einer Datenbank oder JSON-Datei, …): [doc/examples.de.md](doc/examples.de.md).

![Eine Konfigurationsdatei: acht Checks, je ein Eintrag, darunter eine JSON-Datei und eine SQLite-Abfrage](doc/img/02-config.png)

## Report-Format

Der Auswerter ruft per SSH `skopos report --json [--since <ISO-Zeitstempel>]` auf und erhält
Heartbeat, aktuellen Status je Check und Verlauf. Das Datenbankschema bleibt intern und darf
sich ändern; die Schnittstelle ist der Report. Details: [doc/core.de.md](doc/core.de.md).

## Sammler

`skopos collect --config <datei>` ist der Sammler, mit demselben Code ausgeliefert. Ein Host
holt die anderen alle paar Minuten ab (User-Timer in `systemd/user/`) und führt eine kleine
Zustandsmaschine: Ein Problem zählt erst nach mehreren Läufen in Folge (Soft/Hard), eine
Erholung wird genauso bestätigt, Checks eines unerreichbaren Hosts werden zurückgehalten,
Flapping wird zu einem Ereignis „instabil“, und die Meldungen je Stunde sind gedeckelt. Nur
bestätigte Zustandswechsel verlassen den Sammler, als JSON auf stdin eines Befehls, den du
konfigurierst (Ticket, Mail, Chat — deine Wahl). Ein ruhiger Lauf ruft nichts auf. Beispiel:
[config/example-collect.json](config/example-collect.json), Details:
[doc/collector.de.md](doc/collector.de.md).

Ein Problem wird erst gemeldet, wenn es bestätigt ist. Nach dem ersten Lauf steht
`problems=0` und nichts wird gesendet; nach dem zweiten ist das fehlgeschlagene Backup ein
bestätigtes Problem, und eine Meldung geht hinaus (hier an eine Logdatei angehängt):

![Zwei Läufe von skopos run und skopos collect: problems=0 nach dem ersten, problems=1 sent=1 nach dem zweiten, und eine PROBLEM-Zeile im Log](doc/img/03-collector-problem.png)

Die Erholung wird genauso bestätigt. Sobald der Backup-Status wieder stimmt, enden dieselben
zwei Läufe mit einer `RECOVERY`-Zeile:

![Das Log nach der Erholung: zwei PROBLEM-Zeilen und eine RECOVERY-Zeile für backup.value](doc/img/04-collector-recovery.png)

## Lizenz

[Apache License 2.0](LICENSE).

## Verwandte Projekte

Skopos entstand als Betreiber-Werkzeug neben Agora (Ticket- und Delegationsdienst), FORGE
und Talos (Agenten-Host) — keines davon bisher öffentlich, deshalb hier ohne Verweise.
