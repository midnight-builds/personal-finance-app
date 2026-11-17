PIPELINE.md
# Pipeline

Pipeline on deterministinen, ja AI kutsut tehdään vain tietyissä kohdissa.

## Vaiheet

Tiedoston lataus luo ImportSessionin.

Adapteri parsii rivit RawTransaction muotoon.

Normalisointi muuntaa rivit NormalizedTransaction muotoon. Rivi, joka tilillä jo on
(deduplikointi, ks. alla), ohitetaan: siitä ei tallenneta RawTransactionia eikä
NormalizedTransactionia.

Siirtolinkitys muodostaa TransferLinkit tallennetuista uusista riveistä.

Saldo tallennetaan BalanceSnapshotiksi, jos exportissa on saldo ja päivämäärä.

Kategorisointi ajaa sääntömoottorin ja heuristiikat; tarvittaessa pyydetään OpenAI-ehdotus (gpt-4o-mini). Käyttäjän päätökset luovat CategoryRulen.
Epävarmat voivat jatkossa luoda ClarificationTicketin (ei vielä toteutettu).

Insightit ajetaan ryhmittäin. Ne tuottavat havainto-objekteja, joihin linkitetään tapahtumat.

Ennuste laskee tulevan nettokehityksen, toistuvat tapahtumat ja kausikomponentit.

Kuukausikatsaus laskee per-kk tulot, menot ja neton (siirrot poissa).

## Päällekkäisyysperiaate

Tapahtuma tallennetaan kerran. Importin rivi, jolla on sama tili, kirjauspäivä, summa ja
vastapuoli (puuttuva vastapuoli täsmää puuttuvaan) kuin aiemman importin tallennetulla
rivillä, on duplikaatti eikä sitä tallenneta. Rivit paritetaan yksi yhteen: jos tiedostossa
on kolme samanlaista riviä ja tilillä kaksi, tallennetaan yksi. Saman tiedoston samanlaisia
rivejä ei verrata toisiinsa (kaksi samanlaista kahvia samana päivänä ovat kaksi tapahtumaa).
Varausrivit (ei kirjauspäivää) ks. alla. ImportSession tallennetaan aina;
`duplicateCount` kertoo ohitetut rivit ja `overlap` niiden päivävälin. Tiedoston saldot
luetaan kaikista sen riveistä, myös ohitetuista.

Jos ImportSessionin overlap-avain (tiedoston tarkiste, rivimäärä ja tili) täsmää,
importti merkitään samaksi tiedostoksi (`overlapDetected`, `alreadyImportedCount`).

XLSX- ja CSV-export samasta tilistä tuottavat samat rivit: XLSX luetaan solujen
arvoina (päivä- ja summasolut eivät muutu kirjoittajan lokaalin tekstiksi, kuten
"3/5/26" tai "-12.5"), sarakkeiden nimet verrataan ilman ylimääräisiä välilyöntejä,
BOMia tai hajotettuja ääkkösiä, ja numeroina tallennetut tekstisolut (esim. viesti)
luetaan tekstinä. Summa- ja päivätulkinta on normalisoinnissa (`parseAmount`,
`parseDate`), ei adaptereissa.

## Varausrivit

Varaus on yksi tapahtuma varauksesta kirjaukseen (`GLOSSARY.md`, "Pending row").
Tuonti päättää ennen kirjoittamista jokaisen rivin kohtalon (`planRows` tiedostossa
`apps/api/src/importer.ts`):

1. Kirjattu rivi, joka tilillä jo on: duplikaatti.
2. Varausrivi, joka tilillä jo on varauksena (sama summa ja vastapuoli, nähty
   viimeksi enintään 35 päivää sitten): ei tallenneta uudelleen.
3. Muu kirjattu rivi voi olla tallennetun varauksen kirjaus: sama summa ja
   vastapuoli, kirjauspäivä aikaisintaan 3 päivää ennen varauksen ensimmäistä
   exporttia ja enintään 35 päivää viimeisimmän jälkeen. Varaus muuttuu kirjatuksi
   paikallaan (sama id, kategoriat ja linkit säilyvät). Useasta ehdokkaasta
   vanhin varaus ensin, kirjaukset päiväjärjestyksessä, yksi yhteen.
4. Muu rivi on uusi.

Varaus, jota uudempi saman jakson export ei listaa varauksena eikä kirjattuna,
merkitään mitätöidyksi (`void`): sitä ei poisteta, mutta se ei näy listoissa,
raporteissa eikä kategorisoinnissa. Kirjattu rivi pariutuu vain tallennettuun
varaukseen, jota mikään raportti ei laske, joten kaksi laskettua tapahtumaa ei
voi koskaan yhdistyä. Ennen tätä tallennetut varaukset saavat elinkaaririvin
käynnistyessä; aiempien tuontien tallentamat varauskopiot paritetaan seuraavan
ajantasaisen exportin varauksiin, ja ylimääräiset mitätöityvät silloin.

Ennen tätä sääntöä tallennetut kopiot (TransactionGroup) yhdistetään API:n käynnistyessä
kerran ryhmän ensin tuotuun riviin (`apps/api/src/migrations/collapseDuplicates.ts`).

## Siirtojen käsittely raporteissa

Raporteissa on näkymä jossa siirrot eivät vaikuta kokonaiskulutukseen.
Lisäksi on näkymä jossa siirrot näkyvät tileittäin.
Netto- ja insight-laskennassa siirrot rajataan pois oletuksena.

## Negatiivinen tulo

Jos tapahtuma näyttää tulolta mutta summan etumerkki on negatiivinen, se käsitellään yksinkertaisesti
tulon oikaisuna ja ohjataan "Palautukset ja hyvitykset" -kategoriaan, ellei käyttäjä päätä muuta.
