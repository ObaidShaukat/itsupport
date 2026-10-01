# itsupport

Cleartwo IT support portal: clients, service checklists with flowcharts, and tickets.

Built with Express, EJS, MySQL (mysql2), express-session (sessions stored in MySQL), bcrypt and helmet. It runs under PM2.

## Server setup

### 1. Requirements

- Node.js 20 or later, and npm
- MySQL 8 (or MariaDB 10.5+)
- PM2: `npm install -g pm2`

### 2. Create the database and a MySQL user

```sql
CREATE DATABASE itsupport CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'itsupport'@'localhost' IDENTIFIED BY 'choose-a-strong-password';
GRANT ALL PRIVILEGES ON itsupport.* TO 'itsupport'@'localhost';
FLUSH PRIVILEGES;
```

### 3. Get the code and install dependencies

```bash
git clone https://github.com/ObaidShaukat/itsupport.git
cd itsupport
npm install
```

If npm reports that install scripts were blocked for `bcrypt`, it still works, because bcrypt ships prebuilt binaries for Linux, Windows and macOS. If `require('bcrypt')` fails on your platform, run `npm install-scripts approve bcrypt` and then `npm rebuild bcrypt`.

### 4. Configure `.env`

```bash
cp .env.example .env
```

Fill in:

| Key | Meaning |
| --- | --- |
| `PORT` | Port the app listens on (5009) |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL connection |
| `SESSION_SECRET` | Long random string. Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `COOKIE_SECURE` | `true` when users reach the portal over HTTPS |
| `TRUST_PROXY` | `true` when running behind nginx, IIS or another reverse proxy |

`.env` is git-ignored. Never commit it.

### 5. Create the tables, seed the services and add the first user

```bash
npm run migrate
npm run seed
npm run create-user -- admin 'a-strong-password'
```

- `migrate` creates any missing tables (from `db/schema.sql`). It is safe to re-run after every update.
- `seed` adds the default service categories, services and steps. It is safe to run more than once: anything that already exists is left alone.
- `create-user` adds a user with a bcrypt-hashed password. Users only live in the database. Add more from the Users page once you're signed in. The password is visible in your shell history, so clear it or reset the password from the Users page afterwards.

The sessions table is created automatically the first time the app starts.

### 6. Start with PM2

```bash
npm start            # pm2 start pm2.config.cjs
pm2 save             # remember the process list
pm2 startup          # (once) start PM2 on boot; follow its instructions
```

Other commands:

```bash
npm run restart      # pm2 restart itsupport
npm run stop         # pm2 stop itsupport
pm2 logs itsupport   # view logs
npm run dev          # run in the foreground without PM2 (node index.js)
```

The repository's `pm2.config.cjs` is deliberately minimal (app name `itsupport`, script `index.js`). If the server keeps its own `pm2.config.cjs`, keep the app name `itsupport` so the npm scripts still work.

### 7. Updating

```bash
git pull
npm install
npm run migrate
npm run restart
```

## Branding assets

- **Logo:** put `public/img/logo.svg` in place and it appears in the sidebar and on the sign-in page. It's picked up without a restart.
- **Fonts:** put Kollektif and Made Tommy files (`.woff2`, `.woff`, `.ttf` or `.otf`) in `public/fonts/`. They're matched by file name, so names should contain "Kollektif" or "Made Tommy" (for example `Kollektif-Bold.woff2`). Weight is read from the name (Regular, Medium, Bold, ExtraBold, Black). Restart the app after adding fonts. Until they're present, the portal uses Poppins from Google Fonts.

## Project layout

```
index.js              App entry: middleware, sessions, routes
pm2.config.cjs        PM2 process definition
db/schema.sql         Table definitions (npm run migrate)
scripts/              migrate, seed and create-user scripts
src/routes/           auth, dashboard, users, services, clients, tickets
src/middleware/       login check and CSRF protection
src/lib/              helpers (ordering, Mermaid flowcharts, fonts, validation)
views/                EJS templates
public/               CSS, JS, fonts, images
```
