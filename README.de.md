# Skopos

[English](README.md) · **Deutsch**

Schlanker, generischer Monitor in Node.js. Derselbe Code läuft auf jeder Maschine, eine
lokale Konfigurationsdatei bestimmt, was geprüft wird. Messwerte gehen in eine lokale
SQLite-DB; ein externer Auswerter holt sie per SSH ab und wertet sie aus.

> Stand: in Arbeit, erste Probeinstallation. Kern, System-Checks, generische fachliche
> Checks, Installer und Sammler laufen.

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

## Konfiguration

Eine JSON-Datei je Maschine (Vorgabe `/etc/skopos/config.json`, oder `--config`), streng
geprüft: unbekannter Check, unbekannter Schlüssel oder fehlender Pflichtwert brechen laut ab.
Siehe [config/example.json](config/example.json) und [doc/core.de.md](doc/core.de.md).
Konfigurationsrezepte nach Überwachungszweck (RAM/CPU, Reboot-Erkennung, eine Kennzahl aus
einer Datenbank oder JSON-Datei, …): [doc/examples.de.md](doc/examples.de.md).

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

## Lizenz

[Apache License 2.0](LICENSE).

## Verwandte Projekte

Skopos entstand als Betreiber-Werkzeug neben Agora (Ticket- und Delegationsdienst), FORGE
und Talos (Agenten-Host) — keines davon bisher öffentlich, deshalb hier ohne Verweise.
