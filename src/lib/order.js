const { transaction } = require('../db');

// Ordered tables and the column that groups their rows. Table and column names
// only ever come from this list; all values are passed as query parameters.
const SCOPES = {
  service_categories: null,
  services: 'category_id',
  service_steps: 'service_id',
};

function scopeOf(table) {
  if (!Object.hasOwn(SCOPES, table)) throw new Error(`Unknown ordered table: ${table}`);
  return SCOPES[table];
}

// Next free position at the end of a group.
async function nextPosition(conn, table, scopeValue) {
  const scope = scopeOf(table);
  const [[row]] = scope
    ? await conn.query(`SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM ${table} WHERE ${scope} = ?`, [scopeValue])
    : await conn.query(`SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM ${table}`);
  return Number(row.pos);
}

// Swaps a row with its neighbour, then renumbers the group 0..n-1.
// Returns the row ({ id, scope }) or null if it does not exist.
async function move(table, id, dir) {
  const scope = scopeOf(table);
  return transaction(async (conn) => {
    const [[item]] = await conn.query(
      `SELECT id${scope ? `, ${scope} AS scope` : ''} FROM ${table} WHERE id = ? FOR UPDATE`,
      [id]
    );
    if (!item) return null;

    const [rows] = scope
      ? await conn.query(`SELECT id FROM ${table} WHERE ${scope} = ? ORDER BY position, id FOR UPDATE`, [item.scope])
      : await conn.query(`SELECT id FROM ${table} ORDER BY position, id FOR UPDATE`);
    const ids = rows.map((r) => r.id);
    const i = ids.indexOf(item.id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return item;

    [ids[i], ids[j]] = [ids[j], ids[i]];
    for (let k = 0; k < ids.length; k++) {
      await conn.query(`UPDATE ${table} SET position = ? WHERE id = ?`, [k, ids[k]]);
    }
    return item;
  });
}

module.exports = { nextPosition, move };
