# Student Functions

Diese Datei dokumentiert die aktuell im Projekt vorhandenen Funktionen des Schüler-Bereichs für GitHub.
Grundlage sind die implementierten Routen in `school-login/routes/student.js`, die Ansicht
`school-login/views/student-dashboard.ejs` und das Frontend-Skript
`school-login/public/js/student-dashboard.js`.

## Ziel des Schüler-Bereichs

Der Schüler-Bereich dient zur Einsicht und Nachverfolgung des eigenen Lernstands und umfasst:

- Dashboard mit Kennzahlen
- Aufgabenübersicht
- Rückgaben und Rückfragen zu Bewertungen
- Notenansicht mit Filtern
- Klassenvergleich
- Benachrichtigungen
- CSV- und PDF-Export der Noten

Der Zugriff ist nur für eingeloggte Benutzer mit der Rolle `student` erlaubt.

## 1. Einstieg und Navigation

### 1.1 Schüler-Start

Route: `GET /student`
Route: `GET /student/overview`

Funktionen:

- Öffnet das Schüler-Dashboard in der Ansicht `Übersicht`.
- Zeigt Name, aktuelle Klasse und E-Mail des eingeloggten Schülers.
- Lädt beim Rendern bereits Initialdaten für Noten, Aufgaben, Rückgaben, Klassenvergleich und Benachrichtigungen.

### 1.2 Seiten im Schüler-Dashboard

Funktionen:

- Seitennavigation in der Sidebar:
  - Übersicht
  - Aufgaben
  - Rückgaben
  - Anfragen
  - Noten
- Logout direkt aus dem Dashboard.

### 1.3 Kompatibilitäts-Routen

Route: `GET /student/aufgaben`
Route: `GET /student/rueckgaben`
Route: `GET /student/noten`
Route: `GET /student/anfragen`

Funktionen:

- Leiten auf die neuen englischen Pfade weiter:
  - `/student/tasks`
  - `/student/returns`
  - `/student/grades`
  - `/student/requests`

## 2. Profil- und Kontextdaten

### 2.1 Schülerprofil laden

Route: `GET /student/profile`

Funktionen:

- Liefert Profildaten als JSON.
- Enthält:
  - Name
  - Klassenname
  - Klassen-ID
  - Fach der Klasse
  - Schuljahr, sofern vorhanden

## 3. Übersicht

### 3.1 Dashboard-Kacheln

Funktionen:

- Zeigt den aktuellen Gesamtdurchschnitt.
- Zeigt die Anzahl offener Aufgaben.
- Zeigt die Anzahl vorhandener Rückgaben.

### 3.2 Nächste Aufgaben

Funktionen:

- Zeigt die nächsten offenen Aufgaben mit Datum.
- Sortiert nach dem frühesten Fälligkeitsdatum.
- Beschränkt die Übersicht auf die nächsten drei Einträge.

### 3.3 Letzte Rückgaben

Funktionen:

- Zeigt die zuletzt erhaltenen Rückgaben.
- Zeigt Titel, Kategorie und Note.
- Beschränkt die Übersicht auf die letzten drei Einträge.

## 4. Aufgaben

### 4.1 Aufgabenansicht

Route: `GET /student/tasks`

Funktionen:

- Rendert die Aufgaben-Seite als HTML oder liefert Aufgaben als JSON.
- Baut Aufgaben aus vorhandenen Bewertungsvorlagen der Klasse auf.
- Zeigt pro Aufgabe:
  - Titel
  - Kategorie
  - Datum
  - Gewichtung
  - Beschreibung
  - Bearbeitungsstatus

### 4.2 Aufgabenstatus

Funktionen:

- `Offen`, wenn noch keine Bewertung vorliegt.
- `Überfällig`, wenn das Datum in der Vergangenheit liegt und noch keine Bewertung existiert.
- `Benotet`, wenn bereits eine Note zur Aufgabe vorhanden ist.

### 4.3 Filter in der Aufgabenansicht

Funktionen:

- Filter nach Fach.
- Volltextsuche über Titel und Beschreibung.

## 5. Rückgaben

### 5.1 Rückgaben anzeigen

Route: `GET /student/returns`

Funktionen:

- Rendert die Rückgaben-Seite als HTML oder liefert Rückgaben als JSON.
- Zeigt reguläre Bewertungen und Sonderleistungen.
- Zeigt pro Rückgabe:
  - Titel
  - Kategorie
  - Note
  - Rückgabedatum
  - Gewichtung
  - Notiz beziehungsweise Kommentar

### 5.2 Materialien zu Rückgaben

Funktionen:

- Zeigt einen Download-Link, wenn eine Datei zur Bewertung gespeichert wurde.
- Zeigt einen externen Link, wenn statt einer Datei ein Verweis hinterlegt wurde.

### 5.3 Filter in der Rückgabenansicht

Funktionen:

- Filter nach Fach.
- Volltextsuche über Titel und Notiz.

### 5.4 Kommunikationsstatus zu Rückgaben

Funktionen:

- Kennzeichnet Rückgaben mit Status:
  - `Noch keine Rückfrage`
  - `Antwort ausstehend`
  - `Beantwortet`
  - `Neue Antwort`
- Zeigt Anzahl der Nachrichten und letzte Aktivität.
- Verlinkt direkt zur Anfragen-Ansicht für die jeweilige Rückgabe.

## 6. Anfragen zu Rückgaben

### 6.1 Anfragen-Seite

Route: `GET /student/requests`

Funktionen:

- Zeigt alle möglichen Rückfragen zu benoteten Rückgaben mit Nachrichtenverlauf.
- Listet nur Rückgaben, zu denen Nachrichten erlaubt sind oder bereits Nachrichten existieren.
- Sortiert Anfragen priorisiert nach:
  - ungelesenen Lehrerantworten
  - offenen, noch unbeantworteten Anfragen
  - letzter Aktivität

### 6.2 Filter in der Anfragenansicht

Funktionen:

- Filter nach konkreter Rückgabe.
- Volltextsuche über Titel, Notiz und Nachrichteninhalt.

### 6.3 Nachrichtenverlauf

Funktionen:

- Zeigt Schülernachrichten und Lehrerantworten als Verlauf.
- Kennzeichnet neue Lehrerantworten sichtbar.
- Öffnet Konversationen automatisch, wenn ungelesene Antworten vorhanden sind.

### 6.4 Anfrage senden

Route: `POST /student/returns/:gradeId/message`

Funktionen:

- Erstellt eine neue Rückfrage zu einer Bewertung.
- Erlaubt Nachrichten nur für reguläre bewertete Vorlagen, nicht für Sonderleistungen.
- Validiert:
  - gültige Rückgabe-ID
  - Besitz der Rückgabe durch den eingeloggten Schüler
  - Pflichtfeld Nachricht
  - maximale Länge von 1000 Zeichen
- Zeigt im Frontend Zeichenzähler und Statusmeldungen beim Senden.

### 6.5 Antworten als gelesen markieren

Route: `POST /student/returns/:gradeId/messages/seen`

Funktionen:

- Markiert ungelesene Lehrerantworten beim Öffnen einer Anfrage als gelesen.
- Aktualisiert den lokalen Status im Dashboard anschließend neu.

## 7. Dateien zu Rückgaben

### 7.1 Anhang herunterladen

Route: `GET /student/returns/:gradeId/attachment`

Funktionen:

- Stellt gespeicherte Anhänge zu einer Bewertung als Download bereit.
- Prüft, ob die Datei wirklich zur Rückgabe des Schülers gehört.
- Schützt vor ungültigen oder manipulierten Dateipfaden.
- Setzt Dateiname und MIME-Typ für den Download.

## 8. Noten

### 8.1 Notenansicht

Route: `GET /student/grades`

Funktionen:

- Rendert die Noten-Seite als HTML oder liefert Noten als JSON.
- Zeigt reguläre Bewertungen und Sonderleistungen in einer gemeinsamen Liste.
- Zeigt pro Eintrag:
  - Fach
  - Datum
  - Lehrkraft
  - Kommentar
  - Note
  - Gewichtung

### 8.2 Filter und Sortierung

Funktionen:

- Filter nach Fach.
- Filter nach Start- und Enddatum.
- Sortierung nach:
  - Datum, neueste zuerst
  - Wert, beste Note zuerst

### 8.3 Kennzahlen in der Notenansicht

Funktionen:

- Gesamtdurchschnitt
- Trend-Anzeige
- Letzte Aktualisierung

Hinweis:

- Die Trend-Anzeige ist aktuell technisch vorhanden und wird derzeit mit einem neutralen Standardwert geladen.

### 8.4 Durchschnittsberechnung

Funktionen:

- Berechnet gewichtete Durchschnitte.
- Berücksichtigt den aktiven Abwesenheitsmodus des Lehrer-Profils der Klasse.
- Unterstützt die Modi:
  - Abwesenheit mit 0 werten
  - Abwesenheit aus der Berechnung ausschließen

## 9. Klassenvergleich

### 9.1 Vergleich mit dem Klassenschnitt

Route: `GET /student/class-averages`

Funktionen:

- Liefert gewichtete Durchschnittswerte der Klasse je Fach.
- Stellt die Daten im Dashboard als Balkenvergleich dar.

## 10. Benachrichtigungen

### 10.1 Benachrichtigungen anzeigen

Route: `GET /student/notifications`

Funktionen:

- Lädt Benachrichtigungen des Schülers als JSON.
- Zeigt neue Noten und durchschnittsbezogene Hinweise an.
- Kennzeichnet ungelesene Einträge optisch.

### 10.2 Benachrichtigungen als gelesen markieren

Route: `POST /student/notifications/:id/read`

Funktionen:

- Setzt einzelne Benachrichtigungen auf gelesen.
- Aktualisiert den Zustand direkt im Frontend.

## 11. Exporte

### 11.1 CSV-Export

Route: `GET /student/grades.csv`

Funktionen:

- Exportiert die Notenliste als CSV-Datei.
- Exportiert die Spalten:
  - Fach
  - Datum
  - Note
  - Gewichtung
  - Lehrkraft
  - Kommentar
- Schützt CSV-Zellen gegen problematische Formeleinstiege.

### 11.2 PDF-Export

Route: `GET /student/grades.pdf`

Funktionen:

- Exportiert eine einfache Notenübersicht als PDF-Datei.
- Enthält Schülername, Klasse, Fach und die gelisteten Bewertungen.
- Erzeugt das PDF direkt im Servercode ohne externe PDF-Bibliothek.

## 12. Technische Besonderheiten

### 12.1 HTML- und JSON-Ausgabe

Funktionen:

- Mehrere Routen unterstützen sowohl HTML als auch JSON.
- Die Ausgabe wird anhand des Accept-Headers oder des Query-Parameters `format` gewählt.

### 12.2 Sicherheit und Validierung

Funktionen:

- Zugriff nur mit `requireAuth` und Rolle `student`.
- Audit-Logging für Zugriffe im Schüler-Bereich.
- CSRF-Schutz für schreibende Aktionen.
- Prüfung, dass nur eigene Rückgaben, Nachrichten und Benachrichtigungen bearbeitet werden können.

## 13. Überblick der wichtigsten Schüler-Routen

- `GET /student`
- `GET /student/overview`
- `GET /student/profile`
- `GET /student/tasks`
- `GET /student/returns`
- `GET /student/requests`
- `POST /student/returns/:gradeId/message`
- `POST /student/returns/:gradeId/messages/seen`
- `GET /student/returns/:gradeId/attachment`
- `GET /student/grades`
- `GET /student/class-averages`
- `GET /student/notifications`
- `POST /student/notifications/:id/read`
- `GET /student/grades.csv`
- `GET /student/grades.pdf`
