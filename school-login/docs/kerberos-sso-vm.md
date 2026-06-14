# Kerberos-SSO-Demo mit VMs

Diese Anleitung baut eine realistische Demo ohne Logodidact-Zugriff. Logodidact wird nicht angebunden. Stattdessen wird eine eigene Windows-Domaene in VMs aufgebaut und ein Apache-Reverse-Proxy prueft Kerberos. NVS bekommt danach nur den bestaetigten Benutzer ueber `X-Remote-User`.

## Zielbild

```text
Windows Client in Domaene HTLWYDEV.AT
  -> Benutzer meldet sich an Windows an
  -> Browser oeffnet https://nvs.htlwydev.at/
  -> Browser sendet Kerberos/SPNEGO automatisch
  -> Apache prueft Ticket mit Keytab
  -> Apache setzt X-Remote-User
  -> NVS erstellt automatisch eine Session
```

Die Node-App prueft Kerberos nicht selbst. Das ist Absicht. In echten Umgebungen macht das ein vorgeschalteter Dienst, z. B. Logodidact, IIS, Apache oder Nginx.

## VM-Uebersicht

| VM | OS | Netz | IP |
| --- | --- | --- | --- |
| `DC01` | Windows Server | Internes Lab-Netz | `10.10.10.10` |
| `WEB01` | Ubuntu Server | Internes Lab-Netz + NAT | `10.10.10.20` + NAT-DHCP |
| `CLIENT01` | Windows 10/11 Pro | Internes Lab-Netz | `10.10.10.30` |

## VMware Settings

Verwende ein internes VMnet fuer die Domaene, z. B. `VMnet2`.

`DC01`:

```text
Network Adapter 1: Custom VMnet2
Connected: on
Connect at power on: on
```

`CLIENT01`:

```text
Network Adapter 1: Custom VMnet2
Connected: on
Connect at power on: on
```

`WEB01`:

```text
Network Adapter 1: Custom VMnet2
Network Adapter 2: NAT
Connected: on
Connect at power on: on
```

Wichtig: Ubuntu braucht zwei Adapter. `ens33` ist fuer das interne Domain-Netz, `ens37` ist fuer Internet/NAT. Wenn dein Interface anders heisst, mit `ip -br a` pruefen und Namen in Netplan anpassen.

## DC01: Active Directory installieren

PowerShell als Administrator:

```powershell
Install-WindowsFeature AD-Domain-Services -IncludeManagementTools

Install-ADDSForest `
  -DomainName "htlwydev.at" `
  -DomainNetbiosName "HTLWYDEV" `
  -InstallDns `
  -Force
```

Wenn der lokale Administrator zu schwach ist:

```powershell
net user Administrator "Schule-Admin-2026!"
```

Danach `Install-ADDSForest` erneut starten. Fuer den DSRM/SafeMode-Administrator ein starkes Passwort nehmen, z. B. `Schule-DSRM-2026!`.

## DC01: DNS, User und Keytab vorbereiten

Du kannst die PowerShell-Vorlagen verwenden:

- `docs/kerberos/scripts/dc01-ad-setup.ps1`
- `docs/kerberos/scripts/dc01-keytab.ps1`

Kurzfassung:

```powershell
Add-DnsServerResourceRecordA -ZoneName "htlwydev.at" -Name "nvs" -IPv4Address "10.10.10.20"
Add-DnsServerResourceRecordA -ZoneName "htlwydev.at" -Name "dc01" -IPv4Address "10.10.10.10"

Set-DnsServerForwarder -IPAddress 1.1.1.1,8.8.8.8 -PassThru
Restart-Service DNS
```

Testbenutzer:

```powershell
$password = ConvertTo-SecureString "Schule123!" -AsPlainText -Force
New-ADUser `
  -Name "Max Mustermann" `
  -GivenName "Max" `
  -Surname "Mustermann" `
  -SamAccountName "max.mustermann" `
  -UserPrincipalName "max.mustermann@htlwydev.at" `
  -AccountPassword $password `
  -Enabled $true `
  -PasswordNeverExpires $true
```

Service Account und Keytab:

```powershell
$svcPassword = ConvertTo-SecureString "NvsService123!" -AsPlainText -Force
New-ADUser `
  -Name "svc-nvs-http" `
  -SamAccountName "svc-nvs-http" `
  -UserPrincipalName "svc-nvs-http@htlwydev.at" `
  -AccountPassword $svcPassword `
  -Enabled $true `
  -PasswordNeverExpires $true

setspn -S HTTP/nvs.htlwydev.at HTLWYDEV\svc-nvs-http

ktpass `
  /out C:\Temp\nvs.keytab `
  /princ HTTP/nvs.htlwydev.at@HTLWYDEV.AT `
  /mapuser HTLWYDEV\svc-nvs-http `
  /pass NvsService123! `
  /crypto AES256-SHA1 `
  /ptype KRB5_NT_PRINCIPAL
```

`C:\Temp\nvs.keytab` spaeter nach Ubuntu kopieren.

## WEB01: Netplan

Vorlage: `docs/kerberos/templates/web01-netplan.yaml`

Auf Ubuntu:

```bash
sudo nano /etc/netplan/00-installer-config.yaml
```

Inhalt, falls die Interfaces `ens33` und `ens37` heissen:

```yaml
network:
  version: 2
  ethernets:
    ens33:
      addresses:
        - 10.10.10.20/24
      nameservers:
        addresses:
          - 10.10.10.10
          - 1.1.1.1
          - 8.8.8.8
        search:
          - htlwydev.at
    ens37:
      dhcp4: true
      dhcp6: false
```

Anwenden:

```bash
sudo netplan generate
sudo netplan apply
```

Tests:

```bash
ip -br a
ip route
ping -c 2 10.10.10.10
ping -c 2 8.8.8.8
nslookup dc01.htlwydev.at
nslookup archive.ubuntu.com
```

Erwartung:

```text
ens33 -> 10.10.10.20/24
ens37 -> 192.168.x.x/24
default via 192.168.x.2 dev ens37
dc01.htlwydev.at -> 10.10.10.10
```

Wenn `ping 8.8.8.8` nicht geht, nicht mit `apt` weitermachen. Dann ist NAT/Routing noch falsch.

## WEB01: Pakete installieren

IPv4 fuer `apt` erzwingen, falls Ubuntu IPv6-Adressen versucht:

```bash
sudo nano /etc/apt/apt.conf.d/99force-ipv4
```

Inhalt:

```text
Acquire::ForceIPv4 "true";
```

Dann:

```bash
sudo apt clean
sudo apt update
sudo apt install -y apache2 libapache2-mod-auth-gssapi krb5-user git curl build-essential nodejs npm
sudo a2enmod ssl proxy proxy_http headers auth_gssapi rewrite
sudo systemctl restart apache2
```

## WEB01: Kerberos konfigurieren

Vorlage: `docs/kerberos/templates/krb5.conf`

```bash
sudo nano /etc/krb5.conf
```

Minimaler Inhalt:

```ini
[libdefaults]
    default_realm = HTLWYDEV.AT
    dns_lookup_realm = false
    dns_lookup_kdc = false
    ticket_lifetime = 24h
    forwardable = true
    rdns = false

[realms]
    HTLWYDEV.AT = {
        kdc = dc01.htlwydev.at
        admin_server = dc01.htlwydev.at
    }

[domain_realm]
    .htlwydev.at = HTLWYDEV.AT
    htlwydev.at = HTLWYDEV.AT
```

Test:

```bash
kinit max.mustermann@HTLWYDEV.AT
klist
kdestroy
```

Passwort fuer `max.mustermann`, wenn du die Vorlage benutzt hast:

```text
Schule123!
```

## WEB01: NVS deployen

```bash
cd /opt
sudo git clone https://github.com/AslaniMurad/Notenverwaltungssystem.git nvs
sudo chown -R nvsadmin:nvsadmin /opt/nvs
cd /opt/nvs/school-login
git checkout cerberos
npm install
```

`.env` erstellen:

```bash
nano .env
```

Fuer Demo/Fake-DB:

```env
NODE_ENV=production
PORT=3000
SESSION_SECRET=ersetzen-durch-langes-zufaelliges-secret
USE_FAKE_DB=true
SEED_DEMO=true
DEMO_TEACHER_EMAIL=max.mustermann@htlwydev.at
DEMO_TEACHER_PASS=DemoPass123!
SSO_ENABLED=true
SSO_HEADER=x-remote-user
SSO_REALM=HTLWYDEV.AT
SSO_EMAIL_DOMAIN=htlwydev.at
```

Fuer Microsoft Teams Einbettung zusaetzlich setzen:

```env
TEAMS_EMBED_ENABLED=true
# Standard ist true, wenn TEAMS_EMBED_ENABLED=true.
TEAMS_MICROSOFT_LOGIN_ONLY=true
# Optional, nur wenn weitere erlaubte Parent-Origin(s) gebraucht werden.
# FRAME_ANCESTORS=self
# Optionaler Override. Standard ist true, wenn TEAMS_EMBED_ENABLED=true.
# SESSION_COOKIE_PARTITIONED=true
```

Die URL des Teams-Tabs sollte den Teams-Kontext explizit mitgeben:

```text
https://nvs.htlwydev.at/login?teams=1
```

Dann zeigt Teams nur die Microsoft-Anmeldung und oeffnet den eigentlichen Microsoft-Login in einem Popup. Das verhindert, dass `login.microsoftonline.com` im Teams-iframe geladen wird. `https://nvs.htlwydev.at/login` im normalen Browser zeigt weiterhin alle Loginmoeglichkeiten.

Test:

```bash
npm start
```

In einem zweiten Terminal:

```bash
curl -I http://127.0.0.1:3000/login
```

Nach dem Deployment muss der CSP-Header Teams erlauben:

```bash
curl -I https://nvs.htlwydev.at/login | grep -i content-security-policy
```

Erwartet ist ein Header mit Teams und `cloud.microsoft`, z. B.:

```text
Content-Security-Policy: frame-ancestors 'self' https://teams.microsoft.com https://*.teams.microsoft.com https://teams.cloud.microsoft https://*.cloud.microsoft
```

Der Session-Cookie muss fuer Teams als Cross-Site-Cookie gesetzt werden:

```bash
curl -I https://nvs.htlwydev.at/login | grep -i set-cookie
```

Erwartet sind `Secure`, `SameSite=None` und bei Teams-Einbettung `Partitioned`.

## WEB01: systemd Service

```bash
sudo nano /etc/systemd/system/nvs.service
```

Du kannst die Vorlage `docs/kerberos/templates/nvs.service` verwenden.

Inhalt:

```ini
[Unit]
Description=NVS Node App
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/nvs/school-login
EnvironmentFile=/opt/nvs/school-login/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

Aktivieren:

```bash
sudo chown -R www-data:www-data /opt/nvs
sudo systemctl daemon-reload
sudo systemctl enable --now nvs
sudo systemctl status nvs
```

## WEB01: Keytab installieren

`nvs.keytab` nach Ubuntu kopieren, dann:

```bash
sudo install -o www-data -g www-data -m 0400 nvs.keytab /etc/apache2/nvs.keytab
sudo klist -k /etc/apache2/nvs.keytab
```

Die Ausgabe muss enthalten:

```text
HTTP/nvs.htlwydev.at@HTLWYDEV.AT
```

## WEB01: HTTPS und Apache

Demo-Zertifikat:

```bash
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/ssl/private/nvs.key \
  -out /etc/ssl/certs/nvs.crt \
  -subj "/CN=nvs.htlwydev.at"
```

Apache-VHost:

```bash
sudo nano /etc/apache2/sites-available/nvs.conf
```

Du kannst die Vorlage `docs/kerberos/templates/apache-nvs.conf` verwenden.

Aktivieren:

```bash
sudo a2dissite 000-default.conf
sudo a2ensite nvs.conf
sudo apachectl configtest
sudo systemctl reload apache2
```

## CLIENT01: Domain und Browser

Client-DNS:

```text
DNS: 10.10.10.10
```

Domain Join:

```text
Domain: htlwydev.at
```

Mit Domain-User anmelden:

```text
HTLWYDEV\max.mustermann
```

Browser:

```text
https://nvs.htlwydev.at/
```

Wenn Windows nach Passwort fragt:

- Seite zur lokalen Intranet-Zone hinzufuegen.
- DNS pruefen.
- Keytab/SPN pruefen.

## Praesentationssatz

```text
Da wir keinen Logodidact-Zugriff haben, simulieren wir die gleiche technische Rolle mit einer eigenen Windows-Domaene und Apache Kerberos. Der Benutzer meldet sich nur an Windows an. Apache prueft das Kerberos-Ticket und gibt den bestaetigten Benutzer intern an NVS weiter. NVS erstellt daraus ohne Loginformular die Session.
```
