require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const helmet = require('helmet');

const config = require('./src/config');
const { pool } = require('./src/db');
const csrf = require('./src/middleware/csrf');
const { requireAuth } = require('./src/middleware/auth');
const multipart = require('./src/middleware/multipart');
const { detectFonts } = require('./src/lib/fonts');
const { TICKET_STATUSES, TICKET_PRIORITIES } = require('./src/lib/tickets');
const { ACTION_LABELS, londonDate } = require('./src/lib/activity');
const { STOCK_STATUSES, FIELD_TYPES } = require('./src/lib/inventory/fields');
const { mailStatus } = require('./src/lib/mailer');
const { sendDueReminderEmails, sendDueReminderPushes } = require('./src/lib/reminders');
const { pushStatus } = require('./src/lib/push');
const { channelsOf } = require('./src/lib/notify');
const cron = require('node-cron');
const { syncGdap } = require('./src/lib/gdap/sync');
const { runDailyChecks } = require('./src/lib/gdap/alerts');
const { gdapConfig } = require('./src/lib/gdap/graph');
const { cfConfig } = require('./src/lib/cloudflare/api');
const { runChecks: runCloudflareChecks } = require('./src/lib/cloudflare/check');
const { runRdapQueue } = require('./src/lib/cloudflare/rdap');
const { syncCustomers: syncCs1Customers } = require('./src/lib/cs1/sync');
const { cs1ApiConfig } = require('./src/lib/cs1/api');
const { DATE_FORMATS, formattersFor } = require('./src/lib/dates');
const { avatarHelper } = require('./src/lib/avatars');
const { setStore } = require('./src/lib/sessions');

if (!config.sessionSecret) {
  console.error('SESSION_SECRET is not set in .env');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5009;
const SESSION_HOURS = 8;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (config.trustProxy) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      // Inline style attributes carry CSS variables (bar heights, progress widths).
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      // https: so email signature images (linked by URL) show in the signature preview.
      imgSrc: ["'self'", 'data:', 'https:'],
      // Leave http as http if the portal is reached without TLS.
      upgradeInsecureRequests: null,
    },
  },
}));

// ---- View helpers ----

const fonts = detectFonts();
const LOGO_PATH = path.join(__dirname, 'public', 'logo.png');
// The top bar shows public/logo.png when it is there, otherwise the round mark (public/logo.jpg).
const LOGO_JPG = path.join(__dirname, 'public', 'logo.jpg');

app.locals.fonts = fonts;
app.locals.ticketStatuses = TICKET_STATUSES;
app.locals.ticketPriorities = TICKET_PRIORITIES;
app.locals.activityLabels = ACTION_LABELS;
app.locals.stockStatuses = STOCK_STATUSES;
app.locals.invFieldTypes = FIELD_TYPES;
// The pill navigation in the top bar, in this order. Groups (group: true) open a dropdown of
// their sub-items (children; Inventory's are its tabs, loaded per page as navInvTabs). Add more
// Call Switch One tools (Devices, Numbers...) as children here. Users is in the avatar menu.
// secondary: true items move into a "More" pill on screens 1024-1439px wide (head.ejs).
app.locals.navItems = [
  { key: 'dashboard', href: '/', label: 'Dashboard', icon: 'home' },
  { key: 'tickets', href: '/tickets', label: 'Tickets', icon: 'message' },
  { key: 'clients', href: '/clients', label: 'Clients', icon: 'briefcase' },
  { key: 'services', href: '/services', label: 'Services', icon: 'layers' },
  { key: 'kb', href: '/articles', label: 'Articles', icon: 'book' },
  { key: 'report', href: '/report', label: 'Daily Report', icon: 'calendar', secondary: true },
  { key: 'inventory', href: '/inventory', label: 'Inventory', icon: 'clipboard', group: true },
  { key: 'gdap', href: '/microsoft-partner', label: 'Microsoft Partner', icon: 'shield', secondary: true },
  {
    key: 'cloudflare', href: '/cloudflare/domains', label: 'Cloudflare', icon: 'globe', group: true, secondary: true,
    children: [
      { href: '/cloudflare/domains', label: 'Domains', match: '/cloudflare/domains' },
      { href: '/cloudflare/accounts', label: 'Accounts', match: '/cloudflare/accounts' },
    ],
  },
  {
    key: 'cs1', href: '/call-switch-one/billing', label: 'Call Switch One', icon: 'phone', group: true, secondary: true,
    children: [
      { href: '/call-switch-one/customers', label: 'Customers', match: '/call-switch-one/customers' },
      { href: '/call-switch-one/billing', label: 'Billing', match: '/call-switch-one/billing' },
    ],
  },
];
// Spellchecker files version (meta tag; the worker loads /spell/... with it, cached for a year).
app.locals.spellVersion = require('./src/lib/spell').SPELL_VERSION;
app.locals.icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
// Default date formatting ("7 Oct 2026, 15:00", UK time). Signed-in requests get the
// user's own format in res.locals (src/middleware/auth.js).
Object.assign(app.locals, formattersFor());
app.locals.dateFormats = DATE_FORMATS;
// First name for compact lists: 'Obaid Shaukat' -> 'Obaid', 'sam.jones@x.co' -> 'Sam'.
app.locals.firstName = (name) => {
  const first = String(name || '').trim().replace(/@.*$/, '').split(/[\s._-]+/)[0] || '';
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : '';
};
// Avatars without a user list: initials only (pages get the real helper below).
app.locals.avatar = avatarHelper([]);
app.locals.fmtBytes = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
};

// ---- Static files (served before sessions so they never touch the database) ----

app.get('/css/fonts.css', (req, res) => {
  res.type('text/css').send(fonts.css);
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ---- Sessions, forms and CSRF ----

app.use(express.urlencoded({ extended: false, limit: '2mb' }));
// Express 5 leaves req.body undefined when no parser ran (GET links, fetch() without a
// body). Routes read req.body.x, so give them an empty object as Express 4 did. Multipart
// uploads are parsed later (src/middleware/multipart.js), which replaces it.
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

const sessionStore = new MySQLStore({
  expiration: SESSION_HOURS * 60 * 60 * 1000,
  createDatabaseTable: true,
}, pool);
setStore(sessionStore); // for "Active sessions" on My profile

app.use(session({
  name: 'itsupport.sid',
  secret: config.sessionSecret,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
  },
}));

app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.hasLogo = fs.existsSync(LOGO_PATH);
  res.locals.logoMark = fs.existsSync(LOGO_JPG) ? '/logo.jpg' : '/favicon.svg';
  next();
});

app.use(csrf);
app.use(multipart);

// Highlights the current section in the sidebar.
const NAV_PREFIXES = [
  ['/clients', 'clients'], ['/client-services', 'clients'], ['/client-service-notes', 'clients'],
  ['/tickets', 'tickets'],
  ['/services', 'services'], ['/categories', 'services'], ['/steps', 'services'],
  ['/users', 'users'],
  ['/profile', 'profile'],
  ['/articles', 'kb'],
  ['/report', 'report'], ['/log-work', 'report'], ['/activity', 'report'],
  ['/inventory', 'inventory'],
  ['/call-switch-one', 'cs1'],
  ['/cloudflare', 'cloudflare'],
  ['/settings', 'dictionary'],
];
app.use((req, res, next) => {
  // The current top-bar nav item (and group) for this page.
  const hit = NAV_PREFIXES.find(([prefix]) => req.path === prefix || req.path.startsWith(`${prefix}/`));
  res.locals.nav = hit ? hit[1] : req.path === '/' ? 'dashboard' : '';
  next();
});

// ---- Routes ----

app.use(require('./src/routes/auth'));
app.use(requireAuth);
// Spellchecker files and word lists: before the per-page data below (no page queries).
app.use('/spell', require('./src/routes/spell'));

// Data for the "Log work" dialog in the top bar of every page.
app.use(async (req, res, next) => {
  res.locals.today = londonDate();
  res.locals.currentPath = req.originalUrl;
  // Only full pages need these, not file downloads or fetch() calls.
  const page = !req.path.startsWith('/files/') && !req.path.startsWith('/avatars/') && req.accepts(['html', 'json']) === 'html';
  if (page && req.method === 'GET') {
    const [clients] = await pool.query('SELECT name FROM clients ORDER BY name');
    res.locals.logWorkClients = clients.map((c) => c.name);
  }
  if (page) {
    // Profile pictures (or initials) wherever a user is shown: avatar({ id, name }).
    const [people] = await pool.query("SELECT id, COALESCE(NULLIF(display_name, ''), username) AS name, avatar_file FROM users");
    res.locals.avatar = avatarHelper(people);
    // Inventory tabs for the sidebar group (on every page, so it can be opened anywhere).
    const [invTabs] = await pool.query('SELECT id, kind, name FROM inventory_tabs ORDER BY sort_order, id');
    res.locals.navInvTabs = invTabs.map((t) => ({ label: t.name, href: t.kind === 'stock' ? '/inventory/stock' : `/inventory/t/${t.id}` }));
    // Desktop notifications: the VAPID public key for the banner / My profile toggle.
    const push = pushStatus();
    res.locals.push = { enabled: push.enabled, publicKey: push.publicKey || '', message: push.message || '', wanted: channelsOf(req.user).has('desktop') };
    // Quick-action rail "Add reminder": the open tickets to pick from.
    if (req.method === 'GET') {
      const [quick] = await pool.query(`
        SELECT t.id, t.title, c.name AS client_name FROM tickets t JOIN clients c ON c.id = t.client_id
        WHERE t.status <> 'closed' ORDER BY t.updated_at DESC LIMIT 200
      `);
      res.locals.quickTickets = quick;
    }
  }
  next();
});

app.use('/', require('./src/routes/dashboard'));
app.use('/users', require('./src/routes/users'));
app.use('/profile', require('./src/routes/profile'));
app.use('/tickets', require('./src/routes/tickets'));
app.use(require('./src/routes/services'));
app.use(require('./src/routes/clients'));
app.use('/articles', require('./src/routes/kb'));
// Old addresses: /kb/... -> /articles/... (and /gdap/... -> /microsoft-partner/...), keeping
// the method for forms posted from a page loaded before the rename.
const moved = (to) => (req, res) => res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, to + (req.url === '/' ? '' : req.url.startsWith('/?') ? req.url.slice(1) : req.url));
app.use('/kb', moved('/articles'));
app.use('/files', require('./src/routes/files'));
app.use('/avatars', require('./src/routes/avatars'));
app.use('/log-work', require('./src/routes/activity'));
app.use('/report', require('./src/routes/report'));
app.use('/activity', require('./src/routes/activity-log'));
app.use('/reminders', require('./src/routes/reminders'));
app.use('/notifications', require('./src/routes/notifications'));
app.use('/push', require('./src/routes/push'));
app.use('/microsoft-partner', require('./src/routes/gdap'));
app.use('/gdap', moved('/microsoft-partner'));
app.use('/cloudflare', require('./src/routes/cloudflare'));
app.use('/call-switch-one', require('./src/routes/cs1'));
app.use('/inventory', require('./src/routes/inventory'));
app.use('/settings/dictionary', require('./src/routes/dictionary'));

// ---- Errors ----

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'Page not found.' });
});

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return next(err);
  const message = status >= 500 ? 'Something went wrong. Please try again.' : err.message;
  // fetch() calls (e.g. saving a step reorder) get JSON instead of a page.
  if (req.accepts(['html', 'json']) === 'json') return res.status(status).json({ ok: false, error: message });
  res.status(status).render('error', {
    title: status === 404 ? 'Not found' : status === 403 ? 'Forbidden' : 'Error',
    message,
  });
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
// Allow up to an hour per request so large uploads (up to 500 MB) are not cut off.
server.requestTimeout = 60 * 60 * 1000;

// Reminder emails and desktop notifications: every minute, email / push each newly due
// reminder to its recipients (once per due time, see src/lib/reminders.js). Without SMTP
// or VAPID settings that part does nothing.
const mail = mailStatus();
if (!mail.enabled) console.warn(mail.message);
const pushSetup = pushStatus();
if (!pushSetup.enabled) console.warn(pushSetup.message);
let emailing = false;
async function emailDueReminders() {
  if (emailing) return;
  emailing = true;
  try {
    await sendDueReminderEmails();
  } catch (err) {
    console.error('Reminder emails failed:', err.message);
  }
  // Desktop notifications for due reminders, on the same timer.
  try {
    await sendDueReminderPushes();
  } catch (err) {
    console.error('Reminder desktop notifications failed:', err.message);
  } finally {
    emailing = false;
  }
}
setTimeout(emailDueReminders, 15 * 1000).unref();
setInterval(emailDueReminders, 60 * 1000).unref();

// GDAP: sync with Microsoft every day at 07:00 UK, then the expiry alerts, the daily
// digest and the client secret reminder (src/lib/gdap). Without MS_* settings only the
// secret reminder runs. After a restart, a sync that is more than a day old is caught up.
let gdapBusy = false;
async function gdapDaily() {
  if (gdapBusy) return;
  gdapBusy = true;
  try {
    if (gdapConfig().configured) {
      const result = await syncGdap(null, { trigger: 'schedule' });
      if (!result.ok) console.error('GDAP sync failed:', result.error);
    }
    await runDailyChecks();
  } catch (err) {
    console.error('GDAP daily run failed:', err.message);
  } finally {
    gdapBusy = false;
  }
}
cron.schedule('0 7 * * *', gdapDaily, { timezone: 'Europe/London' });
if (!gdapConfig().configured) console.warn(gdapConfig().message);
setTimeout(async () => {
  if (!gdapConfig().configured) return;
  try {
    const [[row]] = await pool.query("SELECT MAX(started_at) AS last FROM gdap_sync_log WHERE status = 'ok'");
    if (!row.last || Date.now() - new Date(row.last).getTime() > 24 * 60 * 60 * 1000) await gdapDaily();
  } catch (err) {
    console.error('GDAP catch-up failed:', err.message);
  }
}, 90 * 1000).unref();

// Cloudflare (read only, src/lib/cloudflare): accounts, zones, public DNS nameservers and
// (once a day per domain) RDAP expiry, every 6 hours at 00:15 / 06:15 / 12:15 / 18:15 UK,
// then the alerts. After a restart, a check more than 6 hours old is caught up.
async function cloudflareCheck() {
  if (!cfConfig().configured) return;
  try {
    const result = await runCloudflareChecks(null, { trigger: 'schedule' });
    if (!result.ok) console.error('Cloudflare check failed:', result.error);
  } catch (err) {
    console.error('Cloudflare check failed:', err.message);
  }
}
cron.schedule('15 0,6,12,18 * * *', cloudflareCheck, { timezone: 'Europe/London' });
if (!cfConfig().configured) console.warn(cfConfig().message);
setTimeout(async () => {
  if (!cfConfig().configured) return;
  try {
    const [[row]] = await pool.query("SELECT MAX(finished_at) AS last FROM cf_check_log WHERE status = 'ok' AND trigger_type <> 'domain'");
    if (!row.last || Date.now() - new Date(row.last).getTime() > 6 * 60 * 60 * 1000) await cloudflareCheck();
  } catch (err) {
    console.error('Cloudflare catch-up failed:', err.message);
  }
}, 150 * 1000).unref();
// Domain expiry dates (RDAP, src/lib/cloudflare/rdap.js): straight after a start (so a deploy
// fills in every domain), then every hour for anything due or failed; at most one lookup a
// second, each domain once a day.
setTimeout(() => { runRdapQueue().catch((err) => console.error('RDAP queue failed:', err.message)); }, 45 * 1000).unref();
cron.schedule('40 * * * *', () => { runRdapQueue().catch((err) => console.error('RDAP queue failed:', err.message)); }, { timezone: 'Europe/London' });

// Call Switch One customers: read from the CallSwitch One API (read only) every day at
// 06:30 UK (src/lib/cs1/sync.js), caught up after a restart when the last good sync is
// more than a day old. A failure is stored and admins are alerted once a day.
async function cs1Daily() {
  if (!cs1ApiConfig().configured) return;
  try {
    const result = await syncCs1Customers(null, { trigger: 'schedule' });
    if (!result.ok) console.error('Call Switch One customer sync failed:', result.error);
  } catch (err) {
    console.error('Call Switch One customer sync failed:', err.message);
  }
}
cron.schedule('30 6 * * *', cs1Daily, { timezone: 'Europe/London' });
if (!cs1ApiConfig().configured) console.warn(cs1ApiConfig().message);
setTimeout(async () => {
  if (!cs1ApiConfig().configured) return;
  try {
    const [[row]] = await pool.query("SELECT MAX(started_at) AS last FROM cs1_sync_log WHERE status = 'ok' AND COALESCE(source, 'official') <> 'dashboard'");
    if (!row.last || Date.now() - new Date(row.last).getTime() > 24 * 60 * 60 * 1000) await cs1Daily();
  } catch (err) {
    console.error('Call Switch One catch-up failed:', err.message);
  }
}, 120 * 1000).unref();
