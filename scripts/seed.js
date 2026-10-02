// Seeds the default service categories, services and steps, and the inventory lists
// (categories, apps, companies, teams). Usage: npm run seed
// Safe to run more than once: existing categories and services are left alone, and
// steps are only added to services that have none.
const { pool, transaction } = require('../src/db');

const CATEGORIES = [
  ['Email Services', ['Emails setup', 'Intune configuration', 'Email migration', 'Codetwo email signatures']],
  ['Networking', ['BT internet', 'Local network', 'Client network', 'Hardware configuration', 'Access points', 'Switches & Firewalls config']],
  ['VOIP Services', ['CS1 config', 'Hardware config', 'Number porting', 'IVR generation']],
  ['Digital Signage', ['Box configuration', 'Allocation and portal setup', 'Media changes & playlist']],
  ['Internal Tools', ['Anydesk config']],
  ['Support', ['IT support', 'Hardware support', 'Software support', 'Email support', 'VOIP support', 'General faults']],
  ['Protection', ['Threat Locker', '1Password', 'Duo', 'MSP backups', 'Email security', 'Email backups']],
  ['Servers & Domains', ['Web servers', 'Windows servers', 'Website deployments', 'Domain management', 'RDP services config']],
  ['Quotations & Installations', [
    'Networking equipment', 'Laptops', 'Digital signage screens', 'Phone quotes', 'Delivery of hardware',
    'VOIP installations', 'Digital signage installation', 'Server installation',
  ]],
];

const STEPS = {
  'Emails setup': [
    'Create new customer on PAX8/Arrow',
    'Add required licenses',
    'Create new tenant',
    'Add domain and set up DNS records',
    'Create required users',
  ],
  'Intune configuration': [
    'Add Intune DNS records',
    'Create Windows/Mac deployment profiles',
    'Create Windows/Mac system configurations',
    'Create Windows/Mac app configurations',
    'Upload hardware ID to Intune',
    'Reset/install new copy of Windows',
  ],
  'Email migration': [
    'Create IMAP endpoint on Exchange Online',
    'If IMAP endpoint not working, take manual backups',
    'Start migration batch',
    'Take manual backups if moving mail from GoDaddy or old tenant',
    'Regular email setup and import backups',
  ],
  'Codetwo email signatures': [
    'Create new user account on CodeTwo and sync with Microsoft 365',
  ],
};

// Inventory categories: 'asset' = tracked one by one, 'stock' = counted by quantity.
const INV_CATEGORIES = [
  ['Laptop', 'asset'], ['Desktop', 'asset'], ['Workstation', 'asset'], ['Monitor', 'asset'],
  ['Keyboard', 'stock'], ['Mouse', 'stock'], ['Keyboard & Mouse Combo', 'stock'], ['Headset', 'stock'],
  ['Docking Station', 'stock'], ['USB Hub', 'stock'], ['Cables', 'stock'], ['Networking Equipment', 'asset'],
  ['Printer', 'asset'], ['Barcode Scanner', 'asset'], ['Phone / VoIP Phone', 'asset'], ['Tablet', 'asset'],
  ['Mobile Device', 'asset'], ['Android Box', 'asset'], ['Raspberry Pi', 'asset'], ['Payment Device', 'asset'],
  ['Smart Switch', 'asset'], ['Batteries', 'stock'], ['Mouse Pad', 'stock'], ['Back Support / Pillow', 'stock'],
  ['Other', 'stock'],
];
const INV_APPS = ['Microsoft 365', 'Google Workspace', 'Gmail', 'Outlook', '1Password', 'Claude', 'ChatGPT', 'Canva',
  'Apple ID', 'Mac local user', 'Duo', 'VPN', 'Other'];
const INV_COMPANIES = ['Cleartwo', 'My Digital People'];
const INV_TEAMS = ['PK Team', 'Writers'];

async function main() {
  const added = { categories: 0, services: 0, steps: 0 };

  await transaction(async (conn) => {
    for (const [categoryName, serviceNames] of CATEGORIES) {
      let [[category]] = await conn.query('SELECT id FROM service_categories WHERE name = ?', [categoryName]);
      if (!category) {
        const [result] = await conn.query('INSERT INTO service_categories (name) VALUES (?)', [categoryName]);
        category = { id: result.insertId };
        added.categories++;
      }

      for (const serviceName of serviceNames) {
        let [[service]] = await conn.query(
          'SELECT id FROM services WHERE category_id = ? AND name = ?',
          [category.id, serviceName]
        );
        if (!service) {
          const [result] = await conn.query(
            'INSERT INTO services (category_id, name) VALUES (?, ?)',
            [category.id, serviceName]
          );
          service = { id: result.insertId };
          added.services++;
        }

        const steps = STEPS[serviceName];
        if (!steps) continue;
        const [[{ count }]] = await conn.query(
          'SELECT COUNT(*) AS count FROM service_steps WHERE service_id = ?',
          [service.id]
        );
        if (Number(count) > 0) continue;
        await conn.query(
          'INSERT INTO service_steps (service_id, title, position) VALUES ?',
          [steps.map((title, i) => [service.id, title, i])]
        );
        added.steps += steps.length;
      }
    }
  });

  let lists = 0;
  await transaction(async (conn) => {
    for (const [name, kind] of INV_CATEGORIES) {
      const [r] = await conn.query('INSERT IGNORE INTO inv_categories (name, kind) VALUES (?, ?)', [name, kind]);
      lists += r.affectedRows;
    }
    for (const name of INV_APPS) lists += (await conn.query('INSERT IGNORE INTO inv_apps (name) VALUES (?)', [name]))[0].affectedRows;
    for (const name of INV_COMPANIES) lists += (await conn.query('INSERT IGNORE INTO inv_companies (name) VALUES (?)', [name]))[0].affectedRows;
    for (const name of INV_TEAMS) lists += (await conn.query('INSERT IGNORE INTO inv_teams (name) VALUES (?)', [name]))[0].affectedRows;
  });

  console.log(`Seed complete: ${added.categories} categories, ${added.services} services, ${added.steps} steps, `
    + `${lists} inventory list entries added.`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
