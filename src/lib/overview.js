// Section overview pages (/microsoft, /cloudflare, /inventory, /call-switch-one; src/routes/
// overview.js, views/overview.ejs): one card per sub-section of a top-bar group with an icon,
// a short description and 1-3 live numbers. Each number: { label, value, alert } (alert = shown
// with a red LED when above 0). Read only.
const { pool } = require('../db');

const n = (v) => Number(v) || 0;

async function microsoft(db) {
  const { listRelationships, LIVE } = require('./gdap/data'); // eslint-disable-line global-require
  const { gdapConfig } = require('./gdap/graph'); // eslint-disable-line global-require
  const { dashboardEmail } = require('./m365/data'); // eslint-disable-line global-require
  const { rows } = await listRelationships(db);
  const shown = rows.filter((r) => !r.hidden && !r.removed);
  const live = shown.filter((r) => LIVE.has(r.status));
  const soon = live.filter((r) => !r.expired && r.days !== null && r.days <= 30).length;
  const expired = shown.filter((r) => r.expired || r.status === 'expired').length;
  const email = await dashboardEmail(db);
  return {
    title: 'Microsoft',
    intro: 'Microsoft Partner (GDAP) relationships and Microsoft 365 email health.',
    cards: [
      {
        href: '/microsoft/partner', icon: 'shield', title: 'Microsoft Partner',
        description: gdapConfig().configured ? 'GDAP relationships with customers, from Microsoft Graph (read only), with expiry alerts.' : 'GDAP relationships with customers. Not configured yet: add the Microsoft Graph keys to .env.',
        stats: [
          { label: 'GDAP expiring ≤30 days', value: soon, alert: soon > 0 },
          { label: 'Expired', value: expired, alert: expired > 0 },
          { label: 'Active', value: shown.filter((r) => r.status === 'active' && !r.expired).length },
        ],
      },
      {
        href: '/microsoft/email-services', icon: 'mail', title: 'Email Services',
        description: 'Microsoft 365 email records (MX, SPF, Autodiscover, DKIM, DMARC) of each domain, from public DNS.',
        stats: email ? [
          { label: 'Email domains with issues', value: email.issues, alert: email.issues > 0 },
          { label: 'Healthy', value: email.healthy },
          { label: 'Microsoft 365 domains', value: email.m365 },
        ] : [{ label: 'Domains', value: 0 }],
      },
    ],
  };
}

async function cloudflare(db) {
  const { listDomains, listAccounts } = require('./cloudflare/data'); // eslint-disable-line global-require
  const { cfConfig } = require('./cloudflare/api'); // eslint-disable-line global-require
  const domains = (await listDomains(db)).filter((d) => !d.hidden);
  const accounts = await listAccounts(db);
  const configured = cfConfig().configured;
  const problems = domains.filter((d) => d.problem).length;
  const expiring = domains.filter((d) => !d.problem && d.expiring).length;
  const lost = accounts.filter((a) => a.access_lost).length;
  return {
    title: 'Cloudflare',
    intro: 'Our Cloudflare domains and accounts, checked every 6 hours (read only).',
    cards: [
      {
        href: '/cloudflare/domains', icon: 'globe', title: 'Domains',
        description: configured ? 'Every zone in our Cloudflare accounts: nameservers, moves and deletions, and expiry dates.' : 'Every zone in our Cloudflare accounts. Not configured yet: add CLOUDFLARE_API_TOKEN to .env.',
        stats: [
          { label: 'Problems', value: problems, alert: problems > 0 },
          { label: 'Expiring in 30 days', value: expiring, alert: expiring > 0 },
          { label: 'Domains', value: domains.length },
        ],
      },
      {
        href: '/cloudflare/accounts', icon: 'server', title: 'Accounts',
        description: 'The Cloudflare accounts the API token can read, with their domains and problems.',
        stats: [
          { label: 'Accounts', value: accounts.length },
          { label: 'Access lost', value: lost, alert: lost > 0 },
        ],
      },
    ],
  };
}

async function inventory(db) {
  const { listTabs, tabUrl } = require('./inventory/records'); // eslint-disable-line global-require
  const tabs = await listTabs(db);
  const [recs] = await db.query('SELECT tab_id, status, COUNT(*) AS n FROM inventory_records GROUP BY tab_id, status');
  const [stock] = await db.query('SELECT status, COUNT(*) AS n FROM stock_items GROUP BY status');
  const count = (tabId, status = null) => recs.filter((r) => r.tab_id === tabId && (!status || r.status === status)).reduce((s, r) => s + n(r.n), 0);
  const stockOf = (st) => stock.filter((r) => !st || st.includes(r.status)).reduce((s, r) => s + n(r.n), 0);
  const employees = tabs.find((t) => t.kind === 'employees');
  const ICONS = { employees: 'users', ex_employees: 'users', stock: 'box', records: 'clipboard' };
  const cards = tabs.map((t) => {
    let description;
    let stats;
    if (t.kind === 'employees') {
      description = 'Our staff: details, accounts and the equipment each person holds.';
      stats = [{ label: 'Active employees', value: count(t.id, 'active') }];
    } else if (t.kind === 'ex_employees') {
      description = 'People who have left, kept read only with their leaving date.';
      stats = [{ label: 'Ex employees', value: employees ? count(employees.id, 'inactive') : 0 }];
    } else if (t.kind === 'stock') {
      description = 'Every physical item: who has it, what is in stock, repairs.';
      const needs = stockOf(['repair', 'damaged']);
      stats = [
        { label: 'In stock', value: stockOf(['available']) },
        { label: 'Assigned', value: stockOf(['assigned']) },
        ...(needs ? [{ label: 'Repair / damaged', value: needs, alert: true }] : []),
      ];
    } else {
      description = `Records in ${t.name}.`;
      stats = [{ label: 'Records', value: count(t.id) }];
    }
    return { href: tabUrl(t), icon: ICONS[t.kind] || 'clipboard', title: t.name, description, stats };
  });
  cards.push({
    href: '/inventory/workbook', icon: 'download', title: 'Import / Export',
    description: 'The whole inventory as one Excel workbook, and importing one back.', stats: [],
  });
  return { title: 'Inventory', intro: 'Our own staff, accounts and kit (internal, never clients).', cards };
}

async function callSwitchOne(db) {
  const [[c]] = await db.query(`
    SELECT SUM(removed_at IS NULL AND COALESCE(is_demo, 0) = 0) AS customers,
           SUM(removed_at IS NULL AND COALESCE(is_demo, 0) = 0 AND identifier IS NULL) AS missing
    FROM cs1_customers
  `);
  const [[run]] = await db.query('SELECT billing_month, sent_at FROM cs1_runs ORDER BY billing_month DESC LIMIT 1');
  const [[lines]] = run
    ? await db.query('SELECT COUNT(*) AS n FROM cs1_lines l JOIN cs1_runs r ON r.id = l.run_id WHERE r.billing_month = ?', [run.billing_month])
    : [[{ n: 0 }]];
  const month = run ? new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(run.billing_month)) : null;
  return {
    title: 'Call Switch One',
    intro: 'CallSwitch One customers and the monthly call charges.',
    cards: [
      {
        href: '/call-switch-one/customers', icon: 'phone', title: 'Customers',
        description: 'CallSwitch One customers (read only from CallSwitch), with their CS1 IDs and linked portal clients.',
        stats: [
          { label: 'Customers', value: n(c.customers) },
          { label: 'Missing CS1 ID', value: n(c.missing), alert: n(c.missing) > 0 },
        ],
      },
      {
        href: '/call-switch-one/billing', icon: 'file', title: 'Billing',
        description: run ? `Monthly CDR upload, review and email. Latest: ${month}${run.sent_at ? ' (sent)' : ' (not sent yet)'}.` : 'Monthly CDR upload, review and email. Nothing uploaded yet.',
        stats: run ? [{ label: `CS1 IDs in ${month}`, value: n(lines.n) }] : [],
      },
    ],
  };
}

const SECTIONS = {
  microsoft: { path: '/microsoft', nav: 'microsoft', build: microsoft },
  cloudflare: { path: '/cloudflare', nav: 'cloudflare', build: cloudflare },
  inventory: { path: '/inventory', nav: 'inventory', build: inventory },
  cs1: { path: '/call-switch-one', nav: 'cs1', build: callSwitchOne },
};

async function overview(key, db = pool) {
  const s = SECTIONS[key];
  return { ...(await s.build(db)), path: s.path, nav: s.nav };
}

module.exports = { overview, SECTIONS };
