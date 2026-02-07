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
