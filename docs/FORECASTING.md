FORECASTING.md
# Ennuste ja kehityssuunta

Ennuste tehdään paikallisesti ja se on summittainen arvio, ei primäärifunktio.

## Tasot

Perustaso laskee nettokehityksen per kuukausi.

Toistuvuusmalli projisoi kuukausittaiset ja vuosittaiset tapahtumat tulevaisuuteen.

Kausikomponentti huomioi kuukausittaiset piikit, kuten tammikuu.

## Kehityssuunnan tulkinta

UI näyttää ollaanko vaurastumassa vai köyhtymässä.
UI näyttää myös varoituksen, jos ennuste kertoo jatkuvasta negatiivisesta nettovirrasta ja runway on lyhyt.

Runway lasketaan likvidistä saldosta ja ennustetusta netosta, huomioiden suurimmat tunnetut kausipiikit.
Ennusteeseen liitetään selitys siitä, että se on karkea ja voi poiketa toteumasta.

## Kiinteät menot ja epävarmat toistuvat maksut

Kuukausi- ja viikkokuviot (`recurring_patterns`) saavat tunnistuksessa
varmuusarvon `confidence` (0–1, kaava: GLOSSARY.md, "Confidence"):
veloitusten määrä, välien säännöllisyys ja summan vakaus. Käyttäjä tai agentti
voi vahvistaa kuvion toistuvaksi tai tilaukseksi tai hylätä sen
(`POST /patterns/:id/decision`); päätös säilyy uudelleentunnistuksessa.

`GET /forecast` erottelee kuukauden kuviot (kenttiä vain lisätty):

| Kenttä | Sisältö |
|--------|---------|
| `knownFixed`, `knownFixedTotal` | Vakiintuneet kuviot: vahvistetut, tai vahvistamattomat joiden varmuus ≥ 0,75 |
| `uncertainRecurring`, `uncertainRecurringTotal` | Vahvistamattomat kuviot, varmuus < 0,75 |
| `projectedTotal` | max(`historicalAvg`, `knownFixedTotal`) + vuosimaksut; epävarmat eivät nosta sitä |
| `projectedTotalWithUncertain` | Sama, jos kaikki epävarmat olisivat kiinteitä menoja |
| `lapsedRecurring` | Pysähtyneet kuviot (`lapsed: true`, `lapsedSince`): ei mukana missään summassa |

Hylätty kuvio ei ole kummassakaan. Muutos aiempaan: `knownFixed` sisälsi
kaikki aktiiviset kuviot; nyt epävarmat ovat erikseen, joten `projectedTotal`
voi laskea, kun historiaa samalta kuukaudelta ei ole ja kiinteät menot
olivat ennusteen pohja. Kuukausittainen tilaussumma (`/household/summary`,
`monthlySubscriptions`) ja tilauspalveluhavainto laskevat vain vakiintuneet
tilaukset; `/subscriptions` listaa samat.

Epävarmat kuviot (ei päätöstä, varmuus < 0,75) kysytään käyttäjältä ("Onko
tämä toistuva?", GLOSSARY.md "Recurring question"): `GET /patterns/questions`
palauttaa ne todisteineen (veloitukset, päivät, summat), ja briefing näyttää
kolme suurinta kysymyskorttina. Vakiintunutta kuviota ei kysytä, mutta
käyttäjä tai agentti voi silti hylätä tai luokitella sen.

## Luodut kuviot

Käyttäjä tai agentti voi luoda kuukausi- tai viikkokuvion, jota tunnistus ei
ole ehdottanut (`POST /patterns`, MCP `create_recurring_pattern`; GLOSSARY.md
"Created pattern"), esimerkiksi juuri alkaneen sopimuksen. Yksi veloitus riittää
todisteeksi. Kuvio (`origin: created`) on heti vahvistettu tekijänsä
päätöksellä, joten ennuste (`knownFixed`), kuukausittainen tilaussumma ja
tilauspalveluhavainto laskevat sen kuten minkä tahansa vahvistetun kuvion
(kunnes se pysähtyy, ks. alla);
ennusteen kohteessa on `origin`. Summa on luojan antama odotettu summa; uusi
luontipyyntö samalle vastapuolelle päivittää sen (esim. hinnanmuutos).

Uudelleentunnistus ei koskaan poista, muuta tai kahdenna luotua kuviota:
myöhemmät saman vastapuolen veloitukset (±20 % odotetusta summasta, yksi per
jakso) liittyvät siihen, ja jos tunnistus löytää saman kuvion, kuvio pysyy
yhtenä, joten se on ennusteessa täsmälleen kerran. Luotu kuvio pysyy
aktiivisena myös veloitusten loputtua, kunnes joku hylkää sen, mutta se
pysähtyy (alla) eikä silloin ole missään summassa. Hylätty luotu
kuvio jää pois kuten muutkin. `reset` vetää luodun kuvion pois: se ei ole
ennusteessa (ei myöskään epävarmoissa), ellei sen omien veloitusten varmuus ole
vähintään 0,75, ja tunnistus käsittelee sitä kuten omaansa (löytäessään se
muuttuu tunnistetuksi, veloitusten loputtua se poistuu käytöstä).

## Pysähtyneet kuviot

Kuukausi- tai viikkokuvio, tunnistettu tai luotu, **pysähtyy** (`lapsed`,
GLOSSARY.md "Lapsed pattern"), kun vastapuolelta ei ole tullut veloitusta kahteen
jaksoon: tilin viimeisin kirjaus (ei tämä päivä, joten jäljessä oleva vienti ei
pysäytä mitään) on vähintään 2 × 31 + 5 = 67 päivää (viikkokuvio 2 × 7 + 3 = 17)
viimeisimmän veloituksen jälkeen. Veloitukseksi käy mikä tahansa vastapuolen
laskettava meno, joka ei ole siirto, summasta riippumatta, joten hinnanmuutos ei
pysäytä elävää kuviota. Pysähtynyt kuvio säilyy päätöshistorioineen ja näkyy
`/recurring`-listassa (`lapsed: true`, `lapsed_since`) sekä ennusteen
`lapsedRecurring`-listassa, mutta se ei ole `knownFixed`- eikä
`uncertainRecurring`-listassa, kuukausittaisessa tilaussummassa eikä
tilauspalveluhavainnossa, eikä siitä kysytä. Seuraava veloitus palauttaa sen
laskentaan automaattisesti (tunnistus ajetaan jokaisen tuonnin jälkeen).
Jos lasku siirtyy toiselle tilille tai vastapuolen nimi muuttuu, vanha kuvio
pysähtyy ja uusi lasketaan vasta kun se tunnistetaan (kolme veloitusta) tai
luodaan. Toisaalta peruttu tilaus ei pysähdy, jos samalta vastapuolelta ostetaan
muuta; se hylätään päätöksellä.

Ennen tätä luotu kuvio laski ennusteessa ikuisesti, ja tunnistettu kuvio vasta
kun 180 päivän ikkunassa oli alle kolme veloitusta (kuukausikuviolla noin neljä
kuukautta, viikkokuviolla lähes puoli vuotta veloitusten loputtua).

## Viikkokuviot

Ennuste on kalenterikuukausittainen, joten viikkokuvio lasketaan niin monena
veloituksena kuin kohdekuukauteen osuu odotettuja veloituspäiviä: päivät, jotka
ovat kokonaisen viikkomäärän päässä viimeisimmästä veloituksesta (4 tai 5).
Kohteessa `chargesInMonth` kertoo määrän ja `amount` on kuukauden summa.
Kuukausittainen tilaussumma ja tilauspalveluhavainto ovat "/kk"-lukuja ilman
kalenterikuukautta, joten niissä viikkotilaus on 52/12 veloitusta
(`monthly_amount`).
