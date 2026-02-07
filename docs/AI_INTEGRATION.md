AI_INTEGRATION.md
# OpenAI integraatio

OpenAI API:ta käytetään analyysin tukena, ei peruslaskennan korvaajana.

## Käyttökohteet

Tapahtuman kategorian ehdotus silloin kun sääntömoottori tai heuristiikka ei ole varma (gpt-4o-mini).
AI käyttää olemassa olevaa kategorialistaa ja voi ehdottaa uutta kategoriaa; UI valitsee automaattisesti parhaimman vaihtoehdon.
Muut AI-käytöt (selvennykset, insight-tekstit, vapaa kysely) ovat backlogissa.

## Rajoitukset

Muu laskenta tehdään paikallisesti.
OpenAI:lle lähetetään vastapuoli, kuvaus, summa ja valuutta. Käytetään Responses API:a (gpt-4o-mini) ja parsitaan JSON output_text.
Ulostulo tarkistetaan: mode = existing/new/options/none; categoryId hyväksytään vain nykyisestä listasta.

## Selvennysten tallennus

Käyttäjän valinnat tallennetaan CategorizationDecisioniin ja luovat CategoryRulen (pattern counterparty/description -> kategoria),
joten tulevat tapahtumat ohjautuvat tämän perusteella ilman että samaa kysytään uudelleen.
