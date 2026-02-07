IMPLEMENTATION_PLAN.md
# Toteutussuunnitelma vaiheittain

**Valmis:** Vaihe 1  
- Repo, Fastify+TS backend, React+Vite frontend, SQLite tietokanta.  
- Yksi pankki (Nordea) CSV/XLSX import, Raw/Normalized talteen.  
- UI: import ja tapahtumalista.

**Valmis:** Vaihe 2  
- Deduplikointi (päivä+summa+vastapuoli), TransactionGroup.  
- Tilisiirtolinkitys, siirtosuodatus UI:ssa, siirrot pois netto/insights-laskennasta.

**Valmis:** Vaihe 3 (perus)  
- Kategoriat, oletuslista, sääntömoottori + heuristiikat.  
- AI-kategoriasuositus (gpt-4o-mini), käyttäjän päätökset luovat CategoryRulen.  
- Kategoriavalinta UI:ssa + AI-nappi, debug-tyhjennykset, tilien uudelleennimeäminen.

**Käynnissä:** Vaihe 4 (osa toteutettu)  
- Insightit: toistuvat pienet ostot, nousevat kulukategoriat.  
- Saldo- ja kuukausiyhteenvedot, siirrot pois netto-luvuista.  
- Toistuvuuden tunnistus (kuukausittaiset vastapuoli+summa) merkitty riveille.
- Seuraavaksi: tarkempi toistuvuus (päivittäinen vs. kuukausi), ennusteen perusrakenne (runway+kausipiikit).

**Tulossa:** Vaihe 5  
- Export/backup, asetukset (API-avaimet, valuutta-asetukset).  
- ClarificationTicket UI, insightien laajennus, ennusteen kausikomponentti ja visualisointi.
