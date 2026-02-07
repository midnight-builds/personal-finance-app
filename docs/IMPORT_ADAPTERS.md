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
