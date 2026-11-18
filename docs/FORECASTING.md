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
tilauspalveluhavainto laskevat sen kuten minkä tahansa vahvistetun kuvion;
ennusteen kohteessa on `origin`. Summa on luojan antama odotettu summa; uusi
luontipyyntö samalle vastapuolelle päivittää sen (esim. hinnanmuutos).

Uudelleentunnistus ei koskaan poista, muuta tai kahdenna luotua kuviota:
myöhemmät saman vastapuolen veloitukset (±20 % odotetusta summasta, yksi per
jakso) liittyvät siihen, ja jos tunnistus löytää saman kuvion, kuvio pysyy
yhtenä, joten se on ennusteessa täsmälleen kerran. Siksi luotu kuvio pysyy
ennusteessa myös veloitusten loputtua, kunnes joku hylkää sen. Hylätty luotu
kuvio jää pois kuten muutkin. `reset` vetää luodun kuvion pois: se ei ole
ennusteessa (ei myöskään epävarmoissa), ellei sen omien veloitusten varmuus ole
vähintään 0,75, ja tunnistus käsittelee sitä kuten omaansa (löytäessään se
muuttuu tunnistetuksi, veloitusten loputtua se poistuu käytöstä).

Viikkokuvio lasketaan ennusteessa yhden veloituksen suuruisena kuukaudessa,
kuten tunnistetutkin viikkokuviot (ennallaan, avoin kysymys).
