# Run in an elevated PowerShell on DC01.
Import-Module ActiveDirectory

$ServiceAccount = "svc-nvs-http"
$ServicePasswordPlain = "NvsService123!"
$ServicePassword = ConvertTo-SecureString $ServicePasswordPlain -AsPlainText -Force
$KeytabPath = "C:\Temp\nvs.keytab"

if (-not (Get-ADUser -Filter "SamAccountName -eq '$ServiceAccount'" -ErrorAction SilentlyContinue)) {
  New-ADUser `
    -Name $ServiceAccount `
    -SamAccountName $ServiceAccount `
    -UserPrincipalName "$ServiceAccount@htlwydev.at" `
    -AccountPassword $ServicePassword `
    -Enabled $true `
    -PasswordNeverExpires $true
}

setspn -S HTTP/nvs.htlwydev.at HTLWYDEV\$ServiceAccount

New-Item -ItemType Directory -Path C:\Temp -Force | Out-Null

ktpass `
  /out $KeytabPath `
  /princ HTTP/nvs.htlwydev.at@HTLWYDEV.AT `
  /mapuser HTLWYDEV\$ServiceAccount `
  /pass $ServicePasswordPlain `
  /crypto AES256-SHA1 `
  /ptype KRB5_NT_PRINCIPAL

Write-Host "Keytab written to $KeytabPath"
