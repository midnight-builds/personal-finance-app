PIPELINE.md
# Pipeline

Pipeline on deterministinen, ja AI kutsut tehdään vain tietyissä kohdissa.

## Vaiheet

Tiedoston lataus luo ImportSessionin.

Adapteri parsii rivit RawTransaction muotoon.

Normalisointi muuntaa RawTransactionit NormalizedTransaction muotoon.

Deduplikointi muodostaa TransactionGroupit ja merkitsee päällekkäisyydet.

Siirtolinkitys muodostaa TransferLinkit.

Saldo tallennetaan BalanceSnapshotiksi, jos exportissa on saldo ja päivämäärä.

Kategorisointi ajaa sääntömoottorin ja heuristiikat; tarvittaessa pyydetään OpenAI-ehdotus (gpt-4o-mini). Käyttäjän päätökset luovat CategoryRulen.
Epävarmat voivat jatkossa luoda ClarificationTicketin (ei vielä toteutettu).

Insightit ajetaan ryhmittäin. Ne tuottavat havainto-objekteja, joihin linkitetään tapahtumat.

Ennuste laskee tulevan nettokehityksen, toistuvat tapahtumat ja kausikomponentit.

Kuukausikatsaus laskee per-kk tulot, menot ja neton (siirrot poissa).

## Päällekkäisyysperiaate

Dataa ei koskaan poisteta. Päällekkäisyys merkitään ja ryhmitellään.
Import overlap ratkaistaan yksinkertaisesti: jos ImportSessionin overlap-avain täsmää,
uusi importti merkitään päällekkäiseksi ja sen NormalizedTransactionit linkitetään samaan TransactionGroupiin.
UI voi tarjota käyttäjälle valinnan jättää päällekkäinen importti huomiotta.

## Siirtojen käsittely raporteissa

Raporteissa on näkymä jossa siirrot eivät vaikuta kokonaiskulutukseen.
Lisäksi on näkymä jossa siirrot näkyvät tileittäin.
Netto- ja insight-laskennassa siirrot rajataan pois oletuksena.

## Negatiivinen tulo

Jos tapahtuma näyttää tulolta mutta summan etumerkki on negatiivinen, se käsitellään yksinkertaisesti
tulon oikaisuna ja ohjataan "Palautukset ja hyvitykset" -kategoriaan, ellei käyttäjä päätä muuta.
