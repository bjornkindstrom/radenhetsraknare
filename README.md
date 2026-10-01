# Radenhetsräknare

Litet API som räknar antal maskiner per **maskintyp** (`TPV`, `TPT`, `TPL`) och **storlek** (valfritt positivt heltal, t.ex. 6, 12, 16). Data sparas i Postgres.

## Driftsätt på Render

1. Gå till [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**.
2. Välj det här repot. Render läser `render.yaml` och skapar:
   - webbtjänsten `radenhetsraknare` (Node, free)
   - databasen `radenhetsraknare-db` (Postgres, free)
3. Klicka **Apply**. Tabellen skapas automatiskt vid första start.
4. Hämta API-nyckeln under tjänstens **Environment** → `API_KEY` (genereras automatiskt).

> Free-planen: webbtjänsten somnar efter inaktivitet (första anropet tar ~30–60 s), och free-databasen raderas efter 30 dagar. Byt `plan` i `render.yaml` till `starter` / `basic-256mb` för produktion.

## Webbappen

Öppna tjänstens adress (t.ex. `https://radenhetsraknare.onrender.com`) i webbläsaren eller mobilen. Första gången anger du API-nyckeln, sedan sparas den i webbläsaren. Välj maskintyp, skriv storlek och antal och tryck **+ Lägg till** eller **− Ta bort**. Tabellen visar alla räknare med summor per typ.

## API

Alla `/api`-anrop kräver headern `x-api-key: <API_KEY>`. Maskintyp är skiftlägesokänslig.

| Metod | Sökväg | Beskrivning |
|---|---|---|
| `GET` | `/health` | Hälsokontroll (ingen nyckel) |
| `POST` | `/api/maskiner` | Registrera maskin(er). Body: `{"typ":"TPV","storlek":12,"antal":1}` (`antal` valfritt, standard 1) |
| `POST` | `/api/maskiner/ta-bort` | Minska räknaren (aldrig under 0). Samma body |
| `GET` | `/api/raknare` | Alla räknare + summa per typ + totalt. Filtrera med `?typ=TPV` |
| `GET` | `/api/raknare/:typ/:storlek` | En räknare, t.ex. `/api/raknare/TPL/16` |
| `DELETE` | `/api/raknare/:typ/:storlek` | Nollställ en räknare |
| `DELETE` | `/api/raknare?bekrafta=ja` | Nollställ alla räknare |

### Exempel

```bash
URL=https://radenhetsraknare.onrender.com
KEY=din-api-nyckel

curl -X POST $URL/api/maskiner -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"typ":"TPV","storlek":12}'

curl $URL/api/raknare -H "x-api-key: $KEY"
```

Svar från `GET /api/raknare`:

```json
{
  "raknare": [
    { "typ": "TPL", "storlek": 6,  "antal": 1, "uppdaterad": "2026-10-01T09:33:28.007Z" },
    { "typ": "TPV", "storlek": 12, "antal": 4, "uppdaterad": "2026-10-01T09:33:27.992Z" }
  ],
  "perTyp": { "TPL": 1, "TPV": 4 },
  "totalt": 5
}
```

## Köra lokalt

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/radenhet npm start
```

Sätt `PGSSL=true` om du ansluter till en databas som kräver SSL (t.ex. Renders externa URL). Utan `API_KEY` är API:t öppet.
