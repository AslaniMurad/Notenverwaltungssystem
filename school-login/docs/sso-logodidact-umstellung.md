# SSO Umstellung auf das echte LogoDIDACT der Schule

Diese Datei dokumentiert die Schritte, um die aktuell vorhandene lokale SSO-Simulation auf den echten `LogoDIDACT`-Identity-Provider der Schule umzustellen.

## Ausgangslage

Der Code fuer OIDC-SSO ist bereits vorhanden.

Aktuell wird lokal meist mit folgendem Modus getestet:

```env
SSO_ENABLED=true
SSO_SIMULATION_ENABLED=true
SSO_ALLOW_LOCAL_LOGIN=true
```

Fuer die echte Schulanbindung muessen Mock-Provider und Demo-Daten ersetzt werden durch einen echten OIDC-Client im schulischen `LogoDIDACT`-/Keycloak-System.

## Was vom LogoDIDACT-Admin benoetigt wird

Der zustaendige Admin oder Dienstleister muss folgende Informationen liefern oder konfigurieren:

1. `Issuer URL` des schulischen IdP
2. alternativ `Discovery URL`
3. `Client ID`
4. `Client Secret`
5. erlaubte Redirect-URI
6. optional erlaubte Post-Logout-Redirect-URI
7. Liste der Claims, die wirklich geliefert werden

Mindestens gewuenscht:

- `email`
- `preferred_username`
- optional `role`
- immer `sub`

## Vorbereitende Pruefung vor der Umstellung

Vor dem Go-Live sollte geprueft werden:

1. Stimmen die E-Mail-Adressen in `users.email` mit den Konten im schulischen LogoDIDACT ueberein?
2. Stimmen bei Schuelern die Werte in `students.email` ebenfalls ueberein?
3. Sollen Admins und Lehrkraefte weiterhin lokal gepflegt werden?
4. Soll lokaler Login nach der Umstellung als Fallback aktiv bleiben?

Empfehlung fuer dieses Projekt:

- Rollen lokal behalten
- Benutzer lokal behalten
- zuerst nur bestehende Benutzer per E-Mail verknuepfen
- lokales Login waehrend der Einfuehrung als Fallback anlassen

## Konkrete Umstellungsschritte

### Schritt 1: Domain und Redirect festlegen

Die Anwendung sollte unter einer stabilen URL erreichbar sein, zum Beispiel:

- `https://noten.example-schule.at`

Die Redirect-URI fuer den OIDC-Client lautet dann:

- `https://noten.example-schule.at/auth/sso/callback`

Optional:

- `https://noten.example-schule.at/login` als Post-Logout-Redirect

### Schritt 2: OIDC-Client im schulischen LogoDIDACT anlegen lassen

Der Admin muss im schulischen IdP einen Client fuer diese Anwendung registrieren.

Typische Eckdaten:

- Protocol: `openid-connect`
- Flow: `Authorization Code`
- PKCE: aktiv
- Redirect URI: `/auth/sso/callback`
- Client Authentication: mit `Client Secret`

### Schritt 3: Produktive Umgebungsvariablen setzen

Die lokale Simulation muss abgeschaltet und durch die echten Werte ersetzt werden.

Beispiel:

```env
SSO_ENABLED=true
SSO_SIMULATION_ENABLED=false
SSO_ALLOW_LOCAL_LOGIN=true
SSO_DISPLAY_NAME=LogoDIDACT
SSO_PROVIDER_KEY=logodidact

SSO_ISSUER=https://idp.eure-schule.tld/realms/eure-schule
# alternativ:
# SSO_DISCOVERY_URL=https://idp.eure-schule.tld/realms/eure-schule/.well-known/openid-configuration

SSO_CLIENT_ID=von-admin-erhalten
SSO_CLIENT_SECRET=von-admin-erhalten
SSO_REDIRECT_URI=https://noten.example-schule.at/auth/sso/callback
SSO_POST_LOGOUT_REDIRECT_URI=https://noten.example-schule.at/login

SSO_SCOPE=openid profile email
SSO_EMAIL_CLAIM=email
SSO_USERNAME_CLAIM=preferred_username
SSO_ROLE_CLAIM=role

SSO_AUTO_LINK_BY_EMAIL=true
SSO_AUTO_CREATE_USERS=false
SSO_REQUIRE_VERIFIED_EMAIL=false
```

### Schritt 4: Datenbank-Migration sicherstellen

Falls noch nicht geschehen:

1. `npm install`
2. `npm run migrate:sso`

Damit sind die benoetigten SSO-Felder in `users` vorhanden.

### Schritt 5: Anwendung neu starten

Nach dem Setzen der produktiven Variablen:

1. laufenden Server stoppen
2. Anwendung neu starten
3. Login ueber `Mit LogoDIDACT anmelden` testen

### Schritt 6: Pilot-Test mit echten Konten

Empfohlene Reihenfolge:

1. ein Admin-Konto
2. ein Lehrkraft-Konto
3. ein Schueler-Konto

Dabei pruefen:

- Login funktioniert
- Weiterleitung erfolgt in den richtigen Bereich
- Logout funktioniert
- Schuelerdaten werden korrekt geladen
- bestehende Accounts werden ueber E-Mail korrekt verknuepft

## Was sich im Code nicht aendern muss

Fuer die erste echte Schulanbindung muss in der Regel nichts Grundsaetzliches mehr implementiert werden.

Der vorhandene Code kann bereits:

- Discovery gegen einen echten OIDC-Provider
- Authorization Code Flow mit PKCE
- Token-Austausch
- UserInfo-Abfrage
- Zuordnung per `auth_provider + auth_subject`
- Erstverknuepfung per E-Mail

## Wahrscheinlich noetige Abstimmungen mit dem Admin

Mit dem Admin sollte explizit geklaert werden:

1. Wird `email` wirklich geliefert?
2. Falls nicht: Ist `preferred_username` eine echte Mailadresse?
3. Wie lautet der echte `Issuer`?
4. Welche Redirect-URI muss freigeschaltet werden?
5. Gibt es Logout-Unterstuetzung fuer RP-Initiated Logout?
6. Sind Testkonten verfuegbar?

## Typische Risiken bei der Umstellung

### Risiko 1: Keine passende E-Mail im Token

Folge:

- Benutzer kann sich extern anmelden, aber intern nicht zugeordnet werden

Loesung:

- Admin liefert `email`
- oder der Code wird auf ein anderes Claim als Primarschluessel angepasst

### Risiko 2: Schueler kann sich anmelden, aber keine Daten sehen

Folge:

- `users.email` passt, aber `students.email` nicht

Loesung:

- Schueler-E-Mails in der Datenbank angleichen

### Risiko 3: Lokaler Login zu frueh deaktiviert

Folge:

- kein schneller Rueckfallpfad bei Problemen

Loesung:

- waehrend der Einfuehrung `SSO_ALLOW_LOCAL_LOGIN=true` lassen

## Empfohlener Rollout

1. lokale Simulation erfolgreich testen
2. echte OIDC-Daten vom Admin erhalten
3. in Testumgebung auf echten IdP umstellen
4. mit drei echten Testkonten pruefen
5. optional lokalen Login zunaechst als Fallback behalten
6. erst nach erfolgreicher Pilotphase in Produktivbetrieb uebernehmen

## Nach der erfolgreichen Umstellung

Optional spaeter sinnvoll:

- Sessiondauer fuer SSO separat konfigurierbar machen
- echten Single Logout sauber abstimmen
- lokales Login fuer SSO-only-Konten deaktivieren
- Admin-Ansicht fuer SSO-Verknuepfungsstatus ergaenzen

## Empfohlene Uebergabe an den Schul-Admin

Dem Admin sollten mindestens diese Informationen geschickt werden:

- Zielanwendung: Notenverwaltungssystem
- Basis-URL der Anwendung
- Redirect-URI `/auth/sso/callback`
- benoetigte Claims `sub`, `email`, `preferred_username`, optional `role`
- Hinweis, dass Benutzer intern ueber E-Mail zugeordnet werden
- Bitte um `Issuer`, `Client ID`, `Client Secret`
