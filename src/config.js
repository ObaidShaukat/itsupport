require('dotenv').config({ quiet: true });

module.exports = {
  sessionSecret: process.env.SESSION_SECRET,
  // Set COOKIE_SECURE=true when the portal is served over HTTPS.
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  // Set TRUST_PROXY=true when running behind a reverse proxy (nginx, IIS, etc.).
  trustProxy: process.env.TRUST_PROXY === 'true',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
  },
};
