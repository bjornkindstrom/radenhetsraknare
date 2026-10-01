const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const SKIFT = ['Förmiddag', 'Eftermiddag', 'Natt'];
// Kod som krävs för att ändra inställningar. Kan bytas med miljövariabeln SETTINGS_CODE i Render.
const SETTINGS_CODE = process.env.SETTINGS_CODE || 'rowunit';

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
  const { rows: fanns } = await pool.query("SELECT to_regclass('raster') IS NOT NULL AS finns");
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
    CREATE TABLE IF NOT EXISTS korningar (
      id        SERIAL      PRIMARY KEY,
      skift_id  INTEGER     NOT NULL REFERENCES skift (id) ON DELETE CASCADE,
      typ       TEXT        NOT NULL,
      storlek   INTEGER     NOT NULL,
      sekvensnr TEXT        NOT NULL,
      start     TIMESTAMPTZ NOT NULL DEFAULT now(),
      slut      TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS korning_aktiv ON korningar (skift_id) WHERE slut IS NULL;
    ALTER TABLE handelser ADD COLUMN IF NOT EXISTS korning_id INTEGER REFERENCES korningar (id) ON DELETE CASCADE;
    CREATE TABLE IF NOT EXISTS raster (
      id    SERIAL PRIMARY KEY,
      skift TEXT   NOT NULL,
      start TIME   NOT NULL,
      slut  TIME   NOT NULL CHECK (slut <> start)
    );
  `);

  // Exempelraster första gången – ändras under Inställningar.
  if (!fanns[0].finns) {
    await pool.query(`INSERT INTO raster (skift, start, slut) VALUES
      ('Förmiddag', '09:00', '09:15'), ('Förmiddag', '11:30', '12:00'),
      ('Eftermiddag', '17:00', '17:15'), ('Eftermiddag', '19:00', '19:30'),
      ('Natt', '01:00', '01:30'), ('Natt', '03:30', '03:45')`);
  }

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

// Alla ändringar av linjer, maskiner och raster kräver koden i headern x-installningskod.
app.use(['/api/linjer', '/api/maskintyper', '/api/raster'], (req, res, next) => {
  if (req.method === 'GET' || req.get('x-installningskod') === SETTINGS_CODE) return next();
  res.status(403).json({ fel: 'Fel kod för inställningar' });
});

app.post('/api/installningar/kod', (req, res) => {
  if (req.body?.kod === SETTINGS_CODE) return res.json({ ok: true });
  res.status(403).json({ fel: 'Fel kod' });
});

async function config() {
  const [linjer, typer, raster] = await Promise.all([
    pool.query('SELECT id, namn FROM linjer ORDER BY id'),
    pool.query(`
      SELECT m.namn,
             COALESCE(array_agg(s.storlek ORDER BY s.storlek) FILTER (WHERE s.storlek IS NOT NULL), '{}') AS storlekar
      FROM maskintyper m LEFT JOIN storlekar s ON s.typ = m.namn
      GROUP BY m.namn, m.ordning ORDER BY m.ordning`),
    pool.query(`SELECT id, skift, to_char(start, 'HH24:MI') AS start, to_char(slut, 'HH24:MI') AS slut
                FROM raster ORDER BY array_position($1::text[], skift), start`, [SKIFT]),
  ]);
  return { linjer: linjer.rows, maskintyper: typer.rows, skift: SKIFT, raster: raster.rows };
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

const TID = /^([01]?\d|2[0-3]):[0-5]\d$/;

app.post('/api/raster', h(async (req, res) => {
  const { skift, start, slut } = req.body || {};
  if (!SKIFT.includes(skift)) return res.status(400).json({ fel: 'Okänt skift' });
  if (!TID.test(start || '') || !TID.test(slut || '') || start === slut) {
    return res.status(400).json({ fel: 'Ange start och slut som TT:MM, t.ex. 09:00 och 09:15' });
  }
  await pool.query('INSERT INTO raster (skift, start, slut) VALUES ($1, $2, $3)', [skift, start, slut]);
  res.status(201).json(await config());
}));

app.delete('/api/raster/:id', h(async (req, res) => {
  await pool.query('DELETE FROM raster WHERE id = $1', [Number(req.params.id)]);
  res.json(await config());
}));

// ---- Skift, körningar och registreringar ----

async function skiftData(skiftId) {
  const [skift, korningar, handelser] = await Promise.all([
    pool.query(`SELECT s.id, s.linje_id, s.namn, s.start, s.mal,
                       COALESCE((SELECT sum(antal) FROM handelser WHERE skift_id = s.id), 0)::int AS total
                FROM skift s WHERE s.id = $1`, [skiftId]),
    pool.query(`SELECT k.id, k.typ, k.storlek, k.sekvensnr, k.start, k.slut,
                       COALESCE((SELECT sum(antal) FROM handelser WHERE korning_id = k.id), 0)::int AS antal
                FROM korningar k WHERE k.skift_id = $1 ORDER BY k.start DESC, k.id DESC`, [skiftId]),
    pool.query(`SELECT h.id, h.typ, h.storlek, h.antal, h.tid, k.sekvensnr FROM handelser h
                LEFT JOIN korningar k ON k.id = h.korning_id
                WHERE h.skift_id = $1 ORDER BY h.tid DESC, h.id DESC LIMIT 200`, [skiftId]),
  ]);
  if (!skift.rows[0]) return null;
  const aktiv = korningar.rows.find((k) => !k.slut) || null;
  return { ...skift.rows[0], korning: aktiv, korningar: korningar.rows, handelser: handelser.rows, nu: new Date() };
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

// Starta en körning: { "typ": "TPV", "storlek": 12, "sekvensnr": "123456" }
app.post('/api/skift/:id/korningar', h(async (req, res) => {
  const skiftId = Number(req.params.id);
  const typ = normTyp(req.body?.typ);
  const storlek = posInt(req.body?.storlek);
  const sekvensnr = String(req.body?.sekvensnr ?? '').trim();
  if (!sekvensnr || sekvensnr.length > 40) return res.status(400).json({ fel: 'Ange ett sekvensnummer (max 40 tecken)' });
  const { rowCount: finns } = await pool.query(
    'SELECT 1 FROM storlekar WHERE typ = $1 AND storlek = $2', [typ, storlek]
  );
  if (!finns) return res.status(400).json({ fel: 'Välj en maskin som finns i Inställningar' });
  const { rows: s } = await pool.query('SELECT slut FROM skift WHERE id = $1', [skiftId]);
  if (!s[0]) return res.status(404).json({ fel: 'Skiftet finns inte' });
  if (s[0].slut) return res.status(409).json({ fel: 'Skiftet är avslutat' });
  try {
    await pool.query(
      'INSERT INTO korningar (skift_id, typ, storlek, sekvensnr) VALUES ($1, $2, $3, $4)',
      [skiftId, typ, storlek, sekvensnr]
    );
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ fel: 'En körning pågår redan på detta skift' });
    throw err;
  }
  res.status(201).json(await skiftData(skiftId));
}));

app.post('/api/korningar/:id/avsluta', h(async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE korningar SET slut = now() WHERE id = $1 AND slut IS NULL RETURNING skift_id', [Number(req.params.id)]
  );
  if (!rows[0]) return res.status(409).json({ fel: 'Körningen är redan avslutad' });
  res.json(await skiftData(rows[0].skift_id));
}));

// Ångra sista radenheten i en klar sekvens: öppnar sekvensen igen och tar bort en enhet.
app.post('/api/korningar/:id/angra', h(async (req, res) => {
  const id = Number(req.params.id);
  const client = await pool.connect();
  let skiftId;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT k.skift_id, k.typ, k.storlek, s.slut AS skift_slut,
              EXISTS (SELECT 1 FROM korningar WHERE skift_id = k.skift_id AND slut IS NULL) AS annan_aktiv,
              COALESCE((SELECT sum(antal) FROM handelser WHERE korning_id = k.id), 0)::int AS n
       FROM korningar k JOIN skift s ON s.id = k.skift_id WHERE k.id = $1 FOR UPDATE OF k`, [id]
    );
    const k = rows[0];
    if (!k) { await client.query('ROLLBACK'); return res.status(404).json({ fel: 'Körningen finns inte' }); }
    if (k.skift_slut || k.annan_aktiv || k.n < 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ fel: 'Det går inte att ångra just nu' });
    }
    skiftId = k.skift_id;
    await client.query('UPDATE korningar SET slut = NULL WHERE id = $1', [id]);
    await client.query(
      'INSERT INTO handelser (skift_id, korning_id, typ, storlek, antal) VALUES ($1, $2, $3, $4, -1)',
      [k.skift_id, id, k.typ, k.storlek]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json(await skiftData(skiftId));
}));

// Registrera radenheter på pågående körning: { "antal": 1 } (negativt antal = ta bort)
app.post('/api/skift/:id/handelser', h(async (req, res) => {
  const skiftId = Number(req.params.id);
  const antal = Number(req.body?.antal ?? 1);
  if (!Number.isInteger(antal) || antal === 0 || Math.abs(antal) > 1000) {
    return res.status(400).json({ fel: 'Ogiltigt antal' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: s } = await client.query('SELECT slut FROM skift WHERE id = $1 FOR UPDATE', [skiftId]);
    if (!s[0]) { await client.query('ROLLBACK'); return res.status(404).json({ fel: 'Skiftet finns inte' }); }
    if (s[0].slut) { await client.query('ROLLBACK'); return res.status(409).json({ fel: 'Skiftet är avslutat' }); }
    const { rows: k } = await client.query(
      `SELECT k.id, k.typ, k.storlek,
              COALESCE((SELECT sum(antal) FROM handelser WHERE korning_id = k.id), 0)::int AS n
       FROM korningar k WHERE k.skift_id = $1 AND k.slut IS NULL`, [skiftId]
    );
    if (!k[0]) { await client.query('ROLLBACK'); return res.status(409).json({ fel: 'Starta en körning först' }); }
    if (k[0].n + antal < 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ fel: 'Det finns inga fler enheter att ta bort i körningen' });
    }
    if (k[0].n + antal > k[0].storlek) {
      await client.query('ROLLBACK');
      return res.status(409).json({ fel: `Sekvensen har bara ${k[0].storlek} radenheter` });
    }
    await client.query(
      'INSERT INTO handelser (skift_id, korning_id, typ, storlek, antal) VALUES ($1, $2, $3, $4, $5)',
      [skiftId, k[0].id, k[0].typ, k[0].storlek, antal]
    );
    // Storleken är antalet radenheter i sekvensen – när den är nådd är sekvensen klar.
    if (k[0].n + antal === k[0].storlek) {
      await client.query('UPDATE korningar SET slut = now() WHERE id = $1', [k[0].id]);
    }
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
    await client.query('UPDATE korningar SET slut = now() WHERE skift_id = $1 AND slut IS NULL', [skiftId]);
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
