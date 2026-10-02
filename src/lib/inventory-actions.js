// Shared inventory actions used from several pages (asset page, stock page, person page).
const { transaction } = require('../db');
const { londonDate } = require('./activity');
const { HttpError, notFound } = require('./http');
const inv = require('./inventory');

// Assigns (or reassigns) an asset to an active person, keeping assignment history.
async function assignAsset(user, assetId, personId, date = londonDate()) {
  return transaction(async (conn) => {
    const [[asset]] = await conn.query('SELECT * FROM inv_assets WHERE id = ? FOR UPDATE', [assetId]);
    if (!asset) throw notFound();
    if (['sold', 'disposed'].includes(asset.status)) throw new HttpError(400, 'Sold or disposed assets cannot be assigned.');
    const person = await inv.personById(personId, conn);
    if (!person || person.status !== 'active') throw new HttpError(400, 'Choose an active person.');
    if (asset.person_id === personId) return 'unchanged';
    const full = await inv.assetById(assetId, conn);
    let previous = null;
    if (asset.person_id) {
      previous = await inv.personById(asset.person_id, conn);
      await conn.query('UPDATE inv_asset_assignments SET assigned_until = ? WHERE asset_id = ? AND assigned_until IS NULL', [date, assetId]);
    }
    await conn.query("UPDATE inv_assets SET person_id = ?, status = 'in_use', updated_by = ? WHERE id = ?", [personId, user.id, assetId]);
    await conn.query(
      'INSERT INTO inv_asset_assignments (asset_id, person_id, person_name, assigned_from, created_by) VALUES (?, ?, ?, ?, ?)',
      [assetId, personId, person.name, date, user.id]
    );
    const label = inv.assetLabel(full);
    await inv.logInv(conn, user, { type: 'inv_asset', id: assetId, action: 'updated', subject: label, personId,
      summary: previous ? `Reassigned ${label} from ${previous.name} to ${person.name}.` : `Assigned ${label} to ${person.name}.` });
    if (previous) {
      await inv.logInv(conn, user, { type: 'inv_asset', id: assetId, action: 'updated', subject: label, personId: previous.id,
        summary: `${label} moved from ${previous.name} to ${person.name}.` });
    }
    return 'assigned';
  });
}

// Gives a quantity of a stock item to an active person (never more than available).
async function giveStock(user, stockId, personId, quantity) {
  return transaction(async (conn) => {
    await conn.query('SELECT id FROM inv_stock WHERE id = ? FOR UPDATE', [stockId]);
    const item = await inv.stockById(stockId, conn);
    if (!item) throw notFound();
    const person = await inv.personById(personId, conn);
    if (!person || person.status !== 'active') throw new HttpError(400, 'Choose an active person.');
    if (!Number.isInteger(quantity) || quantity < 1) throw new HttpError(400, 'Enter a quantity of 1 or more.');
    if (quantity > item.available_qty) throw new HttpError(400, `Only ${item.available_qty} available.`);
    await conn.query(
      'INSERT INTO inv_stock_assignments (stock_id, person_id, quantity, assigned_at, created_by) VALUES (?, ?, ?, ?, ?)',
      [stockId, personId, quantity, londonDate(), user.id]
    );
    await inv.logInv(conn, user, { type: 'inv_stock', id: stockId, action: 'updated', subject: inv.stockLabel(item), personId,
      summary: `Assigned ${quantity} × ${inv.stockLabel(item)} to ${person.name}.` });
  });
}

module.exports = { assignAsset, giveStock };
