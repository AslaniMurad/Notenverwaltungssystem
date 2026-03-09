# Admin Functions

Diese Datei dokumentiert die aktuell im Projekt vorhandenen Admin-Funktionen fuer GitHub.
Grundlage sind die implementierten Routen in `school-login/routes/admin.js` sowie die
Admin-Unterrichtszuordnungen in `school-login/routes/assignmentRoutes.js`.

## Ziel des Admin-Bereichs

Der Admin-Bereich dient zur zentralen Verwaltung von:

- Benutzern
- Klassen
- Schueler-Zuordnungen zu Klassen
- Lehrer-Zuordnungen zu Klassen und Faechern
- Audit-Logs

Der Zugriff ist nur fuer eingeloggte Benutzer mit der Rolle `admin` erlaubt.

## 1. Dashboard

Route: `GET /admin`

Funktionen:

- Zeigt Kennzahlen fuer Benutzer, Klassen und Schueler.
- Nutzt die aktuellen Datenbankzaehler als Schnellueberblick.
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
- Rollenwahl fuer `admin`, `teacher` und `student`.
- Passwortvalidierung ueber die zentrale Passwortregel.
- Optionales Initial-Passwort ueber `INITIAL_PASSWORD` aus der Umgebung.
- Initial-Passwort ist fuer Lehrer explizit gesperrt.
- Bei Initial-Passwort wird `must_change_password` aktiviert.
- Schutz gegen doppelte E-Mail-Adressen.

### 2.3 Benutzer in Bulk anlegen

Route: `POST /admin/users/bulk`

Funktionen:

- Erstellt mehrere Benutzer ueber eine E-Mail-Liste.
- Eine E-Mail pro Zeile.
- Gemeinsame Zielrolle fuer alle Eintraege.
- Gemeinsames Passwort oder Initial-Passwort aus ENV.
- Ergebnisanzeige mit erfolgreich angelegten und fehlgeschlagenen Konten.
- Lehrer duerfen auch im Bulk kein Initial-Passwort erhalten.

### 2.4 Benutzerdetails anzeigen

Route: `GET /admin/users/:id`

Funktionen:

- Zeigt Stammdaten des ausgewaehlten Benutzers.
- Fuer Lehrer:
  Zeigt zugeordnete Klassen/Faecher aus `class_subject_teacher`.
- Fuer Schueler:
  Zeigt alle Klassen, in denen dieselbe E-Mail als Schueler eingetragen ist.
  Zusaetzlich werden die zugehoerigen Lehrer-E-Mails angezeigt.

### 2.5 Benutzer bearbeiten

Route: `GET /admin/users/:id/edit`
Route: `POST /admin/users/:id`

Funktionen:

- Aendert E-Mail, Rolle und Status eines Benutzers.
- Validiert Pflichtfelder.
- Verhindert doppelte E-Mail-Adressen.

### 2.6 Passwort zuruecksetzen

Route: `POST /admin/users/:id/reset`

Funktionen:

- Setzt ein individuelles neues Passwort.
- Optional Ruecksetzen auf `INITIAL_PASSWORD`.
- Bei Initial-Passwort wird `must_change_password` gesetzt.
- Bei individuellem Passwort bleibt `must_change_password` deaktiviert.

### 2.7 Benutzer loeschen

Route: `POST /admin/users/:id/delete`

Funktionen:

- Fuehrt kein hartes Delete aus.
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

- Aendert Klassenname und Fach.
- Aktualisiert auch die technische `subject_id`.
- Validiert Pflichtfelder und Fachauflosung.

### 3.4 Klasse loeschen

Route: `POST /admin/classes/:id/delete`

Funktionen:

- Loescht zuerst alle Schueler-Zuordnungen dieser Klasse.
- Loescht danach die Klasse selbst.
- Das ist ein hartes Delete auf Klassenebene.

## 4. Schuelerverwaltung pro Klasse

### 4.1 Schueler einer Klasse anzeigen

Route: `GET /admin/classes/:id/students`

Funktionen:

- Zeigt alle Schueler einer bestimmten Klasse.
- Filter nach Schuelername.
- Filter nach E-Mail.
- Zeigt im Kopf auch die zugeordneten Lehrer-E-Mails der Klasse.

### 4.2 Einzelnen Schueler zu einer Klasse hinzufuegen

Route: `GET /admin/classes/:id/students/add`
Route: `POST /admin/classes/:id/students/add`

Funktionen:

- Verknuepft einen vorhandenen Student-User mit einer Klasse.
- Akzeptiert Name und E-Mail.
- Wenn kein Name angegeben wird, wird er aus der E-Mail abgeleitet.
- Verlangt, dass zur E-Mail bereits ein Benutzer mit Rolle `student` existiert.
- Verhindert doppelte Eintraege derselben E-Mail in derselben Klasse.

### 4.3 Mehrere Schueler per Bulk zu einer Klasse hinzufuegen

Route: `POST /admin/classes/:id/students/add-bulk`

Funktionen:

- Verarbeitet mehrere E-Mails in einem Schritt.
- Eine E-Mail pro Zeile.
- Leitet den Anzeigenamen automatisch aus der E-Mail ab.
- Prueft pro Eintrag:
  vorhandener Student-User,
  gueltiger Name,
  keine doppelte Klassen-Zuordnung.
- Zeigt ein Bulk-Ergebnis mit Erfolg und Fehlern.

### 4.4 Schueler aus einer Klasse entfernen

Route: `POST /admin/classes/:classId/students/:studentId/delete`

Funktionen:

- Entfernt einen Schueler aus genau dieser Klasse.
- Loescht vorher die `grade_notifications` fuer diesen Schueler-Datensatz.

## 5. Unterrichtszuordnung

Technisch umgesetzt ueber:

- `GET /admin/assignments`
- `GET /admin/assignments/new`
- `POST /admin/assignments`
- `POST /admin/assignments/delete`

Beschreibung:

- Verwaltet Lehrer-Zuordnungen zu Klassen und Faechern.
- Die Daten liegen in `class_subject_teacher`.
- Die Uebersicht gruppiert nach Klasse und Fach.
- Innerhalb einer Gruppe koennen mehrere Lehrer zugeordnet sein.

### 5.1 Zuordnungen anzeigen

Route: `GET /admin/assignments`

Funktionen:

- Zeigt alle vorhandenen Unterrichtszuordnungen gruppiert an.
- Eine Gruppe repraesentiert eine Kombination aus Klasse und Fach.
- Innerhalb der Gruppe werden einzelne Lehrer-Zuordnungen angezeigt.

### 5.2 Neue Zuordnung erstellen

Route: `GET /admin/assignments/new`
Route: `POST /admin/assignments`

Funktionen:

- Auswahl von Klasse, Fach und einem oder mehreren Lehrern.
- Validiert, dass das gewaehlt Fach zur Klasse passt.
- Validiert, dass die Lehrer-IDs gueltig sind.
- Legt mehrere Zuordnungen in einem Schritt an.
- Meldet, wie viele Eintraege neu erstellt wurden und wie viele schon existierten.

### 5.3 Zuordnung entfernen

Route: `POST /admin/assignments/delete`

Funktionen:

- Entfernt eine einzelne Lehrer-Zuordnung ueber ihre `assignment_id`.

## 6. Audit-Log

### 6.1 Audit-Log anzeigen

Route: `GET /admin/audit-logs`

Funktionen:

- Zeigt die letzten Audit-Eintraege.
- Filter nach ausfuehrendem Benutzer (`actor`).
- Filter nach Aktion (`action`).
- Filter nach Entitaet (`entity`).
- Zeigt Gesamtanzahl passender Eintraege.

### 6.2 Audit-Log Daten nachladen

Route: `GET /admin/audit-logs/data`

Funktionen:

- JSON-Endpunkt fuer inkrementelles Nachladen.
- Unterstuetzt `beforeId`, `afterId` und `limit`.
- Begrenzt `limit` technisch auf maximal 200.
- Liefert `hasMore`, `oldestId` und `totalCount`.

## 7. Sicherheits- und Validierungslogik

Der Admin-Bereich enthaelt zusaetzlich folgende Querschnittsfunktionen:

- Rollenbasierter Zugriffsschutz ueber `requireAuth` und `requireRole("admin")`
- CSRF-Schutz fuer Formulare und Admin-Aktionen
- Audit-Middleware fuer Admin-Routen
- Passwortvalidierung ueber `getPasswordValidationError`
- Eindeutigkeitspruefungen fuer E-Mail-Adressen
- Schutz gegen doppelte Schueler- und Lehrer-Zuordnungen

## 8. Kurzuebersicht der wichtigsten Admin-Routen

| Bereich | Route | Methode | Zweck |
| --- | --- | --- | --- |
| Dashboard | `/admin` | `GET` | Admin-Startseite mit Kennzahlen |
| Benutzer | `/admin/users` | `GET` | Benutzerliste mit Filtern |
| Benutzer | `/admin/users` | `POST` | Einzelnen Benutzer anlegen |
| Benutzer | `/admin/users/bulk` | `POST` | Mehrere Benutzer anlegen |
| Benutzer | `/admin/users/:id` | `GET` | Benutzerdetails |
| Benutzer | `/admin/users/:id` | `POST` | Benutzer aktualisieren |
| Benutzer | `/admin/users/:id/reset` | `POST` | Passwort zuruecksetzen |
| Benutzer | `/admin/users/:id/delete` | `POST` | Benutzer soft-loeschen |
| Klassen | `/admin/classes` | `GET` | Klassenliste |
| Klassen | `/admin/classes` | `POST` | Klasse anlegen |
| Klassen | `/admin/classes/:id` | `POST` | Klasse aktualisieren |
| Klassen | `/admin/classes/:id/delete` | `POST` | Klasse loeschen |
| Klassen-Schueler | `/admin/classes/:id/students` | `GET` | Schueler pro Klasse |
| Klassen-Schueler | `/admin/classes/:id/students/add` | `POST` | Schueler einzeln hinzufuegen |
| Klassen-Schueler | `/admin/classes/:id/students/add-bulk` | `POST` | Schueler in Bulk hinzufuegen |
| Klassen-Schueler | `/admin/classes/:classId/students/:studentId/delete` | `POST` | Schueler aus Klasse entfernen |
| Zuordnungen | `/admin/assignments` | `GET` | Lehrer-Zuordnungen anzeigen |
| Zuordnungen | `/admin/assignments` | `POST` | Lehrer-Zuordnungen anlegen |
| Zuordnungen | `/admin/assignments/delete` | `POST` | Lehrer-Zuordnung entfernen |
| Audit | `/admin/audit-logs` | `GET` | Audit-Log Seite |
| Audit | `/admin/audit-logs/data` | `GET` | Audit-Log JSON Feed |

## 9. Hinweise fuer GitHub-Reader

- Benutzerkonten und Klassen werden direkt ueber den Admin-Bereich gepflegt.
- Schueler koennen in mehreren Klassen eingetragen sein.
- Lehrer-Zuordnungen laufen nicht ueber die Klassenmaske selbst, sondern ueber den separaten Bereich `Unterrichtszuordnung`.
- Das Passwortverhalten haengt teilweise von der ENV-Variable `INITIAL_PASSWORD` ab.
- Audit-Logs sind ein eigener, filterbarer Bereich fuer Nachvollziehbarkeit.
