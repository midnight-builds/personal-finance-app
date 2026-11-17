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

Epävarmat ja kiinteän summan kuviot kysytään käyttäjältä ("Onko tämä
toistuva?", GLOSSARY.md "Recurring question"): `GET /patterns/questions`
palauttaa ne todisteineen (veloitukset, päivät, summat), ja briefing näyttää
kolme suurinta kysymyskorttina.
