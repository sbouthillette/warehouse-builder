// GET  /api/warehouses      -> list saved warehouses (id, name, timestamps)
// POST /api/warehouses      -> create a new, empty warehouse project
import { sql } from '@vercel/postgres';

const EMPTY_PROJECT = { version: 1, locked: false, passwordHash: null, passwordSalt: null, warehouse: null, zones: [], bayTemplates: [], racks: [] };

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT id, data->'warehouse'->>'name' AS name,
               COALESCE((data->>'locked')::boolean, false) AS locked,
               created_at, updated_at
        FROM warehouses
        ORDER BY updated_at DESC
      `;
      const list = rows.map((r) => ({
        id: r.id,
        name: r.name || 'Untitled Warehouse',
        locked: r.locked === true,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }));
      return res.status(200).json(list);
    }

    if (req.method === 'POST') {
      const { rows } = await sql`
        INSERT INTO warehouses (data)
        VALUES (${JSON.stringify(EMPTY_PROJECT)}::jsonb)
        RETURNING id, data, created_at, updated_at
      `;
      return res.status(201).json(rows[0]);
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error', detail: String(err?.message || err) });
  }
}
