DATA_MODEL.md
# Datamalli

Tässä kuvataan keskeiset käsitteet. Tarkat kentät päätetään toteutusvaiheessa, mutta rajapintojen tarkoitus lukitaan tässä.

## ImportSession

ImportSession vastaa yhtä käyttäjän tekemää importia.
Se sisältää lähdebankin nimen, formaatin, tiedoston checksumit ja rivimäärät.
ImportSession sisältää myös overlap-avaimen (esim. checksum + tilin IBAN + rivimäärä + aikaväli),
jonka avulla tunnistetaan identtiset tai selkeästi päällekkäiset importit.

## RawTransaction

RawTransaction vastaa yhtä riviä CSV:stä tai XLSX:stä.
Se säilyttää alkuperäiset kentät JSON blobina.
Se sisältää myös kevyet indeksikentät, kuten summa ja päivämäärä jos saatavilla.

## NormalizedTransaction

NormalizedTransaction on sovelluksen sisäinen yhtenäinen tapahtumamalli.
Se sisältää tapahtumapäivän, kirjauspäivän jos erikseen, summan EUR valuutassa, vastapuolen nimen, kuvauksen, tilin tunnisteen ja viitteen lähteeseen.
Se sisältää linkin RawTransactioniin auditointia varten.
Summan etumerkki määrittää suunnan: negatiivinen = meno, positiivinen = tulo.

## TransactionGroup

TransactionGroup kokoaa yhteen päällekkäiset tapahtumat (deduplikointi).
Yksi group edustaa samaa tapahtumaa useissa importeissa, eikä sisällä siirtolinkitystä.
Raportointi käyttää groupin "kanonista" tapahtumaa tai groupin aggregoitua näkymää.

## TransferLink

TransferLink yhdistää kahden tilin välisen siirron.
Se sisältää linkit molempiin NormalizedTransaction riveihin sekä varmuusluokan.
TransferLink ei ole TransactionGroupin alityyppi, vaan erillinen linkki kahden tapahtuman välillä.

## Account ja HouseholdMember

Account kuvaa tiliä ja sen tyyppiä, kuten käyttötili, säästötili, luottokortti. Käyttäjä voi nimetä tilin uudelleen UI:ssa.
HouseholdMember kuvaa omistajaa.

## Category ja CategorizationDecision

Category on käyttäjän luoma tai oletuskategoria.
CategorizationDecision tallentaa tapahtumalle valitun kategorian ja lähteen, joka voi olla sääntö, AI ehdotus tai käyttäjän päätös.

## CategoryRule

CategoryRule on oppiva sääntö, joka syntyy AI- tai käyttäjäpäätöksestä (pattern counterparty/description -> kategoria, match_field, priority).

## ClarificationTicket

ClarificationTicket on sisäinen tiketöinti epäselville tapahtumille tai ryhmille.
Ticket sisältää kysymyksen, AI ehdotukset, käyttäjän vastauksen ja vaikutuksen sääntöihin,
sekä tilan (avoin, ratkaistu, ohitettu).

## BalanceSnapshot ja BalanceAdjustment

BalanceSnapshot tallentaa exportista löydetyn saldon; yksi rivi per tili per päivä (uusin korvaa vanhan).
BalanceAdjustment on käyttäjän tekemä saldokorjaus, jos data on puutteellinen tai saldo ei täsmää.
BalanceAdjustment on tarkoituksella yksinkertainen: se on "nollausmerkintä", joka korjaa erotuksen
siitä päivästä eteenpäin ilman että yksittäisiä tapahtumia muutetaan.
