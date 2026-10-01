const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const SKIFT = ['Förmiddag', 'Eftermiddag', 'Natt'];

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
    CREATE TABLE IF NOT EXISTS linjer (
      id     SERIAL      PRIMARY KEY,
      namn   TEXT        NOT NULL UNIQUE,
      skapad TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS maskintyper (
      namn   TEXT        PRIMARY KEY,
      skapad TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE maskintyper ADD COLUMN IF NOT EXISTS ordning SERIAL;
    CREATE TABLE IF NOT EXISTS storlekar (
      typ     TEXT    NOT NULL REFERENCES maskintyper (namn) ON DELETE CASCADE,
      storlek INTEGER NOT NULL CHECK (storlek > 0),
      PRIMARY KEY (typ, storlek)
    );
    CREATE TABLE IF NOT EXISTS skift (
      id       SERIAL      PRIMARY KEY,
      linje_id INTEGER     NOT NULL REFERENCES linjer (id) ON DELETE CASCADE,
      namn     TEXT        NOT NULL,
      start    TIMESTAMPTZ NOT NULL DEFAULT now(),
      slut     TIMESTAMPTZ,
      mal      INTEGER     NOT NULL DEFAULT 40 CHECK (mal >= 0)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS skift_aktivt ON skift (linje_id, namn) WHERE slut IS NULL;
    CREATE TABLE IF NOT EXISTS handelser (
      id       SERIAL      PRIMARY KEY,
      skift_id INTEGER     NOT NULL REFERENCES skift (id) ON DELETE CASCADE,
      typ      TEXT        NOT NULL,
      storlek  INTEGER     NOT NULL,
      antal    INTEGER     NOT NULL CHECK (antal <> 0),
      tid      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS handelser_skift ON handelser (skift_id, tid DESC);
  `);

  const { rows } = await pool.query('SELECT (SELECT count(*) FROM linjer)::int AS l, (SELECT count(*) FROM maskintyper)::int AS m');
  if (rows[0].l === 0) {
    await pool.query("INSERT INTO linjer (namn) VALUES ('Linje 1 (Huvudflöde)'), ('Linje 2')");
  }
  if (rows[0].m === 0) {
    await pool.query("INSERT INTO maskintyper (namn) VALUES ('TPV'), ('TPT'), ('TPL')");
    await pool.query(`INSERT INTO storlekar (typ, storlek)
      SELECT t, s FROM unnest(ARRAY['TPV','TPT','TPL']) t, unnest(ARRAY[6,12,16]) s`);
  }
}

const normTyp = (raw) => String(raw ?? '').trim().toUpperCase();
const posInt = (raw) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Wrapper så att async-fel hamnar i felhanteraren.
const h = (fn) => (req, res, next) => fn(req, res).catch(next);

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

// ---- Inställningar ----

async function config() {
  const [linjer, typer] = await Promise.all([
    pool.query('SELECT id, namn FROM linjer ORDER BY id'),
    pool.query(`
      SELECT m.namn,
             COALESCE(array_agg(s.storlek ORDER BY s.storlek) FILTER (WHERE s.storlek IS NOT NULL), '{}') AS storlekar
      FROM maskintyper m LEFT JOIN storlekar s ON s.typ = m.namn
      GROUP BY m.namn, m.ordning ORDER BY m.ordning`),
  ]);
  return { linjer: linjer.rows, maskintyper: typer.rows, skift: SKIFT };
}

app.get('/api/config', h(async (_req, res) => res.json(await config())));

app.post('/api/linjer', h(async (req, res) => {
  const namn = String(req.body?.namn ?? '').trim();
  if (!namn || namn.length > 40) return res.status(400).json({ fel: 'Namnet måste vara 1–40 tecken' });
  const { rowCount } = await pool.query('INSERT INTO linjer (namn) VALUES ($1) ON CONFLICT DO NOTHING', [namn]);
  if (rowCount === 0) return res.status(409).json({ fel: `${namn} finns redan` });
  res.status(201).json(await config());
}));

app.patch('/api/linjer/:id', h(async (req, res) => {
  const namn = String(req.body?.namn ?? '').trim();
  if (!namn || namn.length > 40) return res.status(400).json({ fel: 'Namnet måste vara 1–40 tecken' });
  try {
    await pool.query('UPDATE linjer SET namn = $2 WHERE id = $1', [Number(req.params.id), namn]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ fel: `${namn} finns redan` });
    throw err;
  }
  res.json(await config());
}));

// Tar bort linjen med alla dess skift och registreringar.
app.delete('/api/linjer/:id', h(async (req, res) => {
  await pool.query('DELETE FROM linjer WHERE id = $1', [Number(req.params.id)]);
  res.json(await config());
}));

app.post('/api/maskintyper', h(async (req, res) => {
  const namn = normTyp(req.body?.namn);
  if (!/^[A-ZÅÄÖ0-9][A-ZÅÄÖ0-9 _-]{0,19}$/.test(namn)) {
    return res.status(400).json({ fel: 'Namnet får vara 1–20 tecken: bokstäver, siffror, mellanslag, - och _' });
  }
  const { rowCount } = await pool.query('INSERT INTO maskintyper (namn) VALUES ($1) ON CONFLICT DO NOTHING', [namn]);
  if (rowCount === 0) return res.status(409).json({ fel: `${namn} finns redan` });
  res.status(201).json(await config());
}));

// Tar bort typen och dess storlekar. Redan gjorda registreringar finns kvar i loggen.
app.delete('/api/maskintyper/:namn', h(async (req, res) => {
  await pool.query('DELETE FROM maskintyper WHERE namn = $1', [normTyp(req.params.namn)]);
  res.json(await config());
}));

app.post('/api/maskintyper/:namn/storlekar', h(async (req, res) => {
  const namn = normTyp(req.params.namn);
  const storlek = posInt(req.body?.storlek);
  if (storlek === null) return res.status(400).json({ fel: 'Storleken måste vara ett positivt heltal' });
  const { rowCount: finns } = await pool.query('SELECT 1 FROM maskintyper WHERE namn = $1', [namn]);
  if (!finns) return res.status(404).json({ fel: `${namn} finns inte` });
  const { rowCount } = await pool.query(
    'INSERT INTO storlekar (typ, storlek) VALUES ($1, $2) ON CONFLICT DO NOTHING', [namn, storlek]
  );
  if (rowCount === 0) return res.status(409).json({ fel: `${namn} ${storlek} finns redan` });
  res.status(201).json(await config());
}));

app.delete('/api/maskintyper/:namn/storlekar/:storlek', h(async (req, res) => {
  await pool.query('DELETE FROM storlekar WHERE typ = $1 AND storlek = $2',
    [normTyp(req.params.namn), Number(req.params.storlek)]);
  res.json(await config());
}));

// ---- Skift och registreringar ----

async function skiftData(skiftId) {
  const [skift, perMaskin, handelser] = await Promise.all([
    pool.query(`SELECT s.id, s.linje_id, s.namn, s.start, s.mal,
                       COALESCE((SELECT sum(antal) FROM handelser WHERE skift_id = s.id), 0)::int AS total
                FROM skift s WHERE s.id = $1`, [skiftId]),
    pool.query(`SELECT typ, storlek, sum(antal)::int AS antal FROM handelser
                WHERE skift_id = $1 GROUP BY typ, storlek HAVING sum(antal) <> 0 ORDER BY typ, storlek`, [skiftId]),
    pool.query(`SELECT id, typ, storlek, antal, tid FROM handelser
                WHERE skift_id = $1 ORDER BY tid DESC, id DESC LIMIT 200`, [skiftId]),
  ]);
  if (!skift.rows[0]) return null;
  return { ...skift.rows[0], perMaskin: perMaskin.rows, handelser: handelser.rows, nu: new Date() };
}

// Hämtar aktivt skift för linje + skiftnamn, skapar det om det inte finns.
app.get('/api/skift', h(async (req, res) => {
  const linjeId = posInt(req.query.linje);
  const namn = SKIFT.includes(req.query.skift) ? req.query.skift : null;
  if (!linjeId || !namn) return res.status(400).json({ fel: 'Ange linje och skift' });
  const { rowCount } = await pool.query('SELECT 1 FROM linjer WHERE id = $1', [linjeId]);
  if (!rowCount) return res.status(404).json({ fel: 'Linjen finns inte' });

  const aktivt = () => pool.query(
    'SELECT id FROM skift WHERE linje_id = $1 AND namn = $2 AND slut IS NULL', [linjeId, namn]
  );
  let { rows } = await aktivt();
  if (!rows[0]) {
    // Nytt skift ärver målet från förra skiftet med samma linje och namn.
    await pool.query(
      `INSERT INTO skift (linje_id, namn, mal)
       VALUES ($1, $2, COALESCE((SELECT mal FROM skift WHERE linje_id = $1 AND namn = $2 ORDER BY start DESC LIMIT 1), 40))
       ON CONFLICT (linje_id, namn) WHERE slut IS NULL DO NOTHING`,
      [linjeId, namn]
    );
    ({ rows } = await aktivt());
  }
  res.json(await skiftData(rows[0].id));
}));

app.patch('/api/skift/:id', h(async (req, res) => {
  const mal = Number(req.body?.mal);
  if (!Number.isInteger(mal) || mal < 0 || mal > 100000) return res.status(400).json({ fel: 'Ogiltigt mål' });
  await pool.query('UPDATE skift SET mal = $2 WHERE id = $1', [Number(req.params.id), mal]);
  res.json(await skiftData(Number(req.params.id)));
}));

// Registrera radenheter: { "typ": "TPV", "storlek": 12, "antal": 1 } (negativt antal = ta bort)
app.post('/api/skift/:id/handelser', h(async (req, res) => {
  const skiftId = Number(req.params.id);
  const typ = normTyp(req.body?.typ);
  const storlek = posInt(req.body?.storlek);
  const antal = Number(req.body?.antal ?? 1);
  if (!typ || storlek === null) return res.status(400).json({ fel: 'Välj maskintyp och storlek' });
  if (!Number.isInteger(antal) || antal === 0 || Math.abs(antal) > 1000) {
    return res.status(400).json({ fel: 'Ogiltigt antal' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: s } = await client.query('SELECT slut FROM skift WHERE id = $1 FOR UPDATE', [skiftId]);
    if (!s[0]) { await client.query('ROLLBACK'); return res.status(404).json({ fel: 'Skiftet finns inte' }); }
    if (s[0].slut) { await client.query('ROLLBACK'); return res.status(409).json({ fel: 'Skiftet är avslutat' }); }
    if (antal < 0) {
      const { rows } = await client.query(
        'SELECT COALESCE(sum(antal), 0)::int AS n FROM handelser WHERE skift_id = $1 AND typ = $2 AND storlek = $3',
        [skiftId, typ, storlek]
      );
      if (rows[0].n + antal < 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ fel: `Det finns inga fler ${typ} ${storlek} att ta bort på detta skift` });
      }
    }
    await client.query(
      'INSERT INTO handelser (skift_id, typ, storlek, antal) VALUES ($1, $2, $3, $4)',
      [skiftId, typ, storlek, antal]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.status(201).json(await skiftData(skiftId));
}));

// Avsluta skiftet och starta ett nytt med samma linje, namn och mål.
app.post('/api/skift/:id/nytt', h(async (req, res) => {
  const skiftId = Number(req.params.id);
  const client = await pool.connect();
  let nyttId;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'UPDATE skift SET slut = now() WHERE id = $1 AND slut IS NULL RETURNING linje_id, namn, mal', [skiftId]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(409).json({ fel: 'Skiftet är redan avslutat' }); }
    const { rows: ny } = await client.query(
      'INSERT INTO skift (linje_id, namn, mal) VALUES ($1, $2, $3) RETURNING id',
      [rows[0].linje_id, rows[0].namn, rows[0].mal]
    );
    nyttId = ny[0].id;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.status(201).json(await skiftData(nyttId));
}));

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
