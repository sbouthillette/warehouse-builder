// GET    /api/warehouses/:id -> fetch one warehouse project (full data)
// PUT    /api/warehouses/:id -> replace its data (used by autosave)
// DELETE /api/warehouses/:id -> delete it
import { sql } from '@vercel/postgres';

function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export default async function handler(req, res) {
  const { id } = req.query;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid warehouse id' });

  try {
    if (req.method === 'GET') {
      const { rows } = await sql`SELECT id, data, created_at, updated_at FROM warehouses WHERE id = ${id}`;
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(rows[0]);
    }

    if (req.method === 'PUT') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = null; }
      }
      const data = body?.data;
      if (!data || typeof data !== 'object') {
        return res.status(400).json({ error: 'Missing "data" object in request body' });
      }
      const { rows } = await sql`
        UPDATE warehouses
        SET data = ${JSON.stringify(data)}::jsonb, updated_at = now()
        WHERE id = ${id}
        RETURNING id, data, updated_at
      `;
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json(rows[0]);
    }

    if (req.method === 'DELETE') {
      const { rowCount } = await sql`DELETE FROM warehouses WHERE id = ${id}`;
      if (!rowCount) return res.status(404).json({ error: 'Not found' });
      return res.status(204).end();
    }

    res.setHeader('Allow', 'GET, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error', detail: String(err?.message || err) });
  }
}
