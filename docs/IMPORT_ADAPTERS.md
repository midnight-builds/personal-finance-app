IMPORT_ADAPTERS.md
# Import adapterit

## Tavoite

Adapteri muuntaa pankkikohtaisen CSV tai XLSX exportin RawTransaction riveiksi. Adapteri ei tee analyysiä.

## Ensimmäinen pankki

Käyttäjä toimittaa CSV ja XLSX mallit. Codex toteuttaa mappingin niiden mukaan ja lisää testidatan.
Nordea-esimerkkien perusteella CSV sarakkeet ovat:
Kirjauspäivä, Määrä, Maksaja, Maksunsaaja, Nimi, Otsikko, Viesti, Viitenumero, Saldo, Valuutta.
Kirjauspäivä voi sisältää arvon "Varaus" (varaustila), ja desimaalit ovat pilkulla.

## Laajennus

Uuden pankin lisääminen tehdään uutena adapterina ja tarvittaessa uudella kenttämappauksella.

## Tuonnin esikatselu ja kohdetili

Tuonti on kaksivaiheinen (`apps/api/src/importPreview.ts`, `apps/web/src/components/ImportDialog.tsx`,
sopimus `packages/shared/src/importPreview.ts`):

1. `POST /imports/nordea/preview` (multipart: `file`, valinnainen `accountId` tai `asNewAccount=1`)
   ei kirjoita mitään. Se palauttaa tiedoston yhteenvedon (päivät, rivit, varaukset, oma IBAN,
   nimiehdotus), kaikki tilit, **arvauksen** kohdetilistä ja analyysin valitulle kohteelle.
   - Arvaus: oma IBAN (rivien maksaja/saaja-puoli, sitten tiedostonimi) täsmää tiliin → `iban`.
     Ilman IBANia (luottokortti) → IBANittoman tilin, jonka rivejä tiedosto toistaa eniten
     (yli puolet tilin riveistä tiedoston aikavälillä; tasapeli → ei arvausta) → `overlap`.
     Muuten `none` ja uuden tilin ehdotus (ei IBANia → luottokortti, nimessä "säästö" → säästötili).
   - Päällekkäiset ja siirrot lasketaan **kuivaharjoituksella**: oikea tuontiputki ajetaan
     transaktiossa, joka perutaan (`ROLLBACK`). Luvut ovat siksi täsmälleen ne, jotka tuonti tekee.
     Tapahtumalokiin ei kirjoiteta, eikä briiffiä, toistuvuuksia tai AI-sääntöehdotuksia ajeta.
   - Aukot tilin aiempiin tietoihin (`gapBefore`/`gapAfter`), hiljaiset jaksot (≥ 14 päivää ilman
     rivejä), saldokatkot (edellisen päivän saldo + päivän summat ≠ päivän viimeisen rivin Saldo),
     alkusaldon ristiriita tilin saldoon edellisenä päivänä ja IBAN-ristiriita.
2. `POST /imports/nordea/csv|xlsx` ottaa valinnan: `accountId` (olemassa oleva tili, nimeä tai
   IBANia ei muuteta; tuntematon → 404) tai `newAccountName` + `newAccountSubtype`
   (`checking`/`savings`/`credit_card`; varattu nimi → 409; IBAN tiedostosta, jos se on vapaa).
   Ilman valintaa tili päätellään IBANista kuten ennen, mutta jos IBANia ei löydy, vastaus on
   400 `account_required` — IBANittomat tiedostot eivät enää valu yhteiselle "Nordea tili" -tilille,
   joten kaksi luottokorttia ei voi sekoittua.

UI: käyttäjä valitsee yhden tai useamman tiedoston, ja jokainen käydään läpi vuorollaan:
esikatselu, arvaus ja sen syy, tilin valinta (tai "Uusi tili…"), vahvistus. Seuraavan tiedoston
esikatselu haetaan edellisen tuonnin jälkeen, joten päällekkäisyysluvut ovat ajan tasalla.
