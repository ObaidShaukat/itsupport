# itsupport

Cleartwo IT support portal: clients, service checklists with flowcharts and tutorials, tickets, a General IT Support knowledge base, an activity log and a Daily Report.

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

## Tickets

Each ticket has a priority (Low, Normal, High, Urgent; Normal by default), set when it is created and changed on the ticket page. Priorities show as coloured flags: green, yellow, orange and red, with urgent and high pulsing. Ticket lists can be filtered by status and priority and sorted by any column. By default urgent tickets come first, then the most recently updated. Every change records who made it (Updated by) and when (Last updated, UK time).

## Activity log and Daily Report

Every create, update and delete (tickets, comments, client services, steps, notes, services, tutorials, KB articles, clients and users) is written to the `activity_log` table with the signed-in user and time. Records show "Created by … / Last updated by …" and a History panel built from it. Records created before the activity log existed fall back to their own created fields.

- **Log work:** the button in the top bar of every page records manual work: an optional client, a description and a date (default today). Each user can edit or delete their own entries from the Daily Report page.
- **Daily Report** (`/report`): pick a day (default today), step back and forward, or choose a date range (up to 62 days, grouped by day). Filter to one user or show everyone. The report is built only from the activity log. The chosen UK date (or range) is converted to a UTC start and end and matched against when each action happened, so an old ticket or article edited today shows up today. Manual Log work entries use the date that was picked. Each user's work is one bullet per item, grouped by client, for example "Provided IT support to Abel regarding Test: replaced the toner.", "Completed Create new tenant as part of Emails setup for Abel." or "Updated the knowledge base article 'Outlook not syncing': revised the issue description.", and ends with "Other IT related tasks." Deletes, unticked steps and user-admin changes are left out of the report but listed on `/activity`.
- **Report wording:** built from what was typed, one bullet per entry. Log work: "{text} for {client}." Ticket comments: "Provided IT support to {client} regarding {comment}." Notes: "{note} for {client} ({service})." Client services read "Commenced / Completed … for {client}", using the service's optional *Wording in the Daily Report*. Lines are tidied (capitalised, one full stop, "setup" becomes "Set up", no semicolons, no repeated client name) and ordered client services, tickets, log work, knowledge base, then "Other IT related tasks."
- **Copy buttons:** the report is shown in an editable preview. "Copy for email" copies what you see as Calibri 11pt with bold names and real bullets for Outlook, falling back to plain text. "Copy plain text" gives "- " bullets. Browsers only allow full clipboard access over HTTPS. Over plain http a fallback is used that works in current browsers.
- **Activity log page** (`/activity`, linked from the report): the raw log for one day, filterable by user and type, to check what was recorded.
- **Times:** every timestamp is set by MySQL (`NOW()` / `CURRENT_TIMESTAMP`) on connections running at time_zone +00:00, so they are stored in UTC. They are always shown in UK time (Europe/London), and report and `/activity` dates are UK days converted to UTC ranges. Timestamps saved before the UTC change were in the server's local time and were left as they are, so some older ones may show up to an hour out.
- **KB edits** record which fields changed (title, category, tags, issue, solution, attachments) in `activity_log.changes`. `npm run migrate` adds that column to existing databases.

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
src/routes/           auth, dashboard, users, services (+ tutorials), clients, tickets, kb, files, activity (log work), report
src/middleware/       login check and CSRF protection
src/lib/              helpers (ordering, Mermaid flowcharts, fonts, validation)
views/                EJS templates
public/               CSS, JS, fonts, images
uploads/              uploaded files (git-ignored, created automatically)
```
