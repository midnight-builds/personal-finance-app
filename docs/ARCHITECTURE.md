ARCHITECTURE.md
# Arkkitehtuuri

Sovellus on jaettu backend-palveluun (Node.js + TypeScript + Fastify) ja web-käyttöliittymään (React + Vite).
Tietokantana on paikallinen SQLite (node:sqlite), joka säilyttää raakadatan, normalisoidut tapahtumat, kategoriat, säännöt, siirtolinkit ja saldot.
Backend tarjoaa REST API:t importille, tapahtumille, kategorioille, saldo- ja kuukausiyhteenvedoille sekä AI-kategoriasuosituksille.
Frontend tarjoaa import-näkymän, tapahtumalistan, kategorioiden valinnan/AI-ehdotukset, tilien uudelleennimeämisen, insightit, saldon ja kuukausikatsauksen.

## Kerrokset

Adapterikerros lukee pankkikohtaiset CSV ja XLSX exportit ja tuottaa raakatapahtumat.

Normalisointikerros muuntaa raakatapahtumat sisäiseen NormalizedTransaction malliin.

Linkitys- ja deduplikointikerros yhdistää päällekkäiset tapahtumat ja tunnistaa tilisiirtoparit.

Kategorisointikerros päättää kategorian sääntöjen, käyttäjän aiempien päätösten, heuristiikoiden ja tarvittaessa OpenAI-ehdotusten avulla (gpt-4o-mini).

Insight ja forecast kerros tuottaa analyysit ja ennusteet. AI:ta käytetään vain ehdottamiseen ja selitystekstien tuottamiseen.

## Plug-in periaate pankeille

Jokainen pankki toteutetaan omana adapterinaan. Adapteri ei tee analyysiä, vain parsimisen ja kenttien perusmapituksen.

## Paketit

| Paketti | Sisältö |
|---------|---------|
| `packages/shared` | Yhteiset sopimukset (zod-skeemat ja tyypit) ja tietosuoja-apurit (`redactDeep`). Käytössä API:ssa, MCP:ssä ja webissä, joten skeema määritellään vain kerran. |
| `apps/api` | REST API ja tietokanta |
| `apps/mcp` | MCP-palvelin ulkoisille agenteille, ks. `docs/MCP.md` |
| `apps/web` | Käyttöliittymä |

## Uudet API-reitit

Uudet reitit tehdään Fastify-plugineina hakemistoon `apps/api/src/routes/` ja lisätään `routes/index.ts`:ään.
Palvelukerros heittää `DomainError`in (esim. `not_found`, `already_resolved`) tai `ZodError`in, ja yhteinen virheenkäsittelijä muuntaa ne vastaukseksi `{ error, details? }`.
Kyselyparametrit jäsennetään `queryParser(shape)`:n palauttamalla jäsentimellä samaa skeemaa vasten kuin MCP-työkalut; tukematon kenttätyyppi kaatuu jo käynnistyksessä.
Vanhat reitit `index.ts`:ssä toimivat ennallaan, ja niitä voi siirtää plugineiksi vähitellen.
