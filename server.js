const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const MASKINTYPER = ['TPV', 'TPT', 'TPL'];
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL saknas');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Renders interna databas-URL kräver inte SSL. Sätt PGSSL=true vid extern anslutning.
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS raknare (
      typ         TEXT        NOT NULL,
      storlek     INTEGER     NOT NULL CHECK (storlek > 0),
      antal       INTEGER     NOT NULL DEFAULT 0 CHECK (antal >= 0),
      uppdaterad  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (typ, storlek)
    )
  `);
}

// Validerar och normaliserar typ/storlek. Returnerar { typ, storlek } eller { fel }.
function parseMaskin(typRaw, storlekRaw) {
  const typ = String(typRaw ?? '').trim().toUpperCase();
  if (!MASKINTYPER.includes(typ)) {
    return { fel: `Ogiltig maskintyp '${typRaw}'. Tillåtna: ${MASKINTYPER.join(', ')}` };
  }
  const storlek = Number(storlekRaw);
  if (!Number.isInteger(storlek) || storlek <= 0) {
    return { fel: `Ogiltig storlek '${storlekRaw}'. Måste vara ett positivt heltal` };
  }
  return { typ, storlek };
}

function parseAntal(antalRaw) {
  if (antalRaw === undefined || antalRaw === null || antalRaw === '') return 1;
  const antal = Number(antalRaw);
  return Number.isInteger(antal) && antal > 0 ? antal : null;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'db-fel', fel: err.message });
  }
});

// Alla /api-anrop kräver x-api-key om API_KEY är satt.
app.use('/api', (req, res, next) => {
  if (API_KEY && req.get('x-api-key') !== API_KEY) {
    return res.status(401).json({ fel: 'Ogiltig eller saknad x-api-key' });
  }
  next();
});

// Registrera maskin(er): { "typ": "TPV", "storlek": 12, "antal": 1 }
app.post('/api/maskiner', async (req, res, next) => {
  try {
    const { typ, storlek, fel } = parseMaskin(req.body?.typ, req.body?.storlek);
    if (fel) return res.status(400).json({ fel });
    const antal = parseAntal(req.body?.antal);
    if (antal === null) return res.status(400).json({ fel: 'antal måste vara ett positivt heltal' });

    const { rows } = await pool.query(
      `INSERT INTO raknare (typ, storlek, antal) VALUES ($1, $2, $3)
       ON CONFLICT (typ, storlek)
       DO UPDATE SET antal = raknare.antal + EXCLUDED.antal, uppdaterad = now()
       RETURNING typ, storlek, antal, uppdaterad`,
      [typ, storlek, antal]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Ta bort maskin(er): minskar räknaren, aldrig under 0.
app.post('/api/maskiner/ta-bort', async (req, res, next) => {
  try {
    const { typ, storlek, fel } = parseMaskin(req.body?.typ, req.body?.storlek);
    if (fel) return res.status(400).json({ fel });
    const antal = parseAntal(req.body?.antal);
    if (antal === null) return res.status(400).json({ fel: 'antal måste vara ett positivt heltal' });

    const { rows } = await pool.query(
      `UPDATE raknare SET antal = GREATEST(antal - $3, 0), uppdaterad = now()
       WHERE typ = $1 AND storlek = $2
       RETURNING typ, storlek, antal, uppdaterad`,
      [typ, storlek, antal]
    );
    if (rows.length === 0) return res.status(404).json({ fel: `Inga ${typ} ${storlek} registrerade` });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Översikt över alla räknare, med summor per typ och totalt. Filtrera med ?typ=TPV
app.get('/api/raknare', async (req, res, next) => {
  try {
    const params = [];
    let where = '';
    if (req.query.typ) {
      const typ = String(req.query.typ).trim().toUpperCase();
      if (!MASKINTYPER.includes(typ)) {
        return res.status(400).json({ fel: `Ogiltig maskintyp. Tillåtna: ${MASKINTYPER.join(', ')}` });
      }
      params.push(typ);
      where = 'WHERE typ = $1';
    }
    const { rows } = await pool.query(
      `SELECT typ, storlek, antal, uppdaterad FROM raknare ${where} ORDER BY typ, storlek`,
      params
    );
    const perTyp = {};
    let totalt = 0;
    for (const r of rows) {
      perTyp[r.typ] = (perTyp[r.typ] || 0) + r.antal;
      totalt += r.antal;
    }
    res.json({ raknare: rows, perTyp, totalt });
  } catch (err) {
    next(err);
  }
});

app.get('/api/raknare/:typ/:storlek', async (req, res, next) => {
  try {
    const { typ, storlek, fel } = parseMaskin(req.params.typ, req.params.storlek);
    if (fel) return res.status(400).json({ fel });
    const { rows } = await pool.query(
      'SELECT typ, storlek, antal, uppdaterad FROM raknare WHERE typ = $1 AND storlek = $2',
      [typ, storlek]
    );
    res.json(rows[0] || { typ, storlek, antal: 0, uppdaterad: null });
  } catch (err) {
    next(err);
  }
});

// Nollställ en räknare
app.delete('/api/raknare/:typ/:storlek', async (req, res, next) => {
  try {
    const { typ, storlek, fel } = parseMaskin(req.params.typ, req.params.storlek);
    if (fel) return res.status(400).json({ fel });
    await pool.query('DELETE FROM raknare WHERE typ = $1 AND storlek = $2', [typ, storlek]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Nollställ allt – kräver ?bekrafta=ja
app.delete('/api/raknare', async (req, res, next) => {
  try {
    if (req.query.bekrafta !== 'ja') {
      return res.status(400).json({ fel: 'Lägg till ?bekrafta=ja för att nollställa alla räknare' });
    }
    await pool.query('DELETE FROM raknare');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.use((_req, res) => res.status(404).json({ fel: 'Hittades inte' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ fel: 'Internt serverfel' });
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Radenhetsräknare lyssnar på port ${PORT}`)))
  .catch((err) => {
    console.error('Kunde inte initiera databasen:', err);
    process.exit(1);
  });
