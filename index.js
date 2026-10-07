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
const { ASSET_STATUSES, CONNECTIONS } = require('./src/lib/inventory');
const { mailStatus } = require('./src/lib/mailer');
const { sendDueReminderEmails } = require('./src/lib/reminders');
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
      // Mermaid writes inline styles into the SVGs it renders.
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

app.locals.fonts = fonts;
app.locals.ticketStatuses = TICKET_STATUSES;
app.locals.ticketPriorities = TICKET_PRIORITIES;
app.locals.activityLabels = ACTION_LABELS;
app.locals.invAssetStatuses = ASSET_STATUSES;
app.locals.invConnections = CONNECTIONS;
app.locals.navItems = [
  { key: 'dashboard', href: '/', label: 'Dashboard', icon: 'home' },
  { key: 'clients', href: '/clients', label: 'Clients', icon: 'briefcase' },
  { key: 'tickets', href: '/tickets', label: 'Tickets', icon: 'message' },
  { key: 'services', href: '/services', label: 'Services', icon: 'layers' },
  { key: 'kb', href: '/kb', label: 'General IT Support', icon: 'book' },
  { key: 'report', href: '/report', label: 'Daily Report', icon: 'calendar' },
  { key: 'inventory', href: '/inventory', label: 'Inventory', icon: 'clipboard' },
  { key: 'users', href: '/users', label: 'Users', icon: 'users' },
];
app.locals.icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
// Default date formatting ("7 Oct 2026, 15:00", UK time). Signed-in requests get the
// user's own format in res.locals (src/middleware/auth.js).
Object.assign(app.locals, formattersFor());
app.locals.dateFormats = DATE_FORMATS;
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
  ['/kb', 'kb'],
  ['/report', 'report'], ['/log-work', 'report'], ['/activity', 'report'],
  ['/inventory', 'inventory'],
];
app.use((req, res, next) => {
  const hit = NAV_PREFIXES.find(([prefix]) => req.path === prefix || req.path.startsWith(`${prefix}/`));
  res.locals.nav = hit ? hit[1] : req.path === '/' ? 'dashboard' : '';
  next();
});

// ---- Routes ----

app.use(require('./src/routes/auth'));
app.use(requireAuth);

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
  }
  next();
});

app.use('/', require('./src/routes/dashboard'));
app.use('/users', require('./src/routes/users'));
app.use('/profile', require('./src/routes/profile'));
app.use('/tickets', require('./src/routes/tickets'));
app.use(require('./src/routes/services'));
app.use(require('./src/routes/clients'));
app.use('/kb', require('./src/routes/kb'));
app.use('/files', require('./src/routes/files'));
app.use('/avatars', require('./src/routes/avatars'));
app.use('/log-work', require('./src/routes/activity'));
app.use('/report', require('./src/routes/report'));
app.use('/activity', require('./src/routes/activity-log'));
app.use('/reminders', require('./src/routes/reminders'));
app.use('/notifications', require('./src/routes/notifications'));
app.use('/inventory', require('./src/routes/inventory'));

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

// Reminder emails: every minute, email each newly due reminder to its user (once per
// due time, see src/lib/reminders.js). Without SMTP settings this does nothing.
const mail = mailStatus();
if (!mail.enabled) console.warn(mail.message);
let emailing = false;
async function emailDueReminders() {
  if (emailing) return;
  emailing = true;
  try {
    await sendDueReminderEmails();
  } catch (err) {
    console.error('Reminder emails failed:', err.message);
  } finally {
    emailing = false;
  }
}
setTimeout(emailDueReminders, 15 * 1000).unref();
setInterval(emailDueReminders, 60 * 1000).unref();
