// Seeds the default service categories, services and steps, and the Daily Report
// actions and issues. Usage: npm run seed
// Safe to run more than once: existing categories, services, actions and issues
// (matched by name) are left alone, and steps are only added to services that have none.
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

// [name, phrase_type, template] - {client} and {subjects} are filled in by the report.
const REPORT_ACTIONS = [
  ['Resolved', 'problem', 'Resolved {subjects} issues for {client}.'],
  ['Investigated', 'problem', 'Investigated {subjects} issues for {client}.'],
  ['Troubleshot', 'problem', 'Troubleshot {subjects} issues for {client}.'],
  ['Provided support', 'problem', 'Provided IT support to {client} regarding {subjects} issues.'],
  ['Assisted with', 'config', 'Assisted {client} with {subjects}.'],
  ['Configured', 'config', 'Configured {subjects} for {client}.'],
  ['Set up', 'config', 'Set up and configured {subjects} for {client}.'],
  ['Deployed', 'config', 'Deployed {subjects} for {client}.'],
  ['Installed', 'config', 'Installed {subjects} for {client}.'],
  ['Managed', 'config', 'Managed {subjects} for {client}.'],
  ['Updated', 'config', 'Updated {subjects} for {client}.'],
  ['Migrated', 'config', 'Carried out the migration of {subjects} for {client}.'],
  ['Reviewed', 'config', 'Reviewed {subjects} for {client}.'],
  ['Monitored', 'config', 'Monitored {subjects} for {client}.'],
  ['Liaised', 'config', 'Liaised with {client} regarding {subjects}.'],
  ['Followed up', 'config', 'Followed up with {client} regarding {subjects}.'],
];

// [name, problem_phrase, config_phrase]
const REPORT_ISSUES = [
  ['Outlook', 'Outlook connectivity and mailbox', 'Outlook profiles and mailboxes'],
  ['RDP', 'Remote Desktop access', 'Remote Desktop (RDP) access'],
  ['Proclaim', 'Proclaim login and access', 'Proclaim user access'],
  ['OneDrive', 'OneDrive syncing', 'OneDrive data transfer and syncing'],
  ['Duo MFA', 'Duo MFA sign-in', 'Duo multi-factor authentication'],
  ['M365 Users', 'Microsoft 365 account', 'Microsoft 365 user accounts'],
  ['Licences', 'Microsoft 365 licensing', 'Microsoft 365 users and licences'],
  ['Permissions', 'user permission', 'Microsoft 365 user permissions'],
  ['Email', 'email delivery', 'email accounts'],
  ['SMTP', 'SMTP mail relay', 'SMTP settings'],
  ['Google Workspace', 'Google Workspace account', 'Google Workspace users'],
  ['Teams', 'Microsoft Teams', 'Microsoft Teams'],
  ['SharePoint', 'SharePoint access', 'SharePoint sites and permissions'],
  ['Intune', 'Intune device enrolment', 'Intune device management'],
  ['Laptop', 'laptop', 'a new laptop'],
  ['Desktop', 'desktop PC', 'a new desktop PC'],
  ['Printer', 'printing', 'printers'],
  ['Network', 'network connectivity', 'network settings'],
  ['Wi-Fi', 'Wi-Fi connectivity', 'wireless access points'],
  ['Firewall', 'firewall', 'firewall rules and settings'],
  ['VOIP', 'VoIP call quality and connectivity', 'VoIP users and settings'],
  ['NAS', 'NAS access', 'NAS storage and shares'],
  ['Backups', 'backup', 'MSP backups'],
  ['Threat Locker', 'Threat Locker application blocking', 'Threat Locker policies'],
  ['1Password', '1Password access', '1Password vaults and users'],
  ['Windows', 'Windows system', 'Windows updates and settings'],
  ['Mac', 'macOS system', 'macOS settings'],
  ['Software', 'software', 'software installation'],
  ['DNS/Domain', 'DNS and domain', 'domain and DNS records'],
  ['Website', 'website', 'website'],
  ['Server', 'server', 'server settings'],
  ['Digital Signage', 'digital signage display', 'digital signage screens and playlists'],
];

async function main() {
  const added = { categories: 0, services: 0, steps: 0, actions: 0, issues: 0 };

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

  await transaction(async (conn) => {
    for (const [i, [name, phraseType, template]] of REPORT_ACTIONS.entries()) {
      const [[exists]] = await conn.query('SELECT id FROM report_actions WHERE name = ?', [name]);
      if (exists) continue;
      await conn.query(
        'INSERT INTO report_actions (name, template, phrase_type, sort_order) VALUES (?, ?, ?, ?)',
        [name, template, phraseType, i]
      );
      added.actions++;
    }
    for (const [name, problemPhrase, configPhrase] of REPORT_ISSUES) {
      const [[exists]] = await conn.query('SELECT id FROM report_issues WHERE name = ?', [name]);
      if (exists) continue;
      await conn.query(
        'INSERT INTO report_issues (name, problem_phrase, config_phrase) VALUES (?, ?, ?)',
        [name, problemPhrase, configPhrase]
      );
      added.issues++;
    }
  });

  console.log(`Seed complete: ${added.categories} categories, ${added.services} services, ${added.steps} steps, `
    + `${added.actions} report actions, ${added.issues} report issues added.`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
