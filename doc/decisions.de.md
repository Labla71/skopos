# Skopos — Entscheidungen

Architektur-Entscheidungen im Stil von Entscheidungsnotizen: Kontext, Entscheidung,
Begründung, Folgen. Das „Warum“ des Projekts steht in [concept.de.md](concept.de.md).
English: [decisions.md](decisions.md).

Ausgangslage der Messungen: Node 22.23, kleinste Zielmaschine mit 2 Kernen, 1,9 GB RAM und
15 GB Disk. Fremde Datenbanken sind für alle lesbar, aber nur für ihren Eigentümer schreibbar.

## 1. Konfiguration als JSON-Datei

- **Kontext:** Jede Maschine braucht ihre eigene Liste an Checks.
- **Entscheidung:** JSON unter `/etc/skopos/config.json`. Beispiele im Repo unter
  `config/example*.json`, die Installation kopiert die echte Datei.
- **Begründung:** JSON ist Daten, kein Code (eine `.mjs`-Config könnte beliebig ausführen) und
  braucht keine Abhängigkeit. Der Kern prüft streng: unbekannter Check, unbekannter Schlüssel
  oder fehlender Pflichtwert brechen laut ab. Kommentare gehen über ein Feld `_comment`.
- **Folgen:** Kein Kommentar-Syntax, dafür nichts Ausführbares in der Config.

## 2. Takt 5 Minuten, Retention 30 Tage

- **Kontext:** Tagesmuster brauchen Verlauf, die Platte ist klein.
- **Entscheidung:** Ein Timer alle 5 Minuten (`OnCalendar=*:0/5`), Aufräumen einmal täglich im
  Lauf selbst; beides in der Config überschreibbar.
- **Begründung:** Grob geschätzt ~15 Checks × ~3 Werte × 288 Läufe/Tag ≈ 13.000 Zeilen/Tag, in
  30 Tagen ≈ 400.000 Zeilen ≈ 30–40 MB. Unkritisch auch auf der kleinsten Maschine.
- **Folgen:** Auflösung 5 Minuten; kürzere Ereignisse sieht Skopos nicht.

## 3. Generisches Schema: `runs`, `measurements`, `state`

- **Kontext:** Jede neue Messung darf keine Schema-Migration auslösen.
- **Entscheidung:** `runs` ist der Heartbeat (Start, Ende, Dauer, Anzahl je Status,
  Skopos-Version). `measurements` hat die Spalten `run_id`, `time`, `check`, `key`, `value`,
  `unit`, `status`, `reason`. `state` (`check`, `key`, `value`) ist ein Wasserstand
  für Checks, die „seit dem letzten Lauf“ zählen (OOM, Logs, Ablehnungen).
- **Begründung:** Tabellen je Check würden jede neue Messung zur Migration machen.
- **Folgen:** Auswertungen laufen über Schlüssel statt über Spalten.

## 4. `node:sqlite` statt einer Bibliothek

- **Kontext:** Auf kleiner Hardware soll nichts gebaut werden müssen.
- **Entscheidung:** Das eingebaute `node:sqlite`, null Abhängigkeiten. Die eigene DB läuft im
  Journal-Modus `DELETE` (nicht WAL) mit Dateirechten `0644`.
- **Begründung:** Kein `npm ci` auf dem Ziel, kein natives Modul. Installation ist ein Kopieren
  von Dateien. Mit `DELETE` kann ein anderer Nutzer die DB lesend öffnen, ohne
  Schreibrecht auf das Verzeichnis; bei WAL entsteht das Problem aus Entscheidung 5.
- **Folgen:** Die API ist in Node 22 noch „experimental“ (Warnung, abschaltbar mit
  `--disable-warning=ExperimentalWarning`). Eine dünne Speicherschicht mit Tests fängt eine
  spätere API-Änderung ab.

## 5. Fremde WAL-Datenbanken lesen, ohne Rechte zu ändern

- **Kontext:** Ein Check soll eine fremde SQLite-DB im WAL-Modus lesen, die der Eigentümer nur
  pro Schreibvorgang öffnet. Zwischen den Schreibvorgängen gibt es keine `-wal`/`-shm`-Dateien;
  ein `readOnly`-Leser will dann `-shm` anlegen und scheitert am Verzeichnis.
- **Entscheidung:** Die Lösung liegt ganz im Check:
  - `-wal` existiert → normales `readOnly`-Öffnen (`-wal`/`-shm` sind lesbar).
  - `-wal` fehlt → `file:<pfad>?mode=ro&immutable=1`. Ohne WAL-Datei steckt der gesamte Stand
    in der Hauptdatei, der Lesezugriff ist exakt.
- **Begründung:** Skopos braucht damit weder die Gruppe des Eigentümers noch `sudo -u`. Die
  Rechte fremder Software bleiben unberührt (Grundsatz „nur lesen“).
- **Folgen:** Jeder DB-lesende Check nutzt diese eine Öffnungsfunktion und wird gegen beide
  Fälle getestet.

## 6. Leseweg: SSH und `skopos report --json`

- **Kontext:** Der Auswerter braucht die Daten, soll aber das Schema nicht kennen.
- **Entscheidung:** Abholung per SSH und `skopos report --json [--since <ISO>]`, nicht direkt
  aus der DB.
- **Begründung:** Das Schema bleibt intern und darf sich ändern. Der Auswerter braucht kein
  SQLite. Der Report kann Veraltetes (Alter des Heartbeats) gleich mitrechnen
  (Grundsatz „erst rechnen, dann lesen“).
- **Folgen:** Der Report ist die stabile Schnittstelle und wird versioniert.

## 7. Eigener Systemnutzer und systemd-Härtung

- **Kontext:** „Nur lesen“ soll nicht von der Disziplin des Codes abhängen.
- **Entscheidung:** Ein Systemnutzer `skopos` ohne Login-Shell mit der Zusatzgruppe
  `systemd-journal` (Journal inklusive Kernel für OOM- und Log-Checks); kein sudo. Die Unit
  setzt `ProtectSystem=strict`, `ReadWritePaths=/var/lib/skopos`, `ProtectHome=read-only`,
  `NoNewPrivileges=yes`, `PrivateTmp=yes` und weitere Schutzschalter. `PrivateNetwork=yes`
  sperrt jedes Netz, `MemoryMax=200M` und `CPUQuota=50%` deckeln den Verbrauch.
- **Begründung:** Ein Check-Bug, der schreiben will, scheitert am Kernel, nicht an der Disziplin.
  Dasselbe gilt für „Pull, kein Push“: Ohne Netz kann kein Code etwas senden. Der Deckel
  schützt die überwachten Dienste auf kleiner Hardware vor Skopos selbst.
- **Folgen:** Checks, die mehr Rechte brauchen, sind eine bewusste Erweiterung mit eigener Entscheidung.

## 8. Verteilung: generischer Installer, lokal auf dem Zielhost

- **Kontext:** Auf den Zielen soll es weder Git-Checkout noch npm geben.
- **Entscheidung:** Das Repo liefert einen generischen Installer, der **lokal auf dem Zielhost**
  läuft: `sudo bin/install.sh --config <file>`. Wie der Code dorthin kommt (z. B.
  `git archive` plus `tar` über SSH), entscheidet ein privater Wrapper außerhalb des Repos. Die
  Commit-Kennung landet in `/opt/skopos/VERSION` und im Heartbeat.
- **Begründung:** Der Installer ist damit für jeden nutzbar, der das Repo herunterlädt. „Pull,
  kein Push“ betrifft **Messdaten**; ein Code-Deploy vom Admin-Rechner verletzt ihn nicht.
- **Folgen:** Ein Update ist derselbe Befehl.

## 9. Rollout: mit der schwächsten Hardware beginnen

- **Kontext:** Ein Fehler in Skopos darf keine produktive Maschine beeinträchtigen.
- **Entscheidung:** Zuerst die schwächste Testmaschine, dann die übrigen, die wichtigste zuletzt.
  Welche Maschine welche Stufe ist, steht im Betriebsplan, nicht hier.
- **Begründung:** Wenn es auf der kleinsten Hardware läuft, läuft es überall; Fehler treffen
  zuerst die, bei denen es am wenigsten kostet.
- **Folgen:** Die Ressourcengrenzen aus Entscheidung 2 gelten als Abnahmekriterium.

## 10. Kleinere Annahmen

- CPU-Last über den Load-Average.
- Zuordnung eines Befunds zu einem Themenbereich liegt beim Auswerter, nicht bei Skopos.
- Der Auswerter misst wöchentlich einen Wert per Stichprobe selbst nach (siehe Grundsatz 6 in
  [concept.de.md](concept.de.md)).

## 11. Englischer Code und englische Schnittstelle

- **Kontext:** Das Repo soll öffentlich werden und für jeden nutzbar sein, der es herunterlädt.
- **Entscheidung:** Code, Bezeichner, Kommentare, Tests, CLI-Parameter (`--since`),
  Config-Schlüssel (`interval_minutes`, `key`), Check-Namen (`sqlite-query`), Report-Felder
  (`stale`, `history`), DB-Spalten, Meldungen und Dateinamen (`install.sh`) sind englisch.
  Die Doku unter `doc/` bleibt deutsch, die READMEs sind zweisprachig.
- **Begründung:** Wer das Repo öffnet, liest zuerst Code und Schnittstelle. Deutsche Bezeichner
  schließen die meisten Leser aus; eine englische Schnittstelle mit deutschem Innenleben wirkt
  unfertig. Umgestellt wurde, bevor außer dem Kern Code existierte.
- **Folgen:** Das Schema beginnt mit englischen Spalten neu bei Version 1; es gab noch keine
  Installation, die migriert werden müsste.

## 12. Sammler im Repo: Zustandsmaschine generisch, Meldung austauschbar

- **Kontext:** Bisher holte ein privates Skript einmal täglich ab und wertete aus. Für eine
  Reaktion in Minuten braucht es häufige Abholung und eine Bewertung, die nur bestätigte
  Zustandswechsel meldet, sonst erzeugt jede Spitze eine Meldung. Diese Logik (Soft/Hard,
  Erholung, Host-Abhängigkeit, Flapping, Drosselung) hängt an keinem bestimmten Betrieb.
- **Entscheidung:** Abholung, Zustandsmaschine und Zustandsspeicher kommen als
  `skopos collect` ins Repo, englisch und getestet wie der Kern. Gemeldet wird über eine
  austauschbare Notifier-Schnittstelle; mitgeliefert ist `command`, das jeden bestätigten
  Wechsel als JSON auf stdin an einen konfigurierten Befehl gibt. Was daraus wird (Ticket,
  Mail, Chat), liegt beim Betreiber außerhalb des Repos. Nur ein Host wird als Sammler
  konfiguriert; er läuft als User-Unit eines normalen Nutzers mit SSH-Zugang.
- **Begründung:** Wer Skopos herunterlädt, soll auch auswerten können, ohne die schwierige
  Hälfte selbst zu schreiben. Derselbe Code läuft auf jedem Host, Unterschiede stehen nur in
  der Konfiguration (Grundsatz 5). „Pull, kein Push“ bleibt: Die Hosts senden nichts, der
  Sammler holt ab; der Messdienst bleibt ohne Netz (Entscheidung 7). Skopos alarmiert auch
  weiterhin nicht selbst: Es erkennt den Wechsel, die Meldung ist ein fremder Befehl.
- **Folgen:** Das Ereignisformat (`event_version`) ist neben dem Report eine zweite stabile
  Schnittstelle. Die Zustandsdatei des Sammlers ist zugleich sein Heartbeat und wird auf dem
  Sammler-Host mit einem `json-file`-Check überwacht. Details: [collector.de.md](collector.de.md).

## 13. Angekündigter Neustart: Markerdatei statt Sonderfall je Host

- **Kontext:** `boot` meldet jeden Neustart als `warn`, egal ob er ein Absturz war oder eine
  bewusste Wartungsaktion (z. B. ein Kernel-Update mit anschließendem Reboot). Ohne
  Unterscheidung erzeugt jede geplante Wartung denselben Befund wie ein echter Vorfall — auf
  Dauer entweder viel Rauschen oder die Versuchung, den Check host-weise stummzuschalten und
  damit auch echte Abstürze zu übersehen.
- **Entscheidung:** `bin/skopos.js expect-reboot [--reason <text>]` schreibt vor einem bewussten
  Neustart eine kleine Markerdatei (Vorgabe `/var/lib/skopos/expected-reboot.json`, derselbe
  Pfad auf jedem Host). Der `boot`-Check liest sie beim nächsten Neustart: war das Ende `clean`
  und der Marker frisch, wird der Befund `ok` statt `severity`. Der Marker ist Einweg (gelesen
  und gelöscht bei genau diesem Neustart) und verfällt eigenständig nach
  `expected_max_age_minutes` (Vorgabe 30) — ein Marker aus einem abgebrochenen Wartungslauf
  bleibt nie liegen, um sich später an einen unabhängigen Neustart zu hängen. Ein `unclean`-Ende
  bleibt vom Marker unberührt.
- **Begründung:** Kein Host-Sonderfall im Code (Grundsatz 5) — derselbe Mechanismus greift
  automatisch auf jedem Host, der Skopos installiert, ohne Eintrag in dessen Konfiguration.
  Eine Datei statt eines Zustands in der Skopos-DB, weil sie von einem beliebigen Aufrufer
  (root, ein Wartungsskript, manuell per SSH) geschrieben wird, ohne den Namen des lokal
  konfigurierten `boot`-Checks kennen zu müssen. Das Verfallsdatum statt einer einmaligen
  Löschung beim Schreiben verhindert, dass ein liegen gebliebener Marker einem späteren, nicht
  damit gemeinten Neustart fälschlich „geplant“ zuschreibt.
- **Folgen:** `expected_marker` und `expected_max_age_minutes` sind neue optionale Parameter von
  `boot` (siehe [checks.de.md](checks.de.md)); bestehende Konfigurationen ohne diese Parameter
  verhalten sich unverändert. Wer den Befehl vor einem Neustart nicht aufruft, sieht weiterhin
  den bisherigen `warn`/`crit` — der Marker ist eine Ergänzung, keine Voraussetzung.

## 14. Zweisprachige Doku unter `doc/`

- **Kontext:** Das Repo soll auf GitHub öffentlich werden; bisher war `doc/` rein deutsche
  Prosa mit deutschen Dateinamen (`konzept.md`, `entscheidungen.md`, …), während Entscheidung 11
  Code und Schnittstelle schon englisch gemacht hatte, damit das Projekt für jeden nutzbar ist,
  der es herunterlädt.
- **Entscheidung:** Jedes Dokument unter `doc/` gibt es zweimal: `<name>.md` englisch (Standard,
  ohne Suffix) und `<name>.de.md` deutsch, beide verlinken oben aufeinander. Die Dateinamen
  selbst sind englisch (`concept.md`, `decisions.md`, `core.md`, `checks.md`,
  `installation.md`, `collector.md`, `examples.md`) — passend zur bestehenden
  `README.md`/`README.de.md`-Konvention und zum bei GitHub üblichen Muster für lokalisierte
  Dateien, statt einer Verzeichnisaufteilung `doc/en/`, `doc/de/`.
- **Begründung:** Wer das Repo auf GitHub öffnet, liest zuerst Code und die obersten Dokus;
  Englisch als Standard senkt die Hürde, das Veröffentlichte tatsächlich zu nutzen. Die
  Suffix-Konvention brauchte kein neues Werkzeug und blieb konsistent mit dem, was die READMEs
  schon taten. Eine Verzeichnisaufteilung hätte für sieben Dokumente, die kein
  Doku-Site-Generator brauchen, eigene Index-Dateien je Sprache und mehr bewegliche Teile
  bedeutet.
- **Folgen:** Jede künftige inhaltliche Änderung an einem Dokument erfolgt zweimal (je Sprache)
  oder wird zur Übersetzung vorgemerkt; `bin/install.sh` kopiert den ganzen `doc/`-Ordner nach
  `/opt/skopos/doc`, damit beide Sprachen auch auf dem installierten Host selbst verfügbar
  sind, ohne Repo-Checkout.
