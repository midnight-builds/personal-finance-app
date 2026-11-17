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
Varausrivejä (ei kirjauspäivää) ei deduplikoida. ImportSession tallennetaan aina;
`duplicateCount` kertoo ohitetut rivit ja `overlap` niiden päivävälin. Tiedoston saldot
luetaan kaikista sen riveistä, myös ohitetuista.

Jos ImportSessionin overlap-avain (tiedoston tarkiste, rivimäärä ja tili) täsmää,
importti merkitään samaksi tiedostoksi (`overlapDetected`, `alreadyImportedCount`).

Ennen tätä sääntöä tallennetut kopiot (TransactionGroup) yhdistetään API:n käynnistyessä
kerran ryhmän ensin tuotuun riviin (`apps/api/src/migrations/collapseDuplicates.ts`).

## Siirtojen käsittely raporteissa

Raporteissa on näkymä jossa siirrot eivät vaikuta kokonaiskulutukseen.
Lisäksi on näkymä jossa siirrot näkyvät tileittäin.
Netto- ja insight-laskennassa siirrot rajataan pois oletuksena.

## Negatiivinen tulo

Jos tapahtuma näyttää tulolta mutta summan etumerkki on negatiivinen, se käsitellään yksinkertaisesti
tulon oikaisuna ja ohjataan "Palautukset ja hyvitykset" -kategoriaan, ellei käyttäjä päätä muuta.
