REQUIREMENTS.md
# Vaatimukset

## Toiminnalliset vaatimukset

Sovellus tukee CSV ja XLSX importteja.
Sovellus tukee useita tilejä ja tileihin liitettävät omistajat, kuten puoliso ja luottokortit.
Sovellus tunnistaa tilien väliset siirrot ja esittää ne järkevästi.
Sovellus tunnistaa päällekkäiset importit ja deduplikoi tapahtumat loogisesti ilman datan hävittämistä.
Sovellus kategorisoi tapahtumat, ja käyttäjä voi korjata kategorian.
Sovellus tallentaa käyttäjän selvennykset ja käyttää niitä tulevassa luokittelussa.
Sovellus tuottaa kuukausinäkymät, trendit, poikkeamat, toistuvuudet ja kausivaihtelut.
Sovellus tuottaa ennusteen ja “kehityssuunta” näkymän.
Sovellus tukee saldoa jos se on exportissa, ja mahdollistaa saldokorjaukset.

## Ei toiminnalliset vaatimukset

Sovellus toimii työpöydän selaimella.
Sovellus toimii kokonaan paikallisesti, pois lukien OpenAI API kutsut.
Sovelluksen tulee kestää kasvava datamäärä vuosien tapahtumiin asti.

## Data ja yksityisyys

OpenAI:lle lähetetään tapahtumista vain tarpeelliset kentät analyysin ja luokittelun kannalta.
Sovellus säilyttää raakadatan auditointia varten.
