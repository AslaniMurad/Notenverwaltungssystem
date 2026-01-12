# School Login (Notenverwaltungssystem)

Web-App fuer Schul-Login und Notenverwaltung mit Rollen fuer Admin, Lehrer (teacher) und Schueler (student). Backend: Node.js/Express, Frontend: EJS + statische Assets, Datenhaltung ueber PostgreSQL (optional Fake-DB).

## Features
- Rollenbasierter Login und Dashboard (admin/teacher/student)
- Admin: Benutzerverwaltung (Einzel/Bulk), Passwort-Reset, Klassenverwaltung, Schueler-Zuordnung, Uebersicht
- Teacher: Klassen anlegen, Schueler verwalten, Pruefungsvorlagen, Noten erfassen, Sonderleistungen, Klassenstatistiken
- Student: Dashboard, Noten/Tasks/Returns, Durchschnitte, Benachrichtigungen, Export als CSV/PDF
- Sicherheit: Sessions, CSRF-Schutz, Security-Header
- DB: Automatisches Schema-Setup + Seed-Daten, Fake-DB fuer Demo/Tests

## Projektstruktur
```text
.
|-- server.js                 # Express App, Sessions, CSRF, Routing
|-- db.js                     # PostgreSQL/Fake-DB, Schema, Seeds, Passwort-Hashing
|-- routes/                   # Rollenrouten: admin, teacher, student
|-- middleware/               # Auth Guards
|-- views/                    # EJS Templates
|-- public/                   # CSS/JS/Images
|-- check_db.js               # DB-Check
|-- check_tables.js           # Tabellen-Check
|-- migrate_add_columns.js    # Migration: Users-Spalten
|-- migrate_add_grades.js     # Migration: grades Tabelle
|-- migrate_to_template_system.js # Migration: grade_templates + grades
|-- fix_grades_table.js       # Rebuild der grades Tabelle (destruktiv)
|-- server.test.js            # node:test Smoke-Tests
```

## Voraussetzungen
- Node.js 18+ (Tests nutzen node:test und fetch)
- PostgreSQL (wenn USE_FAKE_DB nicht gesetzt ist)

## Schnellstart
1. npm install
2. .env anlegen (siehe unten)
3. node server.js
4. Browser: http://localhost:3000

## Konfiguration (Umgebungsvariablen)

Beispiel `.env`:

```dotenv
PGHOST=localhost
PGPORT=5432
PGDATABASE=school
PGUSER=school_user
PGPASSWORD=secret
PGSSL=false

SESSION_SECRET=change-me
ADMIN_EMAIL=admin@example.com
ADMIN_PASS=ChangeMe123!
PORT=3000
NODE_ENV=development

# Optional: Demo/Test ohne PostgreSQL
USE_FAKE_DB=true
# Alternative zu PG*: DATABASE_URL=postgres://user:pass@host:5432/dbname
```

- `DATABASE_URL` ersetzt die einzelnen PG* Variablen.
- `PGSSL` ist standardmaessig aktiv; fuer lokale DB oft `PGSSL=false`.
- `SESSION_SECRET` sollte in Produktion fix gesetzt werden.

## Datenbank und Seeds
- Beim Start erstellt `db.js` die Tabellen, falls sie fehlen: users, classes, students, grade_templates, grades, special_assessments, grade_notifications.
- Admin wird aus `ADMIN_EMAIL`/`ADMIN_PASS` angelegt (nur wenn noch nicht vorhanden).
- Demo-User werden einmalig angelegt: teacher@example.com / teacherDemo123!, student@example.com / studentDemo123! (inkl. Beispielklasse 3AHWII).
- Mit `USE_FAKE_DB=true` laeuft alles in-memory ohne PostgreSQL.

## Rollen und Funktionen
- Admin: Nutzer anlegen (einzeln/bulk), Rollen/Status pflegen, Passwoerter resetten, Klassen und Schueler verwalten.
- Teacher: Eigene Klassen anlegen/loeschen, Schueler hinzufuegen, Pruefungsvorlagen pflegen, Noten und Sonderleistungen erfassen, Klassenstatistiken.
- Student: Eigene Noten und Durchschnitt sehen, Aufgaben/Rueckgaben filtern, Benachrichtigungen lesen, CSV/PDF exportieren.
- Hinweis: Schueler muessen als User mit Rolle `student` existieren, bevor sie einer Klasse zugeordnet werden.

## Student-API und Exporte
- GET /student/grades?subject=...&startDate=...&endDate=...&sort=date|value
- GET /student/tasks
- GET /student/returns
- GET /student/class-averages
- GET /student/notifications
- POST /student/notifications/:id/read (Header: X-CSRF-Token)
- GET /student/grades.csv
- GET /student/grades.pdf

## Wartung und Migration
```shell
node check_db.js
node check_tables.js
node migrate_add_columns.js
node migrate_add_grades.js
node migrate_to_template_system.js
node fix_grades_table.js
```
Achtung: `fix_grades_table.js` loescht die Tabelle `grades` und baut sie neu auf.

## Tests
```shell
node --test server.test.js
```
Tests nutzen die Fake-DB und pruefen Login sowie Student-Endpunkte.

## Sicherheitshinweise
- `SESSION_SECRET` setzen (sonst random pro Start).
- `NODE_ENV=production` aktiviert sichere Cookies und `trust proxy`.
- `.env` nicht committen; Zugangsdaten nur lokal.
- CSRF-Token bei POST Requests mitsenden (Header `X-CSRF-Token`).
