
# Visio ja tavoite

Sovellus on kotitalouden talousanalytiikan työkalu. Se ottaa sisään useiden pankkien ja luottokorttien tilitapahtumaexportteja eri muodoissa, yhdistää ne yhteen malliin, poistaa päällekkäisyyksiä, tunnistaa tilisiirrot, luokittelee tapahtumat ja tuottaa analyysiä sekä ennustetta.

## Päätavoitteet

Sovellus näyttää menot ja tulot selkeästi ja tarjoaa visualisointeja.
Sovellus löytää epäselvät tapahtumat ja pyytää käyttäjältä selvennyksen.
Sovellus tunnistaa kuukausittain ja vuosittain toistuvat tapahtumat sekä kausipiikit kuten tammikuun suuret laskut.
Sovellus nostaa esiin poikkeamat ja huonot kulutustottumukset ja antaa suosituksia.
Sovellus ennustaa tulevaa ja arvioi kehityssuuntaa, myös varoitukset jos suunta näyttää huolestuttavalta.

## Rajaukset

Sovellus ei tarvitse käteistapahtumien automaattista ymmärrystä.
Valuuttana riittää EUR.
Ensimmäisessä versiossa tuetaan yksi pankki, mutta arkkitehtuuri tukee useita.

## Käyttömalli

Sovellus on henkilökohtainen ja pyörii sisäverkossa.
Analyysissä käytetään OpenAI API:a, mutta muu laskenta tehdään paikallisesti.
