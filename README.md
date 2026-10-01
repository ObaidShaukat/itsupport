# itsupport

Cleartwo IT support portal: clients, service checklists with flowcharts and tutorials, tickets, and a General IT Support knowledge base.

Built with Express, EJS, MySQL (mysql2), express-session (sessions stored in MySQL), bcrypt, helmet, multer (uploads) and marked (Markdown). It runs under PM2.

## Server setup

### 1. Requirements

- Node.js 22.12 or later (or 20.19+), and npm. The Markdown library needs `require()` of ES modules, which older versions lack.
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
| `UPLOAD_DIR` | Optional. Folder for uploaded files. Defaults to `uploads/` in the app folder |

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

### 6. Test in the foreground

```bash
npm start            # node index.js; press Ctrl+C to stop
```

### 7. Run with PM2

PM2 is run manually, not through npm scripts:

```bash
pm2 start pm2.config.cjs
pm2 save             # remember the process list
pm2 startup          # (once) start PM2 on boot; follow its instructions
```

Other commands:

```bash
pm2 restart itsupport
pm2 stop itsupport
pm2 logs itsupport
```

The repository's `pm2.config.cjs` is deliberately minimal (app name `itsupport`, script `index.js`). If the server keeps its own `pm2.config.cjs`, keep the app name `itsupport` so the commands above still work.

### 8. Updating

```bash
git pull
npm install
npm run migrate
pm2 restart itsupport
```

## Uploads

Tutorials (on each service) and knowledge base attachments are stored on disk in `uploads/`, or in `UPLOAD_DIR` if you set it. Files are saved under random names, kept out of `public/`, and only served to signed-in users at `/files/<name>`.

- **Size limit:** 500 MB per file. Large uploads are allowed up to an hour per request.
- **What opens in the browser:** images (png, jpg, gif, webp, avif, bmp), videos (mp4, webm) and PDFs. Every other file type, including SVG and HTML, is always downloaded, never opened in the page.
- **Reverse proxy:** if nginx sits in front of the app, raise its limits or large uploads will fail with "413 Request Entity Too Large":

  ```nginx
  client_max_body_size 500m;
  proxy_request_buffering off;
  proxy_read_timeout 3600s;
  ```

  IIS (`maxAllowedContentLength`) and other proxies have equivalent settings.
- **Backups:** `uploads/` is git-ignored and is not in the database. Back it up together with the MySQL database.
- **Cleanup:** deleting a tutorial, an attachment, an article, a service or a category also deletes its files from disk.

## Branding assets

- **Logo:** `public/logo.png` (served at `/logo.png`) appears in the sidebar and on the sign-in page. Until it exists, the text "Cleartwo" is shown instead. It's picked up without a restart.
- **Favicon:** `public/favicon.svg` (served at `/favicon.svg`).
- **Fonts:** put Kollektif and Made Tommy files (`.woff2`, `.woff`, `.ttf` or `.otf`) in `public/fonts/`. They're matched by file name, so names should contain "Kollektif" or "Made Tommy" (for example `Kollektif-Bold.woff2`). Weight is read from the name (Regular, Medium, Bold, ExtraBold, Black). Restart the app after adding fonts. Until they're present, the portal uses Poppins from Google Fonts.

## Project layout

```
index.js              App entry: middleware, sessions, routes
pm2.config.cjs        PM2 process definition
db/schema.sql         Table definitions (npm run migrate)
scripts/              migrate, seed and create-user scripts
src/routes/           auth, dashboard, users, services (+ tutorials), clients, tickets, kb, files
src/middleware/       login check and CSRF protection
src/lib/              helpers (ordering, Mermaid flowcharts, fonts, validation)
views/                EJS templates
public/               CSS, JS, fonts, images
uploads/              uploaded files (git-ignored, created automatically)
```
