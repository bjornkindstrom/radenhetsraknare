# Radenhetsräknare

Realtidsräknare för radenheter i produktionen. Per **linje** (flöde) och **skift** registreras färdigställda radenheter för vald **maskintyp** (t.ex. TPV, TPT, TPL) och **storlek**. Data sparas i Postgres och alla skärmar hålls i synk.

## Så används den

1. Välj **linje** och **skift** uppe till höger.
2. Skriv in **sekvensnumret** (fältet är markerat direkt), välj **maskintyp** och **storlek** och tryck **Starta räknaren**. Ingen maskin är förvald.
3. Räkna med **+1** och **−1**. Mellanslag ger +1 och `-` tar bort en. Räknaren visar t.ex. `7/12`, eftersom storleken är antalet radenheter i sekvensen.
4. När sista radenheten är räknad blir sekvensen klar automatiskt och rutan **Nästa sekvens** visas. Där finns **Ångra senaste** om sista trycket blev fel.
5. **Avsluta tidigt** avslutar en sekvens innan alla radenheter är gjorda.
6. **Nollställ inför nytt skift** avslutar skiftet. Historiken sparas och nästa skift börjar på 0 med samma mål.

## Funktioner

- **Tid per enhet**: effektiv tid sedan körningen startade (minus raster) delad med antal enheter
- **Effektiv tid** och **beräknad klar-tid** för skiftmålet, där kommande raster räknas in
- Under en rast visas "Rast till HH:MM" och tiden räknas inte
- Lista över skiftets körningar med sekvensnr, maskin, antal och tid per enhet, plus en aktivitetslogg
- **Inställningar** (kod: `rowunit`): maskintyper och storlekar, raster per skift samt linjer.
  Koden kontrolleras även av servern och kan bytas med miljövariabeln `SETTINGS_CODE` i Render.
- Ljud av/på, ljust/mörkt läge och synk mellan skärmar var 5:e sekund

Första gången skapas *Linje 1 (Huvudflöde)*, *Linje 2*, maskinerna TPV, TPT och TPL med storlekarna 6, 12 och 16 samt exempelraster. Exempelrasterna är Förmiddag 09:00–09:15 och 11:30–12:00, Eftermiddag 17:00–17:15 och 19:00–19:30 samt Natt 01:00–01:30 och 03:30–03:45.

## Driftsätt på Render

1. Gå till [Render Dashboard](https://dashboard.render.com) och välj **New** → **Blueprint**.
2. Välj det här repot och klicka **Apply**. Render skapar webbtjänsten `radenhetsraknare` och databasen `radenhetsraknare-db`.
3. Öppna tjänstens adress.

> Free-planen: webbtjänsten somnar efter inaktivitet (första anropet tar 30–60 s), och free-databasen raderas efter 30 dagar. Byt `plan` i `render.yaml` för produktion.

## API

Ändringar av linjer, maskintyper och raster kräver headern `x-installningskod`.

| Metod | Sökväg | Beskrivning |
|---|---|---|
| `GET` | `/api/config` | Linjer, maskintyper, skiftnamn och raster |
| `GET` | `/api/skift?linje=1&skift=Förmiddag` | Aktivt skift med pågående körning, körningar och logg |
| `POST` | `/api/skift/:id/korningar` | Starta körning `{"typ":"TPV","storlek":12,"sekvensnr":"S-1234"}` |
| `POST` | `/api/korningar/:id/avsluta` | Avsluta körning tidigt (den avslutas automatiskt när antal = storlek) |
| `POST` | `/api/korningar/:id/angra` | Öppna senaste klara sekvens igen och ta bort en radenhet |
| `POST` | `/api/skift/:id/handelser` | Registrera på pågående körning `{"antal":1}` (negativt tar bort) |
| `PATCH` | `/api/skift/:id` | Sätt mål `{"mal":40}` |
| `POST` | `/api/skift/:id/nytt` | Avsluta skiftet och starta ett nytt |
| `POST`/`DELETE` | `/api/raster[/:id]` | Hantera raster `{"skift":"Förmiddag","start":"09:00","slut":"09:15"}` |
| `POST`/`PATCH`/`DELETE` | `/api/linjer[/:id]` | Hantera linjer |
| `POST`/`DELETE` | `/api/maskintyper[/:namn]`, `/api/maskintyper/:namn/storlekar[/:storlek]` | Hantera maskiner |

## Köra lokalt

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/radenhet npm start
```

Sätt `PGSSL=true` om du ansluter till en databas som kräver SSL (t.ex. Renders externa URL).
