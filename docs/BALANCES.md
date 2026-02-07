BALANCES.md
# Saldo ja saldokorjaukset

Saldo voi olla mukana exportissa. Saldot tallennetaan BalanceSnapshot riveiksi.

Jos saldo puuttuu tai on virheellinen, käyttäjä voi tehdä BalanceAdjustmentin.
Korjaus vaikuttaa raportoinnin saldoihin, mutta ei muuta yksittäisiä tapahtumia.
BalanceAdjustment toimii käytännössä "nollausmerkintänä": se kirjaa erotuksen ja korjaa
saldojen kehityksen siitä päivästä eteenpäin ilman että tapahtumia siirrellään.
