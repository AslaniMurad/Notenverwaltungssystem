# Teacher Functions

Diese Datei dokumentiert die aktuell im Projekt vorhandenen Lehrer-Funktionen für GitHub.
Grundlage sind die implementierten Routen in `school-login/routes/teacher.js` sowie die
zugehörigen Lehrer-Ansichten in `school-login/views/teacher`.

## Ziel des Lehrer-Bereichs

Der Lehrer-Bereich dient zur fachlichen Arbeit mit zugewiesenen Klassen und umfasst:

- Klassenübersicht
- Bewertungsschemata und Profile
- Schülerverwaltung pro Klasse
- Notenverwaltung
- Prüfungsverwaltung
- Sonderleistungen
- Nachrichten zu Rückgaben
- Klassenstatistiken

Der Zugriff ist nur für eingeloggte Benutzer mit der Rolle `teacher` erlaubt.

## 1. Einstieg und Navigation

### 1.1 Lehrer-Start

Route: `GET /teacher`

Funktionen:

- Leitet automatisch zur zuletzt zugewiesenen Klasse weiter.
- Wenn noch keine Unterrichtszuordnung existiert, erfolgt die Weiterleitung auf die Klassenübersicht.

### 1.2 Klassenübersicht

Route: `GET /teacher/classes`

Funktionen:

- Zeigt alle dem Lehrer zugeordneten Klassen.
- Fasst pro Klasse mehrere zugeordnete Fächer zusammen.
- Suche nach Klassenname und Fach.
- Sortierung nach Erstellungsdatum, Klassenname und Fach.
- Zeigt, ob bereits ein aktives Bewertungsprofil vorhanden ist.

## 2. Klassenverwaltung

### 2.1 Klasse erstellen

Route: `GET /teacher/create-class`
Route: `POST /teacher/create-class`

Funktionen:

- Erstellt eine neue Klasse mit Name und Fach.
- Ermittelt automatisch die passende `subject_id`.
- Legt direkt auch die Lehrer-Zuordnung in `class_subject_teacher` an.

### 2.2 Klasse löschen

Route: `POST /teacher/delete-class/:id`

Funktionen:

- Löscht die Klasse, sofern der Lehrer Zugriff darauf hat.
- Löscht vorher alle Schüler-Zuordnungen dieser Klasse.

## 3. Bewertungseinstellungen und Profile

### 3.1 Einstellungen anzeigen

Route: `GET /teacher/settings`

Funktionen:

- Zeigt alle gespeicherten Bewertungsprofile des Lehrers.
- Zeigt das aktive Profil.
- Unterstützt Erstellen, Bearbeiten und Auswahl eines Profils.
- Führt neue Lehrer beim ersten Aufruf in den Setup-Flow.

### 3.2 Profil speichern

Route: `POST /teacher/settings/save-profile`

Funktionen:

- Erstellt neue Bewertungsprofile oder aktualisiert bestehende.
- Speichert:
  - Profilname
  - Scoring-Modus
  - Abwesenheitslogik
  - Notengrenzen in Prozent
  - Mitarbeit-Konfiguration
  - Gewichtungen je Kategorie
- Validiert:
  - Profilname
  - Gewichtungen
  - Notengrenzen
  - Mitarbeit-Konfiguration
- Setzt auf Wunsch das Profil als aktiv.
- Aktiviert automatisch ein Profil, wenn noch keines aktiv ist.

### 3.3 Profil aktivieren

Route: `POST /teacher/settings/activate-profile/:profileId`

Funktionen:

- Deaktiviert alle anderen Profile des Lehrers.
- Setzt das gewählte Profil als aktives Bewertungsprofil.

### 3.4 Profil löschen

Route: `POST /teacher/settings/delete-profile/:profileId`

Funktionen:

- Löscht ein vorhandenes Bewertungsprofil.
- Falls das aktive Profil gelöscht wird, wird automatisch ein Ersatzprofil aktiviert.

### 3.5 Inhalt eines Bewertungsprofils

Ein Lehrerprofil steuert insbesondere:

- Scoring-Modus:
  - Nur Noten
  - Nur Punkte
  - Punkte oder Noten
  - Punkte und Noten
- Abwesenheitsmodus:
  - Mit 0 % werten
  - Nicht gewichten
- Notenschwellen für automatische Notenberechnung aus Punkten
- Mitarbeit (MA):
  - Aktiv/Inaktiv
  - Gewichtung
  - Umrechnung von Symbolen in Notenwirkung
- Gewichtung von Kategorien wie:
  - Schularbeit
  - Test
  - Projekt
  - Hausübung
  - Mitarbeit
  - Wiederholung

## 4. Schülerverwaltung pro Klasse

### 4.1 Schülerliste anzeigen

Route: `GET /teacher/students/:classId`

Funktionen:

- Zeigt alle Schüler einer Klasse.
- Suche nach Name oder E-Mail.
- Sortierung nach Name oder E-Mail.
- Zeigt zusätzlich die Anzahl offener Nachrichten zu Rückgaben.

### 4.2 Schüler hinzufügen

Route: `GET /teacher/add-student/:classId`
Route: `POST /teacher/add-student/:classId`

Funktionen:

- Fügt einen vorhandenen Student-User zu einer Klasse hinzu.
- Optional automatische Namensableitung aus der E-Mail.
- Verhindert doppelte Klassenzuordnung derselben E-Mail.
- Verlangt, dass zur E-Mail bereits ein Benutzer mit Rolle `student` existiert.

### 4.3 Schüler entfernen

Route: `POST /teacher/delete-student/:classId/:studentId`

Funktionen:

- Entfernt einen Schüler aus genau dieser Klasse.

## 5. Nachrichten zu Tests und Rückgaben

### 5.1 Nachrichtenübersicht

Route: `GET /teacher/test-questions/:classId`

Funktionen:

- Zeigt alle Rückfragen von Schülern zu Bewertungen in einer Klasse.
- Gruppiert Nachrichten als Gesprächsverläufe.
- Zählt offene, noch nicht beantwortete Nachrichten.

### 5.2 Auf Nachrichten antworten

Route: `POST /teacher/students/:classId/messages/:messageId/reply`

Funktionen:

- Speichert Lehrerantworten auf Schülernachrichten.
- Validiert, dass die Nachricht zur Klasse und zum Lehrer gehört.
- Begrenzt Antworten auf 1000 Zeichen.
- Erzeugt eine Benachrichtigung für den Schüler nach einer Antwort.

## 6. Notenübersicht einer Klasse

### 6.1 Klassenweite Notenübersicht

Route: `GET /teacher/grades/:classId`

Funktionen:

- Zeigt alle Schüler einer Klasse mit Notenstatus.
- Berechnet pro Schüler:
  - Anzahl Bewertungen
  - Anzahl Mitarbeitseinträge
  - Durchschnittsnote
  - Punktesumme und Prozentwert, sofern möglich
- Filter:
  - Alle
  - Mit Noten
  - Ohne Noten
  - Unvollständig
- Sortierung:
  - Name
  - Durchschnitt beste/schlechteste
  - Anzahl Bewertungen
  - Punkte-Prozent

### 6.2 Mitarbeit eintragen

Route: `POST /teacher/grades/:classId/participation`

Funktionen:

- Erstellt Mitarbeitseinträge für einen Schüler.
- Verwendet das aktive Lehrerprofil zur Umrechnung von MA-Symbolen.
- Legt automatisch eine Schüler-Benachrichtigung an.
- Ist nur nutzbar, wenn Mitarbeit im Profil aktiviert ist.

### 6.3 Mitarbeit löschen

Route: `POST /teacher/delete-participation/:classId/:studentId/:markId`

Funktionen:

- Entfernt einzelne Mitarbeitseinträge bei einem Schüler.

## 7. Noten eines einzelnen Schülers

### 7.1 Notendetails pro Schüler

Route: `GET /teacher/student-grades/:classId/:studentId`

Funktionen:

- Zeigt alle Noten und Sonderleistungen eines Schülers.
- Zeigt den gewichteten Schnitt.
- Zeigt aktuelle Punkte-Zusammenfassung.
- Zeigt Mitarbeitshistorie.
- Zeigt Rückfragen pro Bewertung samt Antwortmöglichkeit.
- Zeigt Anhänge und erlaubt das Entfernen eines Anhangs.
- Unterstützt das Löschen einzelner Bewertungen.

### 7.2 Wunschnoten-Rechner

Technisch Teil der Seite `GET /teacher/student-grades/:classId/:studentId`

Funktionen:

- Berechnet, welche zusätzliche Note bei einer bestimmten Gewichtung nötig wäre.
- Berücksichtigt vorhandene Noten und Mitarbeit aus der Gesamtnote.
- Unterstützt interaktive Zielnotenberechnung direkt in der Oberfläche.

### 7.3 Transparenz- und Rechenwegdetails

Route: `GET /teacher/student-grades/:classId/:studentId/details`

Funktionen:

- Zeigt den vollständigen Rechenweg der Schülernote.
- Zeigt:
  - gewichtete Summen
  - laufende Durchschnittsberechnung
  - ausgeschlossene Einträge
  - Gründe für Ein- oder Ausschluss
  - Punkteberechnung
  - Profilregeln und Schwellenwerte
  - Mitarbeitsskala
- Zeigt noch offene Prüfungsvorlagen ohne Bewertung.

### 7.4 CSV-Exporte aus den Rechenwegdetails

Route: `GET /teacher/student-grades/:classId/:studentId/details?format=csv_raw`
Route: `GET /teacher/student-grades/:classId/:studentId/details?format=csv_rechenweg`

Funktionen:

- Exportiert Rohdaten aller berücksichtigten Einträge als CSV.
- Exportiert den schrittweisen Rechenweg als CSV.

## 8. Einzelne Bewertung hinzufügen

### 8.1 Formular anzeigen

Route: `GET /teacher/add-grade/:classId/:studentId`

Funktionen:

- Zeigt alle verfügbaren Prüfungsvorlagen der Klasse.
- Markiert bereits benotete Vorlagen für diesen Schüler.
- Nutzt das aktive Bewertungsprofil als Regelwerk.

### 8.2 Bewertung speichern

Route: `POST /teacher/add-grade/:classId/:studentId`

Funktionen:

- Erstellt eine einzelne Bewertung für einen Schüler.
- Unterstützt je nach Profil:
  - Note
  - Punkte
  - Note und Punkte
  - automatische Notenberechnung aus Punkten
- Unterstützt Abwesenheitslogik aus dem Profil.
- Unterstützt optionale Lehrernotiz.
- Unterstützt optional:
  - Dateianhang
  - externer Link
- Verhindert Datei und Link gleichzeitig.
- Validiert:
  - Notenbereich 1 bis 5
  - Punktebereich
  - Maximalpunkte der Vorlage
  - Pflichteingaben abhängig vom Scoring-Modus
- Verhindert doppelte Benotung derselben Vorlage für denselben Schüler.
- Erstellt nach erfolgreicher Bewertung eine Schüler-Benachrichtigung.

## 9. Bewertungen und Anhänge löschen

### 9.1 Bewertung löschen

Route: `POST /teacher/delete-grade/:classId/:gradeId`

Funktionen:

- Löscht eine vorhandene Bewertung.
- Entfernt dabei auch den gespeicherten Dateianhang vom Dateisystem.

### 9.2 Bewertungsanhang löschen

Route: `POST /teacher/delete-grade-attachment/:classId/:gradeId`

Funktionen:

- Entfernt nur den Anhang einer Bewertung.
- Die Note selbst bleibt erhalten.

## 10. Prüfungsvorlagen

### 10.1 Vorlagenübersicht

Route: `GET /teacher/grade-templates/:classId`

Funktionen:

- Zeigt alle Prüfungsvorlagen einer Klasse.
- Filter:
  - Suche
  - Kategorie
  - mit/ohne Maximalpunkte
- Sortierung:
  - Datum
  - Name
  - Gewichtung
  - Maximalpunkte
  - Kategorie
- Zeigt die Gesamtgewichtung aller Vorlagen.

### 10.2 Prüfungsvorlage erstellen

Route: `GET /teacher/create-template/:classId`
Route: `POST /teacher/create-template/:classId`

Funktionen:

- Erstellt neue Prüfungsvorlagen.
- Nutzt das aktive Lehrerprofil für Gewichtungslogik.
- Unterstützt:
  - Name
  - Kategorie
  - Gewichtung
  - maximale Punkte
  - Datum
  - Beschreibung
- Kann Gewichtungsvorschläge aus dem Profil übernehmen.

### 10.3 Prüfungsvorlage bearbeiten

Route: `GET /teacher/edit-template/:classId/:templateId`
Route: `POST /teacher/edit-template/:classId/:templateId`

Funktionen:

- Bearbeitet bestehende Prüfungsvorlagen.
- Validiert Gewichtung und Maximalpunkte.
- Unterstützt Änderungen an Name, Kategorie, Gewichtung, Punkten, Datum und Beschreibung.

### 10.4 Prüfungsvorlage löschen

Route: `POST /teacher/delete-template/:classId/:templateId`

Funktionen:

- Löscht eine vorhandene Prüfungsvorlage.

## 11. Sonderleistungen

### 11.1 Sonderleistungen anzeigen

Route: `GET /teacher/special-assessments/:classId`

Funktionen:

- Zeigt alle Sonderleistungen einer Klasse.
- Zeigt Schüler, aktive Profile und Gewichtungseinheit.
- Vorbelegung eines Schülers über `student_id` in der Query.

### 11.2 Sonderleistung anlegen

Route: `POST /teacher/special-assessments/:classId`

Funktionen:

- Erstellt zusätzliche Leistungsbewertungen außerhalb normaler Prüfungsvorlagen.
- Unterstützt Typen:
  - Präsentation
  - Wunschprüfung
  - Benutzerdefiniert
- Speichert:
  - Schüler
  - Typ
  - Name
  - Beschreibung
  - Gewichtung
  - Note
- Erstellt nach dem Speichern eine Schüler-Benachrichtigung.

### 11.3 Sonderleistung löschen

Route: `POST /teacher/delete-special-assessment/:classId/:assessmentId`

Funktionen:

- Entfernt eine vorhandene Sonderleistung.

## 12. Klassenstatistiken

### 12.1 Statistikseite

Route: `GET /teacher/class-statistics/:classId`

Funktionen:

- Berechnet klassenweite Auswertungen über alle Schüler.
- Berücksichtigt das aktive Profil, Mitarbeit und Abwesenheitslogik.
- Zeigt unter anderem:
  - Schüleranzahl
  - ungewichteten Klassenschnitt
  - gewichteten Klassenschnitt
  - Auswertung pro Prüfungsvorlage
  - beste und schwächste Ergebnisse je Vorlage
  - Anzahl benoteter Einträge je Vorlage

## 13. Sicherheits- und Validierungslogik

Der Lehrer-Bereich enthält zusätzlich folgende Querschnittsfunktionen:

- Rollenbasierter Zugriffsschutz über `requireAuth` und `requireRole("teacher")`
- Zugriff nur auf Klassen mit Lehrerzuordnung
- CSRF-Schutz für Formulare
- Upload-Schutz für Dateianhänge
- Entfernen hochgeladener Dateien bei Fehlern
- Umfangreiche Fachvalidierung für Noten, Punkte, Profile und Sonderleistungen

## 14. Kurzübersicht der wichtigsten Lehrer-Routen

| Bereich | Route | Methode | Zweck |
| --- | --- | --- | --- |
| Einstieg | `/teacher` | `GET` | Weiterleitung zur letzten zugewiesenen Klasse |
| Klassen | `/teacher/classes` | `GET` | Klassenübersicht |
| Klassen | `/teacher/create-class` | `GET`/`POST` | Klasse erstellen |
| Klassen | `/teacher/delete-class/:id` | `POST` | Klasse löschen |
| Einstellungen | `/teacher/settings` | `GET` | Profile und Bewertungslogik |
| Einstellungen | `/teacher/settings/save-profile` | `POST` | Profil speichern |
| Einstellungen | `/teacher/settings/activate-profile/:profileId` | `POST` | Profil aktivieren |
| Einstellungen | `/teacher/settings/delete-profile/:profileId` | `POST` | Profil löschen |
| Schüler | `/teacher/students/:classId` | `GET` | Schülerliste einer Klasse |
| Schüler | `/teacher/add-student/:classId` | `GET`/`POST` | Schüler hinzufügen |
| Schüler | `/teacher/delete-student/:classId/:studentId` | `POST` | Schüler entfernen |
| Nachrichten | `/teacher/test-questions/:classId` | `GET` | Rückfragen zu Tests anzeigen |
| Nachrichten | `/teacher/students/:classId/messages/:messageId/reply` | `POST` | Auf Rückfragen antworten |
| Noten | `/teacher/grades/:classId` | `GET` | Klassenweite Notenübersicht |
| Noten | `/teacher/grades/:classId/participation` | `POST` | Mitarbeit eintragen |
| Noten | `/teacher/delete-participation/:classId/:studentId/:markId` | `POST` | Mitarbeit löschen |
| Noten | `/teacher/student-grades/:classId/:studentId` | `GET` | Schüler-Notendetails |
| Noten | `/teacher/student-grades/:classId/:studentId/details` | `GET` | Transparenz- und Rechenwegdetails |
| Noten | `/teacher/add-grade/:classId/:studentId` | `GET`/`POST` | Einzelne Bewertung anlegen |
| Noten | `/teacher/delete-grade/:classId/:gradeId` | `POST` | Bewertung löschen |
| Noten | `/teacher/delete-grade-attachment/:classId/:gradeId` | `POST` | Bewertungsanhang löschen |
| Prüfungen | `/teacher/grade-templates/:classId` | `GET` | Prüfungsvorlagen anzeigen |
| Prüfungen | `/teacher/create-template/:classId` | `GET`/`POST` | Prüfungsvorlage erstellen |
| Prüfungen | `/teacher/edit-template/:classId/:templateId` | `GET`/`POST` | Prüfungsvorlage bearbeiten |
| Prüfungen | `/teacher/delete-template/:classId/:templateId` | `POST` | Prüfungsvorlage löschen |
| Sonderleistungen | `/teacher/special-assessments/:classId` | `GET`/`POST` | Sonderleistungen anzeigen und anlegen |
| Sonderleistungen | `/teacher/delete-special-assessment/:classId/:assessmentId` | `POST` | Sonderleistung löschen |
| Statistik | `/teacher/class-statistics/:classId` | `GET` | Klassenstatistiken |

## 15. Hinweise für GitHub-Reader

- Lehrer sehen nur Klassen, für die sie in `class_subject_teacher` zugeordnet sind.
- Viele Lehrerfunktionen hängen vom aktiven Bewertungsprofil ab.
- Mitarbeit ist kein separates Notenfach, sondern ein profilgesteuerter Zusatzbaustein.
- Noten können abhängig vom Profil aus Punkten automatisch berechnet werden.
- Rückfragen von Schülern laufen über `grade_messages` und sind direkt an Bewertungen gekoppelt.
- Transparenzdetails und CSV-Exporte helfen beim Nachvollziehen der Notenberechnung.
