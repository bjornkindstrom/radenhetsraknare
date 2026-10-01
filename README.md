# Radenhetsräknare

Realtidsräknare för radenheter i produktionen. Per **linje** (flöde) och **skift** registreras färdigställda radenheter för vald **maskintyp** (t.ex. TPV, TPT, TPL) och **storlek**. Data sparas i Postgres och alla skärmar hålls i synk.

## Funktioner

- Stor räknare med **+1**, **+5** och **−1**. Mellanslag ger +1 och `-` tar bort en.
- Mål per skift med förloppsindikator, takt (enheter/h) och beräknad klar-tid
- Aktivitetslogg och fördelning per maskin för skiftet
- **Nollställ inför nytt skift**: det gamla skiftet sparas i databasen och ett nytt startar på 0 med samma mål.
- **Inställningar** (reglage-ikonen): lägg till och ta bort maskintyper och storlekar, lägg till, byt namn på och ta bort linjer
- Ljud av/på samt ljust/mörkt läge. Fungerar på dator, surfplatta och mobil.
- Skärmar som visar samma linje och skift uppdateras var 5:e sekund.

Första gången skapas *Linje 1 (Huvudflöde)*, *Linje 2* och maskintyperna TPV, TPT och TPL med storlekarna 6, 12 och 16. Allt kan ändras under Inställningar.

## Driftsätt på Render

1. Gå till [Render Dashboard](https://dashboard.render.com) och välj **New** → **Blueprint**.
2. Välj det här repot och klicka **Apply**. Render skapar webbtjänsten `radenhetsraknare` och databasen `radenhetsraknare-db`.
3. Öppna tjänstens adress.

> Free-planen: webbtjänsten somnar efter inaktivitet (första anropet tar 30–60 s), och free-databasen raderas efter 30 dagar. Byt `plan` i `render.yaml` för produktion.

## API

| Metod | Sökväg | Beskrivning |
|---|---|---|
| `GET` | `/api/config` | Linjer, maskintyper med storlekar och skiftnamn |
| `GET` | `/api/skift?linje=1&skift=Förmiddag` | Aktivt skift (skapas vid behov) med total, per maskin och logg |
| `POST` | `/api/skift/:id/handelser` | Registrera `{"typ":"TPV","storlek":12,"antal":1}` (negativt antal tar bort) |
| `PATCH` | `/api/skift/:id` | Sätt mål `{"mal":40}` |
| `POST` | `/api/skift/:id/nytt` | Avsluta skiftet och starta ett nytt |
| `POST`/`PATCH`/`DELETE` | `/api/linjer[/:id]` | Hantera linjer |
| `POST`/`DELETE` | `/api/maskintyper[/:namn]` | Hantera maskintyper |
| `POST`/`DELETE` | `/api/maskintyper/:namn/storlekar[/:storlek]` | Hantera storlekar |

## Köra lokalt

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/radenhet npm start
```

Sätt `PGSSL=true` om du ansluter till en databas som kräver SSL (t.ex. Renders externa URL).
