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
