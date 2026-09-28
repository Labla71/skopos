# Skopos — System-Checks

Die generischen Checks, die auf jeder Linux-Maschine sinnvoll sind. Aufbau und Schnittstelle
stehen in [core.de.md](core.de.md), das „Warum“ in [concept.de.md](concept.de.md). Parameter und Meldungen
sind englisch, diese Doku ist deutsch. Vollständiges Beispiel: `config/example.json`;
einzelne, kommentierte Rezepte je Überwachungszweck: [examples.de.md](examples.de.md).
English: [checks.md](checks.md).

Gemeinsam: Alle Checks sind nur lesend. Kann ein Check nicht messen (Quelle fehlt, Befehl
scheitert, Ausgabe unbrauchbar), speichert er `unknown` mit Grund, nie eine Null. Schwellen
gelten „ab“ (`≥`). Die Tests injizieren die Quellen (`/proc`-Texte, Befehlsausgaben), sie lesen
nichts live.

| Check | Schlüssel (`<key>.<teil>`) | Wert |
|---|---|---|
| `boot` | `reboots` | 1 im Lauf nach einem Neustart der Maschine, sonst 0 |
| `memory` | `ram`, `swap` | Belegung in % |
| `load` | `load1`, `load5`, `load15` | Load-Average je Kern |
| `disk` | je Mountpoint (`/` → `root`, `/var/data` → `var_data`) | Belegung in % |
| `oom` | `kills` | OOM-Kills seit dem letzten Lauf |
| `journal` | `errors` | Journal-Einträge ab Priorität `err` seit dem letzten Lauf |
| `failed-units` | `failed` | Anzahl fehlgeschlagener systemd-Units |
| `systemd` | je Unit (`a.service` → `a_service`) | Zustand (`active` …) |
| `mount` | je Pfad | Lesedauer in ms, sonst `not mounted` / `no response` / `unreadable` |
| `sqlite-query` | — (Wert unter `<instanz>`) | eine Zahl aus einer SQL-Abfrage, oder ihr Zuwachs (`delta`) |
| `json-file` | `value`, `age` | Feld einer JSON-Datei; Dateialter in Sekunden |

Teilschlüssel aus Pfaden oder Unit-Namen müssen eindeutig sein (`/a_b` und `/a/b` ergeben beide
`a_b` und werden von der Konfigurationsprüfung abgelehnt).

## memory

Quelle `/proc/meminfo`. RAM = `(MemTotal − MemAvailable) / MemTotal`, Swap = `(SwapTotal −
SwapFree) / SwapTotal`. Ohne Swap: Wert 0 mit Hinweis `no swap configured` (gemessen, nicht
geraten). Fehlt `MemAvailable` oder eine Swap-Zeile: `unknown`.

Parameter (alle optional): `ram_warn_percent` 90, `ram_crit_percent` 95, `swap_warn_percent` 50,
`swap_crit_percent` 80. Warn-Werte entsprechen den bisherigen Schwellen der Morgenroutine; die
Crit-Werte sind neu.

## load

Quelle `/proc/loadavg`, geteilt durch die Kernzahl (`os.availableParallelism()`). Bewusst der
Load-Average statt `/proc/stat`-Deltas: kein Zustand zwischen Läufen. Die Schwellen gelten für
`load5` und `load15`; `load1` wird nur für den Verlauf gespeichert, weil eine Ein-Minuten-Spitze
auf kleiner Hardware normal ist.

Parameter: `warn_ratio` 1.5, `crit_ratio` 3.

## disk

Quelle `df -P -k -- <pfad>`, je Eintrag in `mounts` (Pflicht, absolute Pfade in Normalform: ohne Schrägstrich am Ende,
ohne `//`, `.` oder `..`). Prozent wie bei
`df`: `Used / (Used + Available)`. Fehlender Pfad, leere oder unerwartete Ausgabe, Timeout:
`unknown`.

Parameter: `warn_percent` 85, `crit_percent` 95.

## boot

Meldet den Neustart der ganzen Maschine genau einmal. Wasserstand (`ctx.state`) ist die Boot-ID
(`/proc/sys/kernel/random/boot_id`), die sich nur bei einem Neustart ändert. Anders als
`uptime` mit `warn_below_seconds` hängt das Ergebnis nicht davon ab, ob ein Lauf in die ersten
Minuten nach dem Boot fällt.

- Erster Lauf ohne gespeicherte ID: ID merken, `ok` (0), Grund `baseline`. Kein Alarm.
- ID unverändert: `ok` (0).
- ID geändert: Wert 1, die neue ID wird gespeichert (das Ereignis kommt nur einmal). Der Grund
  nennt die Bootzeit (aus der Uptime, UTC) und das Ende des Vorstarts, ermittelt am Journal
  des Vorstarts (`journalctl _BOOT_ID=<alte ID> -n 300`, als Match, nicht `-b`: eine reine
  Ziffern-ID würde als Offset gelesen):
  - **clean:** eine Meldung von systemd (PID 1), die nur beim geordneten Herunterfahren
    erscheint (`Shutting down.` oder `Reached target reboot|poweroff|halt|kexec.target`).
    Status `severity` (Vorgabe `warn`).
  - **unclean:** Journal lesbar, aber keine solche Meldung — Absturz, Stromausfall, Reset.
    Status `unclean_severity` (Vorgabe `crit`).
  - **unknown:** Journal des Vorstarts fehlt (nicht persistent), ist nicht lesbar
    (Gruppe `systemd-journal`), `journalctl` scheitert oder liefert kein JSON. Der Neustart
    wird trotzdem gemeldet, mit `severity`; im Zweifel nie `clean`. Auf Hosts ohne
    persistentes Journal ist das der Normalfall.
- Boot-ID nicht lesbar: `unknown` mit Grund, gespeicherte ID unverändert.

Parameter (optional): `severity`, `unclean_severity` (je `warn` oder `crit`). Der Wächter braucht
für `boot` wie für die anderen Ereignis-Zähler `confirm_runs: 1` (siehe [collector.de.md](collector.de.md)).
Grenze: Ein Neustart, dessen Boot-ID zwischen zwei Läufen zweimal wechselt, erscheint als ein
Ereignis; das Ende bezieht sich auf den Boot, der zuletzt gemessen wurde.

**Angekündigter Neustart.** `bin/skopos.js expect-reboot [--reason <text>]` hinterlegt vor einem
bewussten Neustart (z. B. vor einem geplanten Kernel-Update) eine Markerdatei
(Vorgabe `/var/lib/skopos/expected-reboot.json` — auf jedem Host gleich, siehe `bin/install.sh`,
keine Konfiguration je Host nötig). Findet `boot` beim nächsten Neustart einen frischen Marker
und war das Ende `clean`, wird der Befund `ok` statt `severity`, der Grund nennt den `--reason`.
Ein `unclean`-Ende bleibt davon unberührt — ein Absturz ist nie „erwartet“, auch mit Marker.
Der Marker ist Einweg: gelesen und gelöscht bei genau dem Neustart, auf den er trifft, oder
schon vorher, sobald er älter als `expected_max_age_minutes` (Vorgabe 30) ist — ein Marker aus
einem abgebrochenen Wartungslauf kann sich so nie an einen späteren, unabhängigen Neustart
hängen. Parameter (optional): `expected_marker` (Pfad, absolut), `expected_max_age_minutes`
(Zahl > 0).

## oom

Quelle Kernel-Journal (`journalctl -k -o json`). Gezählt wird eine Zeile je getötetem Prozess
(`Out of memory: Killed process …`, auch die cgroup-Variante), nicht die Begleitzeilen. Der
Journal-Cursor des jüngsten Eintrags ist der Wasserstand (`ctx.state`); der erste Lauf ohne
Cursor zählt seit dem aktuellen Boot (`-b`).

Der Cursor rückt nur nach einem normalen Lauf vor. Ist das Journal nicht lesbar (Gruppe
`systemd-journal` fehlt, `journalctl` fehlt, Timeout, keine JSON-Ausgabe) oder erster Lauf ohne
jede Kernel-Meldung: `unknown`, Cursor unverändert. Lehnt `journalctl` den gespeicherten Cursor
ab („Failed to seek to cursor“), zählt der Check einmal seit dem aktuellen Boot, setzt einen
neuen Cursor und nennt den Rückfall im Grund — auch bei `ok`. So bleibt er nicht dauerhaft
`unknown`. Kills seit dem Boot, die vorher schon gezählt waren, können dabei ein zweites Mal
erscheinen; der Grund weist darauf hin.

Parameter: `severity` (`warn`/`crit`, Vorgabe `crit`) bei mindestens einem Kill.

## journal

Fehlerzeilen im systemd-Journal seit dem letzten Lauf (`journalctl -o json`, Priorität ab
`priority`). Er übernimmt die Semantik des bisherigen Log-Scans der Morgenroutine: Prioritäten
`err` bis `emerg`, optional auf Units eingeschränkt, Ausschlussmuster gegen Rauschen. Reine
Textdateien liest er bewusst nicht (kein zweiter Wasserstandsmechanismus, solange kein Host sie
braucht).

Der Journal-Cursor des jüngsten Eintrags ist der Wasserstand (`ctx.state`); der erste Lauf ohne
Cursor blickt 24 Stunden zurück. Ein leeres Journal ist gemessen `0`, nicht `unknown` (anders
als bei `oom`: ein Host ohne Fehler ist der Normalfall). Alles wird gezählt; gespeichert werden
nur der Wert und im `reason` bis zu drei Beispiele (je 160 Zeichen, mit Unit).

Fehlerfälle, jeweils mit Grund:
- **Journal nicht lesbar** (Gruppe `systemd-journal` fehlt, `journalctl` fehlt, Timeout, keine
  JSON-Ausgabe): `unknown`, Cursor unverändert.
- **Cursor ungültig** (Journal rotiert oder gelöscht, „Failed to seek to cursor“): einmal 24
  Stunden zurück, neuer Cursor, der Grund nennt den Rückfall — auch bei `ok`.
- **Sehr viele Treffer:** Der Wert zählt alle, der `reason` bleibt kurz. Die Ausgabe eines Laufs
  ist auf 8 MB begrenzt; wird sie erreicht, ist der Wert eine Untergrenze, der Cursor bleibt
  beim letzten vollständigen Eintrag, und der nächste Lauf liest den Rest.

Parameter (alle optional): `units` (Liste von Unit-Namen; ohne Angabe das ganze System),
`priority` (`emerg`, `alert`, `crit`, `err` — Vorgabe —, `warning`), `exclude` (Liste regulärer
Ausdrücke, ohne Beachtung der Groß-/Kleinschreibung gegen den Meldungstext; ausgeschlossene
Einträge zählen nicht), `severity` (`warn` — Vorgabe — oder `crit` bei mindestens einem Treffer).

## failed-units

Zählt Units im Zustand `failed` (`systemctl list-units --failed`), rechnerweit. Ein
fehlgeschlagener Timer-Job erscheint hier; eine schlicht gestoppte Unit nicht — dafür gibt es
`systemd` mit expliziter Unit-Liste. `systemctl` nicht lauffähig: `unknown`, nie `0`.

Parameter (optional): `ignore` (Unit-Namen, die bekanntermaßen fehlschlagen dürfen), `severity`
(`warn` — Vorgabe — oder `crit`). Der `reason` nennt bis zu fünf Units.

## systemd

Konfiguriert wird die Liste `units`, je Eintrag `unit` (Pflicht), `expected` (`active`, Vorgabe,
oder `inactive`) und `severity` (`warn` oder `crit`, Vorgabe `crit`). Quelle ist `systemctl show
-p LoadState -p ActiveState` (dazu `SubState`, `Result`, `StateChangeTimestampMonotonic`); anders als `is-active` unterscheidet das eine fehlende Unit
(`unknown`, `unit not found`) von einer gestoppten. Abweichung vom Soll: `severity`. Übergangs-
zustände (`activating`, `deactivating`, `reloading`, `refreshing`) sind `warn`. Fehlt
`systemctl` oder ist der Zustand unbekannt: `unknown`.

**Karenz nach dem Boot.** Optional `boot_grace_seconds` (Zahl ≥ 0, Vorgabe 0 = aus), für die
ganze Liste. Liegt die Uptime der Maschine unter dem Wert, gelten `activating` und `inactive`
bei Units mit `expected: active` als `ok`; der Wert bleibt der echte Zustand, der Grund lautet
`within boot grace (<N> s since boot)`. Damit erzeugt ein Neustart genau einen Befund (Check
`boot`) statt einer Warnung je startendem Dienst. Nie toleriert: `failed`, sowie alle Zustände
nach Ablauf der Karenzzeit — ein Dienst, der nach zehn Minuten noch nicht läuft, ist ein
Befund. Die Karenzzeit sollte knapp über der normalen Startdauer der Maschine liegen. Andere
Checks (`mount`, `journal` …) haben keine Karenz.

**Kontrollierter Neustart.** Optional `restart_grace_seconds` (Zahl ≥ 0, Vorgabe 0 = aus) für
die ganze Liste oder je Unit (der Wert an der Unit gewinnt). Nur für Units mit `expected:
active` gilt dann: Ist die Unit in einem Übergangszustand oder `inactive`, steht `Result` auf
`success`, ist `SubState` nicht `auto-restart` und liegt der letzte Zustandswechsel
(`StateChangeTimestampMonotonic`, verglichen mit der monotonen Uhr) höchstens so viele Sekunden
zurück, ist das Ergebnis `ok`. Der Wert bleibt der echte Zustand, der Grund lautet
`controlled restart tolerated (<zustand>, <N> s)`. Nach Ablauf der Karenzzeit gilt die
Bewertung von oben — ein dauerhaftes `systemctl stop` ist also nach der Karenzzeit ein Befund.
Nie toleriert: `failed`, `Result` ungleich `success` (`exit-code`, `signal`, `core-dump`,
`oom-kill`, `timeout`, `watchdog` …) und `auto-restart`. Fehlt `Result` oder der Zeitstempel,
ist er `0`, unlesbar oder liegt in der Zukunft, gibt es keine Toleranz, sondern die bisherige
Bewertung.

In der Praxis greift die Toleranz beim echten Neustart (`systemctl restart`: `deactivating`,
dann `activating`). Nach einem `systemctl stop` ohne gleich folgenden Start räumt systemd eine
Unit, auf die nichts mehr verweist, meist aus dem Speicher; die nächste Abfrage lädt sie neu mit
`StateChangeTimestampMonotonic=0` und dem Vorgabewert `Result=success`. Dieser Fall ist nicht
messbar und bekommt deshalb die bisherige Bewertung — ein Stopp mit Pause vor dem Start ist ein
Befund, auch innerhalb der Karenzzeit.

Grenzen: Skopos erkennt keine Absicht, nur Zustände; auch ein Stopp durch ein fremdes Werkzeug
mit `Result=success` wird toleriert. systemd setzt `Result` beim nächsten Start zurück: Ein
Dienst, der nach einem Absturz per `Restart=` gerade wieder `activating` ist, sieht innerhalb
der Karenzzeit wie ein sauberer Start aus. Ein einzelner Absturz mit schnellem Wiederanlauf
fällt deshalb hier nicht auf, eine Absturzschleife wegen des `auto-restart`-Zustands meist
schon; die Fehlermeldungen dazu erfasst der Check `journal`. Die Karenzzeit sollte knapp über
der längsten normalen Stopp- plus Startdauer liegen, nicht darüber hinaus.

## mount

Je Eintrag in `paths` (Pflicht, absolute Pfade in Normalform wie bei `disk`; `/mnt/x/` würde
nie als Mountpoint erkannt und ergäbe einen Dauer-Fehlalarm, deshalb lehnt die Config ihn ab): erst muss der Pfad in `/proc/self/mountinfo` als Mountpoint
stehen (sonst `crit`, `not mounted`), dann muss sein Verzeichnis innerhalb von
`read_timeout_seconds` (Vorgabe 5) lesbar sein.

Der Lesetest läuft in einem **Kindprozess**, der bei Zeitüberschreitung oder Abbruch des Checks
`SIGKILL` bekommt. Ein hängender Netzwerk-/FUSE-Mount blockiert den Systemaufruf im Kernel; im
Skopos-Prozess selbst würde das einen libuv-Thread dauerhaft belegen. Ergebnis beim Hängen:
`crit`, `mount does not respond`. Alle Pfade werden parallel geprüft, damit ein hängender Mount
die anderen nicht aufhält. Die Zeitgrenze des Checks (`timeout_seconds`, Vorgabe 30) muss über
`read_timeout_seconds` liegen.

## Fachliche Checks: sqlite-query und json-file

Zwei generische Checks für Kennzahlen, die eine andere Software lokal ablegt. Was gemessen wird,
steht ausschließlich in der Config des Hosts (Datenbank, Abfrage, Feld, Schwellen), nie im Code.
Beispiele: `config/example.json`. Beide sind nur lesend und machen keine Netzwerkzugriffe.

### sqlite-query

Führt **eine** SQL-Abfrage gegen eine fremde SQLite-DB aus und bewertet die eine Zahl, die sie
liefert. Ein Eintrag, ein Wert; mehrere Kennzahlen sind mehrere Einträge. Der Wert wird ohne
Teilschlüssel unter `<instanz>` gespeichert.

Parameter: `database` (Pflicht, absoluter Pfad), `query` (Pflicht), `column`, `null_as`, `unit`,
`delta`, `on_decrease` (Pflicht bei `delta`) und die Schwellen `warn_above`, `crit_above`, `warn_below`, `crit_below` (`≥` bzw. `≤`,
ist beides gesetzt, gilt das Schlimmere).

**Nur lesend, zweifach gesichert:**
1. Die Abfrage muss genau eine `SELECT`- oder `WITH`-Anweisung sein. Weitere Anweisungen, auch
   hinter einem Semikolon, lehnt schon die Config ab (Semikolons in Zeichenketten und
   Kommentaren sind erlaubt). `prepare()` würde Folge-Anweisungen still ignorieren, deshalb prüft
   Skopos den Text selbst.
2. Die Verbindung ist schreibgeschützt (Entscheidung 5, Öffnungsfunktion `lib/sqlite-read.js`):
   existiert `<db>-wal`, normales `readOnly`, sonst `file:<pfad>?mode=ro&immutable=1`. Ein
   `WITH … DELETE`, das die Textprüfung passiert, scheitert dort; die Datei bleibt
   byte-identisch. Fremde Verbindungen bekommen einen `busy_timeout` von 5 Sekunden.

`immutable=1` nimmt keine Sperren. Beginnt der Eigentümer genau während des Lesens zu schreiben,
könnte der Lesevorgang zerreißen. Skopos vergleicht deshalb Inode, Größe, Änderungszeit und
`-wal`-Existenz vor und nach dem Lesen; bei einer Änderung liest es einmal neu, danach ist das
Ergebnis `unknown` (`database changed while it was being read`), nie ein Wert aus einer
bewegten Datei.

**Ergebnisform:** genau eine Zeile mit genau einer Spalte (oder der Spalte `column`). Keine Zeile,
mehrere Zeilen, mehrere Spalten ohne `column`, Text oder BLOB statt einer Zahl: `unknown` mit
Grund. `NULL` ist `unknown`, **außer** die Config sagt ausdrücklich `null_as: 0` (z. B. für
`SUM` über einen Tag ohne Zeilen); der Grund nennt das dann. Fehlende Datei, fehlende
Leserechte (`no read permission`), fehlende Tabelle oder Spalte, keine gültige DB: `unknown`
mit Grund. Die Abfrage läuft synchron im Skopos-Prozess und lässt sich nicht unterbrechen; sie
muss billig sein (Index, kleine Tabelle).

**`delta: true`** bewertet den Zuwachs eines Zählers seit dem letzten Lauf statt seines Werts.
Der Wasserstand ist der letzte gelesene Wert (`ctx.state`). Lauf 1 hat keine Basis und ist
`unknown` (`no baseline yet`), Lauf 2 liefert den Zuwachs. Was ein **fallender** Wert bedeutet,
hängt vom Zähler ab; deshalb verlangt `delta` die Angabe `on_decrease`:

- `"restart"` — der Zähler beginnt wirklich neu (z. B. eine Tageszählung): gezählt wird alles
  seit dem Neubeginn, nie ein negativer Wert; der Grund nennt ihn. Zuwächse zwischen dem
  letzten Lauf davor und dem Neubeginn sind nicht sichtbar.
- `"rebase"` — der Wert darf eigentlich nie fallen (z. B. eine Summe über alle Zeilen). Fällt
  er doch, wurden Zeilen gelöscht oder aus einer Sicherung zurückgespielt. Der neue Wert wird
  zur Basis, der Lauf ist einmal `unknown` mit Grund. Mit `"restart"` würde hier die ganze
  verbliebene Summe als neuer Zuwachs gemeldet — ein falscher `crit`.

Empfohlen ist eine Summe über alle Zeilen mit `"rebase"`: Sie fällt nicht von selbst zurück,
und ein Tageswechsel verdeckt nichts. Ist die DB in einem Lauf nicht
lesbar, bleibt der Wasserstand stehen; der nächste Erfolg zählt ab dem letzten erfolgreichen
Lesen.

### json-file

Liest eine lokale JSON-Datei (höchstens 1 MiB) und bewertet ein Feld und das Dateialter.
Schlüssel: `value` (das Feld, nur mit `field`) und `age` (Sekunden seit der `mtime`).

Parameter: `file` (Pflicht, absoluter Pfad), `field` (Punktpfad, z. B. `result.status` oder
`items.0.count`; nur eigene Eigenschaften), `expected` (Zeichenkette, Zahl oder Boolean; Abweichung
ergibt `severity`, Vorgabe `crit`), alternativ die numerischen Schwellen wie bei `sqlite-query`,
`unit`, `warn_age_seconds`, `crit_age_seconds`.

Feldwerte sind Zeichenketten, Zahlen oder Booleans (als Text `true`/`false` gespeichert);
`expected` vergleicht strikt, ohne Umwandlung (`5` ist nicht `"5"`). Fehlende Datei,
fehlende Leserechte, ungültiges oder halb geschriebenes JSON, fehlendes Feld, Objekt/Liste/`null`
als Feldwert oder Text bei numerischen Schwellen: `unknown` mit Grund, nie eine Null. Kann die
Datei nicht gelesen werden, sind beide Schlüssel `unknown`; ist nur das JSON kaputt, wird das Alter
trotzdem gemessen. Liegt die `mtime` mehr als eine Minute in der Zukunft, ist das Alter `unknown`
(Uhrenfehler), darunter gilt 0.
