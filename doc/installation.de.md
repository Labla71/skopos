# Skopos — Installation, Update, Deinstallation

Wie Skopos auf einen Zielhost kommt und wieder verschwindet. Das „Warum“ steht in
[decisions.de.md](decisions.de.md) (Nr. 7 Systemnutzer und Härtung, Nr. 8 Verteilung).
English: [installation.md](installation.md).

## Voraussetzungen

- Linux mit systemd und der Gruppe `systemd-journal`
- Node.js ≥ 22.13 (`node:sqlite` ohne Schalter), keine weiteren Pakete, kein `npm ci`
- root-Rechte für die Installation

## Installation

Der Installer läuft **lokal auf dem Zielhost**, aus einem entpackten Quellbaum (Git-Checkout,
`git archive`, Release-Archiv):

```bash
sudo bin/install.sh --config <datei>          # Config aus einer Datei
sudo bin/install.sh --config - < <datei>      # Config über stdin
```

Weitere Schalter: `--version <kennung>` schreibt die Kennung (z. B. Commit) nach
`/opt/skopos/VERSION`, sie erscheint im Heartbeat; fehlt der Schalter, übernimmt der
Installer eine `VERSION`-Datei aus dem Quellbaum. `--node <pfad>` wählt ein bestimmtes
Node-Binary, sonst das erste im `PATH`.

Der Installer prüft **zuerst alle Voraussetzungen** und ändert erst danach etwas: root,
systemd, Gruppe `systemd-journal`, Node-Version, und die Config mit genau dem Prüfer, den
auch ein Lauf verwendet. Scheitert eine Prüfung, bricht er mit Meldung ab, ohne etwas
anzulegen.

Danach legt er an:

| Was | Wo | Eigentümer, Rechte |
|---|---|---|
| Code und Doku (`bin`, `lib`, `systemd`, `doc`, `package.json`, `VERSION`) | `/opt/skopos` | `root`, `0755`/`0644` |
| Config | `/etc/skopos/config.json` | `root:skopos`, `0640` |
| Daten (DB `skopos.db`, `0644`) | `/var/lib/skopos` | `skopos:skopos`, `0755` |
| Units | `/etc/systemd/system/skopos.service`, `skopos.timer` | `root`, `0644` |
| Systemnutzer | `skopos`, ohne Login-Shell, Zusatzgruppe `systemd-journal` | — |

Der Code wird neben `/opt/skopos` vorbereitet und dann ausgetauscht; ein abgebrochener
Kopiervorgang lässt den alten Stand stehen. Zum Schluss `systemctl enable --now skopos.timer`.

Der Timer folgt `interval_minutes` aus der Config: Teilt der Wert die Stunde (5, 10, 15 …),
`OnCalendar=*:0/<n>`, sonst `OnBootSec`/`OnUnitActiveSec`. `ExecStart` enthält den
absoluten Node-Pfad, der bei der Installation geprüft wurde.

Die Unit läuft als `skopos` mit `ProtectSystem=strict`, `ReadWritePaths=/var/lib/skopos`,
`ProtectHome=read-only`, `PrivateTmp=yes`, `NoNewPrivileges=yes` und `UMask=0022`: Schreiben
außerhalb von `/var/lib/skopos` scheitert am Kernel (`EROFS`), nicht an der Disziplin des Codes.
Dazu `ProtectKernelTunables`, `ProtectControlGroups`, `RestrictSUIDSGID` und `PrivateDevices`.

`PrivateNetwork=yes` nimmt dem Lauf jedes Netz: „Pull, kein Push“ ist damit ebenfalls vom
Kernel erzwungen. `systemctl` und `journalctl` arbeiten weiter, weil sie Unix-Sockets und
Dateien im Dateisystem nutzen. `MemoryMax=200M` und `CPUQuota=50%` schützen den überwachten
Host vor einem fehlerhaften Check (ein normaler Lauf braucht rund 55 MB). Wird das Limit
erreicht, endet der Lauf; das zeigt sich als fehlender Heartbeat und im nächsten Lauf als
OOM-Kill. `systemd-analyze security` bewertet die Unit mit 6,8 („MEDIUM“), ohne diese
Ergänzungen 8,4.

## Update

Derselbe Befehl. Ohne `--config` bleibt die installierte Config erhalten:

```bash
sudo bin/install.sh --version <kennung>
sudo /opt/skopos/bin/install.sh              # aus dem installierten Stand, z. B. nach Node-Wechsel
```

Die DB bleibt immer erhalten; eine ältere Schemaversion migriert der nächste Lauf. Der
Installer ist wiederholbar: Zweimal hintereinander ergibt dieselbe Endlage.

## Prüfen

```bash
systemctl is-active skopos.timer
systemctl list-timers skopos.timer
journalctl -u skopos.service -n 20
/opt/skopos/bin/skopos.js report --json       # als beliebiger Nutzer, ohne sudo
```

Jeder Lauf schreibt eine Zeile ins Journal, z. B.
`run 12: ok=25 warn=0 crit=0 unknown=0 (120 ms, peak rss 60.2 MB)` — Dauer und Spitzen-RSS
des Laufs. `systemctl show -p MemoryPeak` taugt dafür nicht: systemd behält den Wert einer
beendeten oneshot-Unit nicht.

## Sammler einrichten

Nur auf dem einen Host, der die anderen abholt ([collector.de.md](collector.de.md)). Skopos ist dort
wie oben installiert; der Sammler läuft als normaler Nutzer mit SSH-Zugang zu den Hosts (im
Beispiel `monitor`), als systemd-User-Unit. Linger sorgt dafür, dass sie ohne Anmeldung läuft.

```bash
sudo install -d -o monitor -g skopos -m 2750 /var/lib/skopos-collect
sudo loginctl enable-linger monitor
# als monitor:
mkdir -p ~/.config/skopos ~/.config/systemd/user
cp /pfad/zur/collect.json ~/.config/skopos/collect.json
cp /opt/skopos/systemd/user/skopos-collect.* ~/.config/systemd/user/
systemctl --user daemon-reload
/opt/skopos/bin/skopos.js collect --config ~/.config/skopos/collect.json
systemctl --user enable --now skopos-collect.timer
```

Das Zustandsverzeichnis gehört dem Sammler-Nutzer, hat die Gruppe `skopos` und das
setgid-Bit: Die Zustandsdatei (0640) erbt die Gruppe, und der Messdienst kann ihr Alter mit
einem `json-file`-Check prüfen (`warn_age_seconds`/`crit_age_seconds`). Ein Update von
Skopos aktualisiert den Sammler mit; die Units werden danach erneut kopiert, falls sie sich
geändert haben.

## Deinstallation

Entfernt alles, was der Installer angelegt hat. Die Messdaten gehen dabei verloren; wer sie
behalten will, sichert vorher `/var/lib/skopos/skopos.db`.

```bash
sudo systemctl disable --now skopos.timer
sudo systemctl stop skopos.service
sudo rm -f /etc/systemd/system/skopos.service /etc/systemd/system/skopos.timer
sudo systemctl daemon-reload
sudo rm -rf /opt/skopos /etc/skopos /var/lib/skopos
sudo userdel skopos
```

`userdel` entfernt auch die gleichnamige Gruppe, sofern sie leer ist. Skopos hat außerhalb
dieser Pfade nichts verändert.

## Probelauf ohne root

Für Tests schreibt `--destdir <verzeichnis>` dieselben Dateien unterhalb des Verzeichnisses,
ohne Nutzer, ohne `chown` und ohne systemd (`test/install.test.js`):

```bash
bin/install.sh --destdir /tmp/skopos-stage --config config/example.json
```
