# Skopos — Konfigurationsbeispiele

Rezepte für den Einstieg: Wie sieht eine Config für einen bestimmten Überwachungszweck aus?
Jedes Beispiel ist ein eigenständiger, lauffähiger Ausschnitt aus `checks` (in eine eigene
Config-Datei mit `interval_minutes`, `retention_days`, `timeout_seconds` einbetten, siehe
Grundgerüst unten). Die vollständige Parameterliste je Check steht in
[checks.de.md](checks.de.md), das Schema der Config-Datei in [core.de.md](core.de.md), das „Warum“ des
Projekts in [concept.de.md](concept.de.md). Dieses Dokument ersetzt keine der drei — es zeigt nur,
wie man anfängt. English: [examples.md](examples.md).

Der Installer kopiert `doc/` mit nach `/opt/skopos/doc` — dieses Dokument liegt also auch auf
jedem installierten Zielhost selbst und ist dort ohne Repo-Checkout lesbar, für ein LLM oder
einen Menschen, der/die die laufende Installation konfigurieren soll.

An ein LLM oder einen Menschen, die/der Skopos zum ersten Mal konfiguriert: Ein Check wird
durch einen Eintrag in `checks` aktiviert, jeder Eintrag braucht `check` (Modulname aus der
Tabelle unten) und `key` (frei wählbarer Instanzname). Mehrere Beispiele lassen sich in einer
Config kombinieren, indem ihre `checks`-Einträge in eine gemeinsame Liste kommen — ein
vollständiges Beispiel mit fast allen Checks liegt unter
[../config/example.json](../config/example.json).

## Grundgerüst

```json
{
  "interval_minutes": 5,
  "retention_days": 30,
  "timeout_seconds": 30,
  "checks": []
}
```

`checks` ist die einzige Pflichtangabe; die drei anderen Schlüssel haben die oben gezeigten
Vorgaben. Ein Testlauf gegen eine Wegwerf-DB:

```bash
bin/skopos.js run --config <deine-datei>.json --db /tmp/skopos.db
bin/skopos.js report --json --db /tmp/skopos.db
```

## RAM- und CPU-Überwachung

```json
{ "check": "memory", "key": "memory", "ram_warn_percent": 90, "ram_crit_percent": 95 },
{ "check": "load", "key": "cpu", "warn_ratio": 1.5, "crit_ratio": 3 }
```

`memory` misst RAM- und Swap-Belegung in Prozent (`/proc/meminfo`), `load` die
Load-Average je Kern. Ohne Angaben gelten die oben gezeigten Werte bereits als Vorgabe — der
Check funktioniert also auch mit nur `{ "check": "memory", "key": "memory" }`. Details,
inklusive Grenzfälle wie „keine Swap-Partition“: [checks.de.md](checks.de.md#memory) und
[checks.de.md](checks.de.md#load).

## Festplattenbelegung

```json
{ "check": "disk", "key": "disk", "mounts": ["/", "/var"], "warn_percent": 85, "crit_percent": 95 }
```

`mounts` ist Pflicht (absolute Pfade); jeder Pfad ergibt einen eigenen Messwert
(`disk./var` → Schlüssel `var`). Details: [checks.de.md](checks.de.md#disk).

## Reboots erkennen — auch geplante (Updates)

```json
{ "check": "boot", "key": "boot" }
```

Meldet jeden Neustart der Maschine genau einmal, mit `clean`/`unclean`-Einordnung
(geordnetes Herunterfahren erkannt am Journal des Vorstarts, oder nicht). Ein Neustart nach
einem geplanten Update soll aber keinen Befund wie ein Absturz auslösen: Vor dem geplanten
Neustart einmal

```bash
bin/skopos.js expect-reboot --reason "kernel update"
```

aufrufen (z. B. im Update-Skript, direkt vor `reboot`). War der folgende Neustart `clean` und
die Markerdatei jung genug (Vorgabe 30 Minuten), wertet `boot` ihn als `ok` statt als
Befund — ohne dass die Config etwas davon wissen muss. Ein `unclean`-Ende (Absturz) bleibt
davon unberührt. Details, inklusive der optionalen Parameter `severity`,
`unclean_severity`, `expected_max_age_minutes`: [checks.de.md](checks.de.md#boot).

## Dienste und fehlgeschlagene Units

```json
{
  "check": "systemd",
  "key": "services",
  "boot_grace_seconds": 600,
  "restart_grace_seconds": 120,
  "units": [
    { "unit": "example-app.service", "expected": "active", "severity": "crit" },
    { "unit": "example-legacy.service", "expected": "inactive", "severity": "warn" }
  ]
},
{ "check": "failed-units", "key": "failed", "ignore": ["example-optional.service"] }
```

`systemd` prüft eine explizite Liste von Units gegen den erwarteten Zustand (auch, dass eine
Unit bewusst *nicht* läuft). `boot_grace_seconds` toleriert die Startphase nach einem
Neustart, `restart_grace_seconds` einen kontrollierten `systemctl restart`. `failed-units`
zählt rechnerweit alle Units im Zustand `failed`, unabhängig davon, ob sie in der `systemd`-
Liste stehen — nützlich für Timer-Jobs, die man nicht einzeln aufführen will. Details:
[checks.de.md](checks.de.md#systemd), [checks.de.md](checks.de.md#failed-units).

### Beispiel: SSH-Zugang

```json
{
  "check": "systemd",
  "key": "services",
  "boot_grace_seconds": 600,
  "units": [
    { "unit": "ssh.socket", "expected": "active", "severity": "crit" }
  ]
}
```

Welche Unit einzutragen ist, hängt von der Distribution ab. Vor dem Eintrag nachsehen:

```bash
systemctl is-enabled ssh.socket ssh.service sshd.service
```

- **`ssh.socket` ist aktiviert** (aktuelle Ubuntu-Versionen): systemd lauscht auf dem Port
  und startet `ssh.service` bei der ersten Verbindung. Überwacht wird `ssh.socket`. Nach
  einem Neustart bleibt `ssh.service` `inactive`, bis sich jemand verbindet; ein Eintrag
  dafür würde einen Befund melden, obwohl SSH funktioniert.
- **Keine Socket-Unit:** den Dienst selbst überwachen, `ssh.service` unter Debian und Ubuntu,
  `sshd.service` bei den meisten anderen Distributionen.

Eine Unit, die es auf dem Host nicht gibt, erscheint als `unknown` (`unit not found`) und
nicht als gestoppt; ein falscher Name bleibt also nicht unbemerkt.

Eine Grenze, wenn ein Sammler die Reports per SSH abholt: Solange SSH ausgefallen ist,
bekommt der Sammler den Report nicht und meldet stattdessen den Host als nicht erreichbar.
Der Befund dieses Checks kommt mit der Historie an, sobald SSH wieder läuft. Auf dem
Sammler-Host selbst, der lokal gelesen wird, kommt er sofort an.

## Fehlermeldungen im Journal

```json
{ "check": "journal", "key": "errors", "priority": "err", "exclude": ["^example noisy driver"], "severity": "warn" }
```

Zählt Journal-Einträge ab der angegebenen Priorität seit dem letzten Lauf, optional auf
Units eingeschränkt (`units: [...]`) und mit Ausschlussmustern gegen bekanntes Rauschen.
Details: [checks.de.md](checks.de.md#journal).

## Kernel-OOM-Kills

```json
{ "check": "oom", "key": "oom", "severity": "crit" }
```

Zählt vom Kernel getötete Prozesse seit dem letzten Lauf. Details:
[checks.de.md](checks.de.md#oom).

## Erreichbarkeit eines Mounts (Netzlaufwerk, FUSE)

```json
{ "check": "mount", "key": "mounts", "paths": ["/mnt/example"], "read_timeout_seconds": 5 }
```

Prüft, ob der Pfad ein Mountpoint ist und sein Verzeichnis innerhalb der Zeitgrenze lesbar
ist — ein hängender Netz-Mount ergibt `crit`, nicht einen blockierten Skopos-Prozess.
Details: [checks.de.md](checks.de.md#mount).

## Eine fachliche Kennzahl aus einer fremden SQLite-Datenbank

```json
{ "check": "sqlite-query", "key": "queue_length", "database": "/var/lib/example-app/app.db",
  "query": "SELECT COUNT(*) FROM jobs WHERE state = 'pending'", "unit": "jobs",
  "warn_above": 100, "crit_above": 1000 }
```

Ein Momentaufnahme-Beispiel (aktuelle Warteschlangenlänge). Für einen Zähler, der nur
zunehmen soll (z. B. Fehler pro Tag), misst `delta: true` den Zuwachs seit dem letzten Lauf:

```json
{ "check": "sqlite-query", "key": "errors_total", "database": "/var/lib/example-app/app.db",
  "query": "SELECT SUM(errors) FROM daily_stats", "null_as": 0,
  "delta": true, "on_decrease": "rebase", "unit": "errors",
  "warn_above": 1, "crit_above": 20 }
```

Die Verbindung ist immer schreibgeschützt, unabhängig von der Abfrage. `on_decrease`
entscheidet, wie ein fallender Wert gedeutet wird (`"restart"` für einen Zähler, der
regelmäßig neu beginnt, `"rebase"` für eine Summe, die eigentlich nie fallen sollte).
Details, inklusive der Sicherung gegen schreibende Abfragen:
[checks.de.md](checks.de.md#sqlite-query-und-json-file) und [checks.de.md](checks.de.md#sqlite-query).

## Eine fachliche Kennzahl aus einer JSON-Datei

```json
{ "check": "json-file", "key": "last_run", "file": "/var/lib/example-app/last-run.json",
  "field": "status", "expected": "ok", "warn_age_seconds": 172800 }
```

Liest ein Feld (Punktpfad möglich, z. B. `result.status`) und bewertet zusätzlich das
Dateialter — nützlich für „lief der letzte Cronjob/Batch-Job erfolgreich und rechtzeitig?“.
Details: [checks.de.md](checks.de.md#json-file).

## Uptime als einfache Alternative zu `boot`

```json
{ "check": "uptime", "key": "uptime", "warn_below_seconds": 300 }
```

Meldet einen Befund, solange die Maschine kürzer als angegeben läuft — einfacher als `boot`,
aber ohne Unterscheidung „geplant/ungeplant“ und ohne einmaliges Ereignis (der Befund bleibt
bestehen, solange die Uptime unter der Schwelle liegt). Für die meisten Fälle ist `boot` die
bessere Wahl.

## Pflege dieses Dokuments

`test/doc.test.js` prüft bei jedem `npm test`, dass jeder Check aus `lib/checks/index.js`
hier mit seinem Namen vorkommt — ein neuer Check ohne Beispiel lässt die Tests fehlschlagen,
statt dass die Doku still veraltet. Ein neuer Parameter an einem bestehenden Check bricht den
Test nicht, gehört aber trotzdem in dieses Dokument oder in [checks.de.md](checks.de.md), sobald er
den Einstieg betrifft.
