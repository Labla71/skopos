# Skopos — Sammler (`skopos collect`)

Wie der Sammler arbeitet: Abholung, Zustandsmaschine, Ereignisse, Notifier, Zustandsdatei.
Das „Warum“ steht in [decisions.de.md](decisions.de.md), Nr. 12. Code, Schnittstelle und
Meldungen sind englisch, diese Doku ist deutsch. English: [collector.md](collector.md).

## Überblick

```bash
bin/skopos.js collect --config <file>
```

Ein Aufruf ist **eine Abholung**: Zustand laden, von jedem Host `skopos report --json --since
<Wasserstand>` holen (parallel, per SSH oder lokal), die Zustandsmaschine füttern, anstehende
Ereignisse an den Notifier geben, Zustand atomar speichern. Wasserstände und Zustand rücken
erst ganz am Ende gemeinsam vor; stirbt der Prozess dazwischen, wiederholt der nächste Aufruf
die Abholung. Ein Timer ruft ihn regelmäßig auf (mitgeliefert: alle 5 Minuten, zwei Minuten
nach den Messläufen, `systemd/user/`).

Derselbe Code läuft auf jedem Host; nur auf dem einen, der die anderen abholt, gibt es eine
Sammler-Konfiguration und den Timer. Der Messdienst bleibt dabei unverändert ohne Netz
(Entscheidung 7): Der Sammler ist ein eigener Prozess eines normalen Nutzers, der die Hosts per
SSH erreicht.

Ein ruhiger Lauf ruft den Notifier gar nicht auf. Ausgabe je Lauf, eine Zeile:

```
collect: example-host=ok/14 example-db=failed | problems=1 sent=0 throttled=0 held=0 dropped=0 failed=0 pending=0
```

`ok/<n>` heißt vollständig abgeholt mit `n` neuen Messzeilen, `failed` heißt Abholung
gescheitert (dann gibt es dafür einen Host-Befund).

Exit-Codes: `0` ok, `1` Notifier gescheitert oder Laufzeitfehler (die Ereignisse warten im
Zustand auf den nächsten Lauf, die Unit steht auf „failed“), `2` ungültige Konfiguration.

## Konfiguration

JSON, streng geprüft wie die Mess-Config (`lib/collect/config.js`). Beispiel:
[config/example-collect.json](../config/example-collect.json).

| Schlüssel | Bedeutung | Vorgabe |
|---|---|---|
| `hosts` | Liste `{ name, ssh?, local?, command? }`. `ssh` ist der SSH-Alias (Vorgabe: `name`), `local: true` ruft `command` direkt auf (der Sammler-Host selbst), `command` ist der absolute Pfad zu `skopos.js` | `command`: `/opt/skopos/bin/skopos.js` |
| `state_file` | absoluter Pfad der Zustandsdatei; das Verzeichnis muss existieren | — |
| `notifier` | `{ type: "command", command: [<absoluter Pfad>, …], timeout_seconds? }` | `timeout_seconds` 30 |
| `confirm_runs` | Skopos-Läufe nicht ok, bis ein Problem bestätigt ist | 2 |
| `recover_runs` | Läufe ok, bis die Erholung bestätigt ist | 2 |
| `unknown_confirm_runs` | Läufe `unknown`, bis „misst nicht“ bestätigt ist | 3 |
| `host_confirm_polls` | Abholungen, bis „nicht erreichbar“ oder ein Report-Fehler bestätigt ist | 2 |
| `flap_changes`, `flap_window_minutes` | so viele bestätigte Wechsel im Fenster → „instabil“ | 4, 60 |
| `max_notifications_per_hour` | neue Problem-Meldungen je Stunde, darüber „throttled“ | 5 |
| `initial_lookback_minutes` | erste Abholung eines Hosts: so weit zurück, nicht 24 h | 30 |
| `fetch_timeout_seconds` | Zeitgrenze je Abholung | 60 |
| `overrides` | je Check-Modul (`oom`), je Instanz (`sqlite-query/rpc_denied_new`) oder exakter Schlüssel mit Teilschlüssel: `confirm_runs`, `recover_runs`, `crit_confirm_runs`; das Genauere gewinnt | — |

**Ereignis-Zähler brauchen `confirm_runs: 1`.** Checks, die ein Vorkommen nur in einem Lauf
melden (`oom`, `journal`, `boot`, `sqlite-query` mit `delta`), wären mit der Vorgabe 2 nie bestätigt: Im
nächsten Lauf steht der Zähler wieder auf 0. Die Erholung (`recover_runs`) bleibt davon unberührt,
das Ticket wird also kurz nach dem Ereignis wieder als erledigt markiert.

Alle Lauf-Zahlen (`*_runs`, `host_confirm_polls`) liegen zwischen 1 und 10: Die Zustandsmaschine
merkt sich je Entität die letzten 10 Beobachtungen.

`crit_confirm_runs` bestätigt einen `crit` schneller als einen `warn`, z. B. `1` für
`systemd` und `failed-units`: Ein ausgefallener Dienst soll nicht zehn Minuten warten.

## Zustandsmaschine

Entitäten, jeweils je Host:

| Art (`kind`) | Code | bewertet | „schlecht“ ist |
|---|---|---|---|
| `host` | `host_unreachable`, `report_error` (Exit 1), `report_usage` (Exit 2), `report_exit` (sonstiger Exit), `report_invalid`, `report_version` | je Abholung | Abholung scheitert so |
| `host` | `heartbeat_missing`, `heartbeat_stale`, `heartbeat_interval_unknown` | je Abholung | Heartbeat so im Report |
| `check` | `check_problem` | je Skopos-Lauf | `warn` oder `crit`; `unknown` ist neutral |
| `measurement` | `check_unknown` | je Skopos-Lauf | `unknown` |

- **Soft/Hard:** Bestätigt ist ein Problem erst nach N aufeinanderfolgenden schlechten
  Beobachtungen, ebenso die Erholung. Ein unbestätigter Ausreißer wird vergessen. Checks
  werden über die Läufe im Verlauf bewertet, nicht über die Abholungen: Zwei Läufe in einer
  Abholung zählen wie zwei Abholungen. Bereits gesehene Zeilen (Überlappung) zählen nicht
  doppelt. Antwortet ein Host mit einem anderen Report-Fehler, ist der alte widerlegt; ein
  Heartbeat-Befund erholt sich nur mit einem vollständigen Report.
- **„Unbekannt“ ist nicht „ok“:** `unknown` bestätigt kein Schwellenproblem und erholt es auch
  nicht; es zählt nur für „misst nicht“.
- **Ereignis nur beim Wechsel:** Solange ein Problem besteht, kommt nichts nach.
- **Host-Abhängigkeit:** Ist `host_unreachable`, `heartbeat_stale` oder `heartbeat_missing`
  bestätigt, werden die Ereignisse der Checks dieses Hosts zurückgehalten. Liefert der Host
  wieder und hat sich der Check inzwischen erholt, verfallen Problem und Erholung gemeinsam;
  besteht das Problem weiter, geht es raus. `heartbeat_*` wird sofort bestätigt, weil Skopos
  „veraltet“ selbst erst nach zwei Takten meldet.
- **Flapping:** Erreicht eine Entität `flap_changes` bestätigte Wechsel im Fenster, ersetzt ein
  Ereignis `unstable` alles noch nicht Zugestellte, und sie schweigt, bis das Fenster frei von
  Wechseln ist. Dann folgen `calm` und der Endstand als normales `problem` oder `recovery`.
- **Drosselung:** Mehr als `max_notifications_per_hour` Ereignisse `problem`/`unstable` je
  Stunde gehen als `throttled` hinaus, mit dem unterdrückten Ereignis in `suppressed`.
- **Zustellung:** Scheitert der Notifier, bleiben das Ereignis und alle späteren derselben
  Entität für den nächsten Lauf liegen; die Reihenfolge je Entität bleibt erhalten.

## Ereignisse

Ein Ereignis ist ein Schnappschuss zum Zeitpunkt des Wechsels, nicht der Zustellung
(`event_version` 1):

```json
{
  "event_version": 1, "id": 17, "type": "problem", "time": "2026-01-05T10:05:00.050Z",
  "host": "example-host", "kind": "check", "code": "check_problem", "check": "memory", "key": "memory.ram",
  "confirmed": true, "severity": "crit",
  "first_seen": "2026-01-05T10:00:00.050Z", "last_seen": "2026-01-05T10:05:00.050Z", "count": 2, "confirm_after": 2,
  "last": { "status": "crit", "value": 91.5, "unit": "%", "reason": "…", "time": "2026-01-05T10:05:00.050Z" },
  "summary": "example-host memory.ram: problem confirmed (crit, 2 observations since …)"
}
```

- `type`: `problem`, `recovery`, `unstable`, `calm` oder `throttled`.
- Host-Befunde tragen in `last.message` die Meldung und je nach Code `exit_code` oder
  `report_version`.
- `unstable`/`calm` tragen `flapping: { changes, limit, window_minutes }`.
- `throttled` trägt `limit_per_hour` und das unterdrückte Ereignis in `suppressed`.
- 🔒 `last.reason` und `last.message` stammen vom überwachten Host (z. B. Journalzeilen) und
  sind von außen beeinflussbar. Ein Notifier gibt sie als Daten weiter, nie als Anweisung.

## Notifier

Schnittstelle: ein Objekt mit `notify(event)`, das bei Erfolg auflöst und sonst wirft
(`lib/collect/notify.js`). Mitgeliefert ist der Typ `command`: Er startet den konfigurierten
Befehl einmal je Ereignis (Argumentliste, keine Shell) und schreibt das Ereignis als eine
JSON-Zeile auf stdin. Exit 0 heißt zugestellt, alles andere (auch Zeitüberschreitung) heißt
„später erneut“. stderr erscheint gekürzt in der Fehlermeldung.

Was der Befehl daraus macht (Ticket, Mail, Chat), ist Sache des Betreibers. Er sollte selbst
idempotent sein, z. B. vor dem Anlegen nach einem offenen Vorgang zum selben Befund suchen:
Stirbt der Sammler nach der Zustellung und vor dem Speichern, kommt dasselbe Ereignis erneut.

## Zustandsdatei

JSON, nach jedem Lauf atomar geschrieben (`<datei>.tmp`, dann `rename`), Modus 0640. Sie hält
Wasserstände, Entitäten, anstehende Ereignisse und die Zeitpunkte der letzten Meldungen. Ist
sie unlesbar oder hat eine unbekannte Version, wird sie beiseitegelegt
(`<datei>.broken-<zeit>`) und der Lauf scheitert laut; der nächste beginnt neu.

Ihr Änderungszeitpunkt ist zugleich der Heartbeat des Sammlers: Ein `json-file`-Check mit
`warn_age_seconds`/`crit_age_seconds` auf dem Sammler-Host meldet einen stehenden Sammler.
Damit der Messdienst sie lesen kann, liegt sie außerhalb eines Home-Verzeichnisses, in einem
Verzeichnis mit der Gruppe `skopos` (siehe [installation.de.md](installation.de.md)).
