# Run in an elevated PowerShell on DC01 after AD DS promotion.
Import-Module ActiveDirectory

$DomainZone = "htlwydev.at"
$DcIp = "10.10.10.10"
$WebIp = "10.10.10.20"
$UserPassword = ConvertTo-SecureString "Schule123!" -AsPlainText -Force

if (-not (Get-DnsServerResourceRecord -ZoneName $DomainZone -Name "dc01" -ErrorAction SilentlyContinue)) {
  Add-DnsServerResourceRecordA -ZoneName $DomainZone -Name "dc01" -IPv4Address $DcIp
}

if (-not (Get-DnsServerResourceRecord -ZoneName $DomainZone -Name "nvs" -ErrorAction SilentlyContinue)) {
  Add-DnsServerResourceRecordA -ZoneName $DomainZone -Name "nvs" -IPv4Address $WebIp
}

Set-DnsServerForwarder -IPAddress 1.1.1.1,8.8.8.8 -PassThru
Restart-Service DNS

if (-not (Get-ADUser -Filter "SamAccountName -eq 'max.mustermann'" -ErrorAction SilentlyContinue)) {
  New-ADUser `
    -Name "Max Mustermann" `
    -GivenName "Max" `
    -Surname "Mustermann" `
    -SamAccountName "max.mustermann" `
    -UserPrincipalName "max.mustermann@htlwydev.at" `
    -AccountPassword $UserPassword `
    -Enabled $true `
    -PasswordNeverExpires $true
}

Write-Host "AD demo setup finished."
