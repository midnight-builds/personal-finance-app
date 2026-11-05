# Agents ja työskentelymalli

Tämä projekti toteutetaan siten, että Codex CLI voi rakentaa koko sovelluksen vaiheittain. Jokainen vaihe päättyy ajettavaan ja testattuun kokonaisuuteen.

## Ylätason agentti

Ylätason agentin tavoite on pitää kokonaisuus kasassa. Se ylläpitää arkkitehtuuria, datamallia ja pipelinea, sekä päättää missä kohtaa käytetään OpenAI API:a.

Ylätason agentti ohjaa toteutuksen seuraavalla tavalla.
Se pilkkoo työn pieniin, hyväksymiskriteereillä varustettuihin tehtäviin.
Se pitää rajapinnat vakaina, erityisesti NormalizedTransaction mallin ja analyysitulosten JSON skeemat.
Se varmistaa että jokaisessa vaiheessa on vähintään yksi end to end polku importista UI näkymään.

## Alagentit

### Backend agentti
Backend agentti toteuttaa ingestoinnin, normalisoinnin, deduplikoinnin, siirtolinkityksen, kategorisoinnin, analyysit ja ennusteen. Se rakentaa myös API:t frontendille.

### Frontend agentti
Frontend agentti toteuttaa web UI:n. Aluksi työpöytäkäyttö riittää. Se näyttää importin, tapahtumat, kategoriat, selvennykset, insightit ja ennusteen.

### Data ja testaus agentti
Tämä agentti rakentaa testidatan rungon ja testit. Se tekee golden file testit pankkikohtaisille adaptereille ja varmistaa deduplikoinnin ja siirtolinkityksen.

### AI integraatio agentti
Tämä agentti toteuttaa OpenAI Responses API integraation. Se pakottaa ulostulon JSON skeemaan ja tuottaa selvennyskysymykset ja kategorisointiehdotukset.

## Data ja ympäristöt

Kehitys ja agentit käyttävät vain demokantaa (`npm run dev`), testit muistikantaa. Oikea data
(`~/finance-app-data/finance.db`) on vain tuotannon palveluiden ja MCP:n käytössä. Oikeaa
dataa tutkitaan vain varmuuskopion kopiosta. Ks. `docs/ENVIRONMENTS.md`.

## Työjärjestys

Ensimmäinen tavoite on saada yksi pankki sisään CSV ja XLSX formaateissa, normalisoituna tietokantaan ja näkyviin UI:ssa.

Sen jälkeen tehdään deduplikointi ja siirtolinkitys, koska ne vaikuttavat kaikkiin myöhempiin analyyseihin.

Kolmantena tehdään kategorisoinnin perusrunko ja käyttäjän selvennykset, koska se tuottaa oppivaa dataa.

Neljäs vaihe tuo insightit ja ennusteen.

## Definition of done

Koodi on ajettavissa yhdellä komennolla.
Backendissä on testit kriittisille muunnoksille ja tunnistuksille.
UI:ssa voi tuoda datan sisään ja nähdä ainakin perustason näkymät.
AI kutsut ovat erillisessä kerroksessa ja niiden output validoidaan skeemaa vasten.
Muutokset eivät riko aiempia vaiheita.

## Turvallisuus ja yksityisyys

Sovellus on henkilökohtainen ja pyörii sisäverkossa. Turvallisuus ei ole ensimmäinen prioriteetti, mutta perusasiat pidetään kunnossa.
API avaimet eivät mene repoon.
OpenAI:lle lähetetään vain se mikä on analyysin kannalta tarpeellista.

## Käyttöympäristö

Sovellus ajetaan paikallisesti. Web käyttöliittymä toimii työpöydällä.

## Kieli

Vastauksissa, todo listoissa, chatissa ja sovelluksen sisällä käytetään Suomea.
Koodin sisällä kommenteissa ja muuttujien nimissä käytetään Englantia.
