# Admin Functions

Diese Datei dokumentiert die aktuell im Projekt vorhandenen Admin-Funktionen für GitHub.
Grundlage sind die implementierten Routen in `school-login/routes/admin.js` sowie die
Admin-Unterrichtszuordnungen in `school-login/routes/assignmentRoutes.js`.

## Ziel des Admin-Bereichs

Der Admin-Bereich dient zur zentralen Verwaltung von:

- Benutzern
- Klassen
- Schüler-Zuordnungen zu Klassen
- Lehrer-Zuordnungen zu Klassen und Fächern
- Audit-Logs

Der Zugriff ist nur für eingeloggte Benutzer mit der Rolle `admin` erlaubt.

## 1. Dashboard

Route: `GET /admin`

Funktionen:

- Zeigt Kennzahlen für Benutzer, Klassen und Schüler.
- Nutzt die aktuellen Datenbankzähler als Schnellüberblick.
- Dient als Einstiegspunkt in die Administration.

## 2. Benutzerverwaltung

### 2.1 Benutzerliste

Route: `GET /admin/users`

Funktionen:

- Listet alle Benutzer absteigend nach ID.
- Filter nach Benutzer-ID.
- Filter nach E-Mail.
- Filter nach Rolle (`admin`, `teacher`, `student`).
- Zeigt Status und Kennzeichen `must_change_password`.

### 2.2 Einzelnen Benutzer anlegen

Route: `GET /admin/users/new`
Route: `POST /admin/users`

Funktionen:

- Erstellt einzelne Benutzerkonten.
- Rollenwahl für `admin`, `teacher` und `student`.
- Passwortvalidierung über die zentrale Passwortregel.
- Optionales Initial-Passwort über `INITIAL_PASSWORD` aus der Umgebung.
- Initial-Passwort ist für Lehrer explizit gesperrt.
- Bei Initial-Passwort wird `must_change_password` aktiviert.
- Schutz gegen doppelte E-Mail-Adressen.

### 2.3 Benutzer in Bulk anlegen

Route: `POST /admin/users/bulk`

Funktionen:

- Erstellt mehrere Benutzer über eine E-Mail-Liste.
- Eine E-Mail pro Zeile.
- Gemeinsame Zielrolle für alle Einträge.
- Gemeinsames Passwort oder Initial-Passwort aus ENV.
- Ergebnisanzeige mit erfolgreich angelegten und fehlgeschlagenen Konten.
- Lehrer dürfen auch im Bulk kein Initial-Passwort erhalten.

### 2.4 Benutzerdetails anzeigen

Route: `GET /admin/users/:id`

Funktionen:

- Zeigt Stammdaten des ausgewählten Benutzers.
- Für Lehrer:
  Zeigt zugeordnete Klassen/Fächer aus `class_subject_teacher`.
- Für Schüler:
  Zeigt alle Klassen, in denen dieselbe E-Mail als Schüler eingetragen ist.
  Zusätzlich werden die zugehörigen Lehrer-E-Mails angezeigt.

### 2.5 Benutzer bearbeiten

Route: `GET /admin/users/:id/edit`
Route: `POST /admin/users/:id`

Funktionen:

- Ändert E-Mail, Rolle und Status eines Benutzers.
- Validiert Pflichtfelder.
- Verhindert doppelte E-Mail-Adressen.

### 2.6 Passwort zurücksetzen

Route: `POST /admin/users/:id/reset`

Funktionen:

- Setzt ein individuelles neues Passwort.
- Optional Rücksetzen auf `INITIAL_PASSWORD`.
- Bei Initial-Passwort wird `must_change_password` gesetzt.
- Bei individuellem Passwort bleibt `must_change_password` deaktiviert.

### 2.7 Benutzer löschen

Route: `POST /admin/users/:id/delete`

Funktionen:

- Führt kein hartes Delete aus.
- Setzt den Benutzerstatus auf `deleted`.
- Konto bleibt historisch erhalten.

## 3. Klassenverwaltung

### 3.1 Klassenliste

Route: `GET /admin/classes`

Funktionen:

- Listet alle Klassen.
- Suche nach Klassenname.
- Suche nach Fach.
- Suche nach zugeordneten Lehrer-E-Mails.
- Zeigt Lehreranzahl pro Klassen-Fach-Kombination.

### 3.2 Klasse anlegen

Route: `GET /admin/classes/new`
Route: `POST /admin/classes`

Funktionen:

- Erstellt eine neue Klasse.
- Erwartet Klassenname und Fach.
- Erzeugt oder ermittelt die passende `subject_id`.
- Speichert `name`, `subject` und `subject_id`.

### 3.3 Klasse bearbeiten

Route: `GET /admin/classes/:id/edit`
Route: `POST /admin/classes/:id`

Funktionen:

- Ändert Klassenname und Fach.
- Aktualisiert auch die technische `subject_id`.
- Validiert Pflichtfelder und Fachauflösung.

### 3.4 Klasse löschen

Route: `POST /admin/classes/:id/delete`

Funktionen:

- Löscht zuerst alle Schüler-Zuordnungen dieser Klasse.
- Löscht danach die Klasse selbst.
- Das ist ein hartes Delete auf Klassenebene.

## 4. Schülerverwaltung pro Klasse

### 4.1 Schüler einer Klasse anzeigen

Route: `GET /admin/classes/:id/students`

Funktionen:

- Zeigt alle Schüler einer bestimmten Klasse.
- Filter nach Schülername.
- Filter nach E-Mail.
- Zeigt im Kopf auch die zugeordneten Lehrer-E-Mails der Klasse.

### 4.2 Einzelnen Schüler zu einer Klasse hinzufügen

Route: `GET /admin/classes/:id/students/add`
Route: `POST /admin/classes/:id/students/add`

Funktionen:

- Verknüpft einen vorhandenen Student-User mit einer Klasse.
- Akzeptiert Name und E-Mail.
- Wenn kein Name angegeben wird, wird er aus der E-Mail abgeleitet.
- Verlangt, dass zur E-Mail bereits ein Benutzer mit Rolle `student` existiert.
- Verhindert doppelte Einträge derselben E-Mail in derselben Klasse.

### 4.3 Mehrere Schüler per Bulk zu einer Klasse hinzufügen

Route: `POST /admin/classes/:id/students/add-bulk`

Funktionen:

- Verarbeitet mehrere E-Mails in einem Schritt.
- Eine E-Mail pro Zeile.
- Leitet den Anzeigenamen automatisch aus der E-Mail ab.
- Prüft pro Eintrag:
  vorhandener Student-User,
  gültiger Name,
  keine doppelte Klassen-Zuordnung.
- Zeigt ein Bulk-Ergebnis mit Erfolg und Fehlern.

### 4.4 Schüler aus einer Klasse entfernen

Route: `POST /admin/classes/:classId/students/:studentId/delete`

Funktionen:

- Entfernt einen Schüler aus genau dieser Klasse.
- Löscht vorher die `grade_notifications` für diesen Schüler-Datensatz.

## 5. Unterrichtszuordnung

Technisch umgesetzt über:

- `GET /admin/assignments`
- `GET /admin/assignments/new`
- `POST /admin/assignments`
- `POST /admin/assignments/delete`

Beschreibung:

- Verwaltet Lehrer-Zuordnungen zu Klassen und Fächern.
- Die Daten liegen in `class_subject_teacher`.
- Die Übersicht gruppiert nach Klasse und Fach.
- Innerhalb einer Gruppe können mehrere Lehrer zugeordnet sein.

### 5.1 Zuordnungen anzeigen

Route: `GET /admin/assignments`

Funktionen:

- Zeigt alle vorhandenen Unterrichtszuordnungen gruppiert an.
- Eine Gruppe repräsentiert eine Kombination aus Klasse und Fach.
- Innerhalb der Gruppe werden einzelne Lehrer-Zuordnungen angezeigt.

### 5.2 Neue Zuordnung erstellen

Route: `GET /admin/assignments/new`
Route: `POST /admin/assignments`

Funktionen:

- Auswahl von Klasse, Fach und einem oder mehreren Lehrern.
- Validiert, dass das gewählte Fach zur Klasse passt.
- Validiert, dass die Lehrer-IDs gültig sind.
- Legt mehrere Zuordnungen in einem Schritt an.
- Meldet, wie viele Einträge neu erstellt wurden und wie viele schon existierten.

### 5.3 Zuordnung entfernen

Route: `POST /admin/assignments/delete`

Funktionen:

- Entfernt eine einzelne Lehrer-Zuordnung über ihre `assignment_id`.

## 6. Audit-Log

### 6.1 Audit-Log anzeigen

Route: `GET /admin/audit-logs`

Funktionen:

- Zeigt die letzten Audit-Einträge.
- Filter nach ausführendem Benutzer (`actor`).
- Filter nach Aktion (`action`).
- Filter nach Entität (`entity`).
- Zeigt Gesamtanzahl passender Einträge.

### 6.2 Audit-Log Daten nachladen

Route: `GET /admin/audit-logs/data`

Funktionen:

- JSON-Endpunkt für inkrementelles Nachladen.
- Unterstützt `beforeId`, `afterId` und `limit`.
- Begrenzt `limit` technisch auf maximal 200.
- Liefert `hasMore`, `oldestId` und `totalCount`.

## 7. Sicherheits- und Validierungslogik

Der Admin-Bereich enthält zusätzlich folgende Querschnittsfunktionen:

- Rollenbasierter Zugriffsschutz über `requireAuth` und `requireRole("admin")`
- CSRF-Schutz für Formulare und Admin-Aktionen
- Audit-Middleware für Admin-Routen
- Passwortvalidierung über `getPasswordValidationError`
- Eindeutigkeitsprüfungen für E-Mail-Adressen
- Schutz gegen doppelte Schüler- und Lehrer-Zuordnungen

## 8. Kurzübersicht der wichtigsten Admin-Routen

| Bereich | Route | Methode | Zweck |
| --- | --- | --- | --- |
| Dashboard | `/admin` | `GET` | Admin-Startseite mit Kennzahlen |
| Benutzer | `/admin/users` | `GET` | Benutzerliste mit Filtern |
| Benutzer | `/admin/users` | `POST` | Einzelnen Benutzer anlegen |
| Benutzer | `/admin/users/bulk` | `POST` | Mehrere Benutzer anlegen |
| Benutzer | `/admin/users/:id` | `GET` | Benutzerdetails |
| Benutzer | `/admin/users/:id` | `POST` | Benutzer aktualisieren |
| Benutzer | `/admin/users/:id/reset` | `POST` | Passwort zurücksetzen |
| Benutzer | `/admin/users/:id/delete` | `POST` | Benutzer soft-löschen |
| Klassen | `/admin/classes` | `GET` | Klassenliste |
| Klassen | `/admin/classes` | `POST` | Klasse anlegen |
| Klassen | `/admin/classes/:id` | `POST` | Klasse aktualisieren |
| Klassen | `/admin/classes/:id/delete` | `POST` | Klasse löschen |
| Klassen-Schüler | `/admin/classes/:id/students` | `GET` | Schüler pro Klasse |
| Klassen-Schüler | `/admin/classes/:id/students/add` | `POST` | Schüler einzeln hinzufügen |
| Klassen-Schüler | `/admin/classes/:id/students/add-bulk` | `POST` | Schüler in Bulk hinzufügen |
| Klassen-Schüler | `/admin/classes/:classId/students/:studentId/delete` | `POST` | Schüler aus Klasse entfernen |
| Zuordnungen | `/admin/assignments` | `GET` | Lehrer-Zuordnungen anzeigen |
| Zuordnungen | `/admin/assignments` | `POST` | Lehrer-Zuordnungen anlegen |
| Zuordnungen | `/admin/assignments/delete` | `POST` | Lehrer-Zuordnung entfernen |
| Audit | `/admin/audit-logs` | `GET` | Audit-Log Seite |
| Audit | `/admin/audit-logs/data` | `GET` | Audit-Log JSON Feed |

## 9. Hinweise für GitHub-Reader

- Benutzerkonten und Klassen werden direkt über den Admin-Bereich gepflegt.
- Schüler können in mehreren Klassen eingetragen sein.
- Lehrer-Zuordnungen laufen nicht über die Klassenmaske selbst, sondern über den separaten Bereich `Unterrichtszuordnung`.
- Das Passwortverhalten hängt teilweise von der ENV-Variable `INITIAL_PASSWORD` ab.
- Audit-Logs sind ein eigener, filterbarer Bereich für Nachvollziehbarkeit.
