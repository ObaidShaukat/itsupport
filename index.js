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
const { detectFonts } = require('./src/lib/fonts');
const { TICKET_STATUSES } = require('./src/lib/tickets');

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
      imgSrc: ["'self'", 'data:'],
      // Leave http as http if the portal is reached without TLS.
      upgradeInsecureRequests: null,
    },
  },
}));

// ---- View helpers ----

const fonts = detectFonts();
const LOGO_PATH = path.join(__dirname, 'public', 'img', 'logo.svg');

app.locals.fonts = fonts;
app.locals.ticketStatuses = TICKET_STATUSES;
app.locals.navItems = [
  { key: 'dashboard', href: '/', label: 'Dashboard', icon: 'home' },
  { key: 'clients', href: '/clients', label: 'Clients', icon: 'briefcase' },
  { key: 'tickets', href: '/tickets', label: 'Tickets', icon: 'message' },
  { key: 'services', href: '/services', label: 'Services', icon: 'layers' },
  { key: 'users', href: '/users', label: 'Users', icon: 'users' },
];
app.locals.icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
app.locals.fmtDate = (value) => (value
  ? new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London' })
  : '');

// ---- Static files (served before sessions so they never touch the database) ----

app.get('/css/fonts.css', (req, res) => {
  res.type('text/css').send(fonts.css);
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ---- Sessions, forms and CSRF ----

app.use(express.urlencoded({ extended: false, limit: '200kb' }));

const sessionStore = new MySQLStore({
  expiration: SESSION_HOURS * 60 * 60 * 1000,
  createDatabaseTable: true,
}, pool);

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

// Highlights the current section in the sidebar.
const NAV_PREFIXES = [
  ['/clients', 'clients'], ['/client-services', 'clients'],
  ['/tickets', 'tickets'],
  ['/services', 'services'], ['/categories', 'services'], ['/steps', 'services'],
  ['/users', 'users'],
];
app.use((req, res, next) => {
  const hit = NAV_PREFIXES.find(([prefix]) => req.path === prefix || req.path.startsWith(`${prefix}/`));
  res.locals.nav = hit ? hit[1] : req.path === '/' ? 'dashboard' : '';
  next();
});

// ---- Routes ----

app.use(require('./src/routes/auth'));
app.use(requireAuth);
app.use('/', require('./src/routes/dashboard'));
app.use('/users', require('./src/routes/users'));
app.use('/tickets', require('./src/routes/tickets'));
app.use(require('./src/routes/services'));
app.use(require('./src/routes/clients'));

// ---- Errors ----

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'Page not found.' });
});

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return next(err);
  res.status(status).render('error', {
    title: status === 404 ? 'Not found' : status === 403 ? 'Forbidden' : 'Error',
    message: status >= 500 ? 'Something went wrong. Please try again.' : err.message,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
