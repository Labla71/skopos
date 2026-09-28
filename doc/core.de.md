# Skopos — Kern

Wie der Kern arbeitet: Konfiguration, Check-Schnittstelle, Speicher, Heartbeat, Report.
Das „Warum“ steht in [concept.de.md](concept.de.md) und [decisions.de.md](decisions.de.md).
Code, Schnittstelle und Meldungen sind englisch, diese Doku ist deutsch. English: [core.md](core.md).

## Aufruf

```bash
bin/skopos.js run    [--config <file>] [--db <file>]
bin/skopos.js report --json [--since <ISO timestamp>] [--db <file>]
bin/skopos.js collect --config <file>
```

`collect` ist der Sammler, der die Reports anderer Hosts abholt und bestätigte
Zustandswechsel meldet: [collector.de.md](collector.de.md).

Das Skript direkt aufrufen, nicht über `node bin/skopos.js`: Nur dann greift der Schalter
`--disable-warning=ExperimentalWarning` aus der ersten Zeile, sonst kann je nach Laufdauer
die Warnung zu `node:sqlite` auf stderr erscheinen. Das gilt auch für die systemd-Unit und
den Abruf per SSH.

Vorgaben: Config `/etc/skopos/config.json`, DB `/var/lib/skopos/skopos.db` (umlenkbar per
`--db` oder Umgebungsvariable `SKOPOS_DB`). Exit-Codes: `0` ok, `1` Laufzeitfehler (z. B.
DB fehlt beim Report), `2` ungültige Konfiguration oder Argumente.

## Konfiguration

JSON, streng geprüft (`lib/config.js`); alle Fehler werden gesammelt und zusammen gemeldet.
Kommentare nur im Feld `_comment`.

| Schlüssel | Bedeutung | Vorgabe |
|---|---|---|
| `checks` | Liste der Checks, mindestens einer (Pflicht) | — |
| `interval_minutes` | Takt des Timers; der Installer stellt den Timer darauf ein, der Kern schreibt ihn in den Heartbeat, damit der Report `stale` bewerten kann | 5 |
| `retention_days` | Aufbewahrung der Läufe und Messwerte | 30 |
| `timeout_seconds` | Zeitgrenze je Check | 30 |

Jeder Eintrag in `checks` hat `check` (Name des Check-Moduls), `key` (Instanzname,
`A-Z a-z 0-9 _ -`, je Check eindeutig), optional `timeout_seconds` und `_comment` sowie die
Parameter des Checks. Unbekannte Checks, unbekannte Schlüssel und fehlende Pflichtwerte
brechen ab; Namen wie `toString` oder `__proto__` gelten als unbekannt. Beispiele:
`config/example*.json`.

## Check-Schnittstelle

Ein Check ist ein Modul in `lib/checks/` und ein Eintrag in `lib/checks/index.js`:

```js
export default {
  name: 'example',
  required: ['file'],         // Pflichtparameter der Config
  optional: ['warn_above'],   // weitere erlaubte Parameter
  validate(params) { return []; },               // optional: Fehlermeldungen
  async measure(params, ctx) {                   // liefert Ergebnis oder Liste davon
    return [{ key: 'part', value: 1, unit: 's', status: 'ok', reason: undefined }];
  },
};
```

- `status` ist `ok`, `warn`, `crit` oder `unknown`. `value` ist eine endliche Zahl oder ein
  Text; bei `unknown` fehlt er, `reason` ist dann Pflicht.
- Mehrere Messwerte eines Checks unterscheiden sich durch `key` (`A-Z a-z 0-9 _ -`);
  gespeichert wird `<instanz>.<key>`. Ein anderer Teilschlüssel ergibt `unknown`.
- `ctx.signal` (AbortSignal) wird beim Timeout abgebrochen. `ctx.state.get(k)` und
  `ctx.state.set(k, value)` halten einen Wasserstand für „seit dem letzten Lauf“; er rückt
  nur vor, wenn der Check normal durchläuft. Der Wert muss als JSON speicherbar sein
  (`undefined`, Funktionen und Zyklen nicht): `set()` wirft sonst sofort, der Check wird
  `unknown`, und der übrige Lauf bleibt unberührt.
- Wirft ein Check, überschreitet er die Zeitgrenze oder liefert er Ungültiges, speichert der
  Kern `unknown` mit Grund. Andere Checks laufen weiter. Die Checks laufen nacheinander und
  müssen asynchron arbeiten: Ein synchroner Dauerlauf lässt sich nicht unterbrechen.

Vorhanden: `uptime` (Parameter `warn_below_seconds`, optional) sowie die System-Checks `boot`, `memory`,
`load`, `disk`, `oom`, `journal`, `failed-units`, `systemd` und `mount` sowie die fachlichen Checks `sqlite-query` und
`json-file`, beschrieben in [checks.de.md](checks.de.md).

## Speicher

Ein Modul (`lib/store.js`) kapselt `node:sqlite`. Eigene DB im Journal-Modus `DELETE`,
Dateirechte `0644`. Schemaversion in `PRAGMA user_version` (derzeit 1). Ein Lauf migriert
eine ältere DB schrittweise (`MIGRATIONS`); der Report öffnet nur lesend und bricht bei einer
älteren oder neueren Version mit Hinweis ab.

Lauf (Timer) und Report (Abholung) können sich treffen. Beide Seiten warten dann bis zu
10 Sekunden (`busy_timeout`), statt mit „database is locked“ abzubrechen.

- `runs` — Heartbeat: `started_at`, `finished_at`, `duration_ms`, `count_<status>`, `version`,
  `interval_minutes`. Wird am Ende eines Laufs zusammen mit den Messwerten in einer
  Transaktion geschrieben; ein abgebrochener Lauf hinterlässt keinen Heartbeat, und genau das
  ist der Befund.
- `measurements` — `run_id`, `time`, `check`, `key`, `value`, `unit`, `status`, `reason`.
- `state` — `check`, `key`, `value` (JSON); zusätzlich `skopos/last_prune`.

Retention: Einmal je 24 Stunden löscht der Lauf Läufe und Messwerte, die älter als
`retention_days` sind.

## Report

`report --json` öffnet die DB nur lesend und gibt aus (`report_version` 1):

- `heartbeat`: letzter Lauf (`run_id`, `started_at`, `finished_at`, `duration_ms`, `counts` je
  Status, `version`, `age_seconds`, `interval_minutes`, `stale`, `runs_in_window`); `null`,
  wenn noch nie ein Lauf stattfand. `stale` ist `true`, wenn seit dem letzten Lauf mehr als
  zwei Takte vergangen sind, und `null`, wenn der Lauf keinen Takt kennt.
- `checks[]`: Messwerte des letzten Laufs (`check`, `key`, `status`, `reason`, `value`,
  `unit`, `time`).
- `history[]`: alle Messwerte seit `--since` (Vorgabe: letzte 24 Stunden), gleiche Felder.

Fehlt die DB, bricht der Report mit Exit-Code 1 ab, statt eine leere Ausgabe zu erfinden.

`history[]` enthält Rohzeilen, rund 13.000 je Tag bei 15 Checks. Ein Auswerter, der
regelmäßig abholt, übergibt deshalb `--since` mit dem Zeitpunkt seiner letzten Abholung;
`skopos collect` macht genau das ([collector.de.md](collector.de.md)).
