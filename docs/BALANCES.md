BALANCES.md
# Saldo ja saldokorjaukset

Saldo voi olla mukana exportissa. Saldot tallennetaan BalanceSnapshot riveiksi.

Jos exportissa ei ole saldoa lainkaan (esim. luottokortti), käyttäjä asettaa tilille saldon
tiettynä päivänä (`POST /balance-snapshots`, `source: manual`; luottokortin velka negatiivisena).
Se on saldosnapshot kuten tuotu, joten etusivu, nettovarallisuus ja saldohistoria käyttävät sitä
siitä päivästä alkaen. Saman päivän tuonti korvaa sen.

Jos saldo on virheellinen, käyttäjä voi tehdä BalanceAdjustmentin. Oikaisu korjaa olemassa olevaa
saldoa: tilille, jolla ei ole yhtään saldosnapshotia, sitä ei hyväksytä (409
`balance_snapshot_missing`), ja viimeisintä saldoa myöhemmin päivätty oikaisu odottaa
myöhempää saldoa (`applied: false`).
Korjaus vaikuttaa raportoinnin saldoihin, mutta ei muuta yksittäisiä tapahtumia.
BalanceAdjustment toimii käytännössä "nollausmerkintänä": se kirjaa erotuksen ja korjaa
saldojen kehityksen siitä päivästä eteenpäin ilman että tapahtumia siirrellään.

Manuaalinen saldo ei kulje eteenpäin: kun tilille tuodaan sen päivää myöhempiä tapahtumia ilman
saldoa, saldohistoria pitää tiliä tuntemattomana niistä päivistä alkaen, kunnes käyttäjä asettaa
uuden saldon. Ennen saldoa tallennetut (käyttämättömät) oikaisut tulevat käyttöön, kun tilille
asetetaan saldo samana tai myöhempänä päivänä; asetussivu varoittaa niistä.
