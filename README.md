# itsupport

Cleartwo IT support portal: clients, service checklists with flowcharts and tutorials, tickets, a General IT Support knowledge base, an activity log and a Daily Report.

Built with Express, EJS, MySQL (mysql2), express-session (sessions stored in MySQL), bcrypt, helmet, multer (uploads), marked (Markdown), exceljs (stock report Excel export), nodemailer (email) and sharp (profile pictures). It runs under PM2.

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

Profile pictures use `sharp`, which installs a prebuilt binary for the server's platform (Linux, Windows or macOS on x64/arm64) as an optional dependency; no build tools are needed. If `require('sharp')` fails, run `npm install --include=optional sharp`.

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
| `UPLOAD_DIR` | Optional. Folder for uploaded files (profile pictures go in its `avatars` subfolder). Defaults to `uploads/` in the app folder |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Mail server for reminder emails and sent reports. Port 587 uses STARTTLS (465 uses TLS) |
| `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME` | Address and name emails are sent from (e.g. `it@cleartwo.co.uk`, `Cleartwo IT Support`) |
| `APP_URL` | Address of the portal, e.g. `https://support.cleartwo.co.uk`, used for the "Open ticket" button in reminder emails |
| `ENCRYPTION_KEY` | 64 hex characters used to encrypt inventory passwords and PINs. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and keep a safe copy: if it is lost or changed, saved passwords cannot be read |

If any of the SMTP or `MAIL_FROM_EMAIL` settings is missing, email is turned off: the portal keeps working, reminders still pop up, and Send report explains what to add. Restart the portal after changing `.env`.

`.env` is git-ignored. Never commit it.

### 5. Create the tables, seed the services and add the first user

```bash
npm run migrate
npm run seed
npm run create-user -- admin 'a-strong-password' Admin
```

- `migrate` creates any missing tables (from `db/schema.sql`) and runs one-time steps recorded in `schema_migrations` (such as the inventory rebuild, which drops the old inventory tables once). It is safe to re-run after every update.
- `seed` adds the default service categories, services and steps. It is safe to run more than once: anything that already exists is left alone.
- `create-user` adds a user with a bcrypt-hashed password. The optional last argument is their display name. Users only live in the database. Add more from the Users page once you're signed in. The password is visible in your shell history, so clear it or reset the password from the Users page afterwards.

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

Each ticket has a priority (Low, Normal, High, Urgent; Normal by default), set when it is created and changed on the ticket page. Priorities show as glowing LED flags (Low green, Normal cyan, High amber, Urgent red) that all pulse together. Ticket lists can be filtered by status and priority and sorted by any column. By default urgent tickets come first, then the most recently updated. Every change records who made it (Updated by) and when (Last updated, UK time).

## Inventory (internal)

Cleartwo's own staff, accounts and kit, not linked to clients. Rebuilt in October 2026: the first `npm run migrate` after updating **drops the old inventory tables and their data** (people, assets, stock, access, shared accounts, offboarding, custom fields) and installs the new defaults. This happens once only. Take a database backup first if you want to keep the old data.

- **Tabs:** Employees, Stock, Writers, Ex Employees and Old Accounts, shown as tabs and under Inventory in the sidebar. **Tabs** (Settings) adds simple tabs with their own columns; tabs can be renamed and dragged into a new order, and added tabs, Writers and Old Accounts can be deleted (you type the name to confirm).
- **Columns:** every tab (and every stock category) has its own fields: text, long text, email, phone, number, date, link, dropdown (editable options), password, PIN and access toggle (Granted / Not granted). **Columns** adds, renames, changes the type, hides / shows, marks required, sets the default width or deletes them (the delete page says how many records have data).
- **Tables:** search, sort by any column, a filter row, CSV export of what is shown, sticky header. Drag a column header onto another to reorder (saved for everyone); drag a header's right edge to resize (saved for you). Click a row to open it.
- **Passwords and PINs** are encrypted with AES-256-GCM using `ENCRYPTION_KEY` from `.env` and never stored or logged in plain text. They show as •••••• with an eye (show for 30 seconds) and a copy button; every reveal and copy is logged with the user, field and record. Without a valid key, password fields cannot be saved or shown and the Inventory says why. CSV exports never contain them.
- **Employees:** User-ID, Name, Email, Password, PIN, Gmail-ID, Gmail Password, Mac Local User, Mac User Pass, Apple Cloud ID, Apple Cloud Password, and access toggles for 1Password, Claude, Cleartwo@gmail.com, ChatGPT and Canva (add more, e.g. CRM, as Access columns). Only active employees are listed.
- **Employee profile:** header with initials, name, User-ID, email, status, Active switch and Edit; Details; Access switches; Equipment (every stock category, with what is assigned and its details, or "Not assigned" with an Assign picker of available items, searchable by brand, model or serial; Unassign returns the item to stock); Equipment held (everything returned, with dates); History.
- **Leaving:** switching Active off asks for the leaving date and confirms. The employee moves to **Ex Employees** with every field kept (passwords and access included), and everything assigned goes back to stock (status Available) while the profile keeps it under Equipment held. Ex employee profiles are read-only, with **Reactivate**.
- **Stock:** every physical item is one record (laptops, desktops and Macs too): category, brand, model, serial / asset number, status (Available, Assigned, Repair, Damaged, Sold, Disposed), who has it, notes and the category's extra fields. **Add item** (optionally assigning it straight away) and **Add multiple** (same brand and model, one serial per row). Views: **Items** (filter by category, status, brand, assigned or not), **Summary** (per category: total, assigned, available, repair / damaged, sold / disposed), **Breakdown** (Category > Brand > Model with quantity and who uses it, brand and category totals; laptops, desktops and Macs grouped Windows / Apple, mice by connection type; CSV and Excel export) and **Categories** (add, rename, reorder, delete when empty, extra fields, report grouping). New categories, brands and models appear in profiles and reports automatically.
- **Writers** (User, Official-ID, Password, Contact, Gmail-ID, Gmail Password) and **Old Accounts** (User, Gmail-ID, Password, Status: Active / Deleted / Verify) are simple tabs with flexible columns, not linked to stock.
- Every inventory change is in the activity log and the record's History. Inventory never appears on the Daily Report.

## Ticket reminders

Each ticket page has a **Reminders** panel listing pending reminders (soonest first) and done ones. You can add, edit, delete and mark them done.

- **Adding a reminder:** write a note, choose who it is for (yourself by default) and pick a time: In 1 hour, This afternoon (15:00), Tomorrow morning (09:00), Next Monday (09:00) or Custom. Times are UK time (Europe/London) and stored in UTC.
- **When it is due:** the reminder's user gets an email (once per due time, and again after a snooze ends) with the note, due time, ticket and client and an Open ticket button, as long as their username is their email address and email is set up. Reminders that fell due more than a day ago are not emailed late. In the portal, the browser checks every 60 seconds. A due reminder pops up as a toast with the ticket number, title, client and note, an Open ticket link, and Done or Snooze (10 minutes, 1 hour, tomorrow 09:00). It stays until you action it, and a short soft sound plays once. The popup appears when that person next has the portal open; the email is sent by the server within a minute of the due time.
- **Bell:** the bell in the top bar shows how many reminders are due, grouped as Due now, Missed (due before today) and Upcoming (next 7 days). Click one to open its ticket.
- **Ticket lists:** a small bell next to the title marks tickets with a pending reminder; hover it for the next reminder time.
- **History, not the report:** adding, editing, snoozing, completing and deleting reminders is in the ticket's History and on `/activity`, but never on the Daily Report.
- **Channels:** due reminders are written to the `notifications` table (whose `channel` column leaves room for Teams) and emailed. Every email is recorded in `email_log`.
- **Old Tasks:** the Tasks page has been removed. Its `tasks` table is left in the database, unused. Run `npm run migrate` after updating to create the `reminders` table and the `notifications.reminder_id` column.

## Users, My profile and email signatures

- **Users page:** add people, and edit anyone with the pencil: display name, email / username (use the person's email address, as emails are sent to it), password, and email signature, each with its own Save and Cancel. Clicking outside the popup or pressing Esc closes it without saving.
- **My profile:** click your name or picture in the sidebar or top bar. You can change:
  - **Profile picture:** choose a JPG, PNG or WebP (phone photos are fine) and a Crop picture popup opens: drag to move, zoom with the slider, mouse wheel or a pinch, rotate 90°, or reset, with a live preview of the round picture. Save uploads just the cropped square (a 512 × 512 JPG); Cancel, Esc or a click outside cancels. It is stored at 256 × 256 and shown in the sidebar, top bar, comments, history, the Users list and created / updated by columns. Without a picture you get a coloured circle with your initials. Remove picture takes it away.
  - **Display name and job title:** the job title shows under your name on your profile and in the Users list, and `{job_title}` in your signature is replaced by it.
  - **Reminder notifications:** Popup only, Email only, or Both (default).
  - **Date format:** "7 Oct 2026" (default) or "07/10/2026", used for every date the portal shows you. Times are 24-hour UK time.
  - **Email signature** and **password** (your current password is needed; changing it signs out your other sessions).
  - **Active sessions:** every device you are signed in on, with browser, IP address, when you signed in and when it was last active. "This device" is marked. Sign out any other session, or all other sessions at once.
- **Admins** can change any user's picture, job title, preferences, signature and password from the pencil on the Users page. Resetting someone's password signs them out everywhere.
- **Email signatures:** use the editor (bold, italic, links, line breaks, images by URL) or choose **Paste HTML** to paste a signature copied from Outlook, with a live preview underneath. Signatures are cleaned before saving (no scripts or styles) and are added to the bottom of Daily Reports you send.

## Activity log and Daily Report

Every create, update and delete (tickets, comments, client services, steps, notes, services, tutorials, KB articles, clients and users) is written to the `activity_log` table with the signed-in user and time. Records show "Created by … / Last updated by …" and a History panel built from it. Records created before the activity log existed fall back to their own created fields.

- **Log work:** the button in the top bar of every page records manual work: an optional client, a description and a date (default today). Each user can edit or delete their own entries from the Daily Report page.
- **Daily Report** (`/report`): pick a day (default today), step back and forward, or choose a date range (up to 62 days, grouped by day). It shows your own report by default. Use **View** to see All team or one other person; the last choice is remembered. People with nothing to report that day are left out, both on the page and when copying.
- **Display names:** each user can have a display name (Users page or My profile). It is shown everywhere a user appears: report headings ("Obaid's Work:"), tickets, reminders, notes, history and created/updated columns. A blank display name shows the username. The report is built only from the activity log. The chosen UK date (or range) is converted to a UTC start and end and matched against when each action happened, so an old article edited today shows up today. Manual Log work entries use the date that was picked. Each user's work is one bullet per item, grouped by client, for example "Replaced the toner for Abel." or "Updated the knowledge base article 'Outlook not syncing'.", and ends with "Other IT related tasks." Everything else (tickets, client services, deletes, user-admin changes) is left out of the report but listed on `/activity`.
- **What is on the report:** only Log work entries and General IT Support articles (created, edited). Ticket activity (comments, status, priority, reminders) and client service activity (started, steps completed, notes, completed) are not on the report; they are still in the activity log and the History panels.
- **Report wording:** built from what was typed, one bullet per entry. Log work: "{text} for {client}." General IT Support: "Documented a solution for '{title}' in the knowledge base." or "Updated the knowledge base article '{title}'." Lines are tidied (capitalised, one full stop, "setup" becomes "Set up", no semicolons, no repeated client name) and ordered log work, General IT Support, then "Other IT related tasks."
- **Send report:** emails your own report for the chosen date(s). The popup has To (several addresses, with suggestions from people you have sent to before and all portal users), optional CC, a subject like "EOD 7 October" and the report, which you can edit before sending. It goes out as Calibri 11pt with your bold "{Name}'s Work:" heading, real bullets and your email signature. It is sent from "{your name}" <your address> when that is an @cleartwo.co.uk address, otherwise from `MAIL_FROM_EMAIL` with replies going to you. Everyone in To and CC gets the same single email, which lists all of them (the `X-MC-PreserveRecipients` header tells Mandrill not to split it into separate copies). Tick **Send me a copy** to get a BCC yourself; it is off by default. Your recipients and that choice are remembered for next time, and the page shows "Sent to … at 17:32" for that date. Sends are in the activity log but not on the report.
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
src/routes/           auth, dashboard, users, profile, services (+ tutorials), clients, tickets, reminders, notifications, kb, files, activity (log work), report
src/middleware/       login check and CSRF protection
src/lib/              helpers (ordering, Mermaid flowcharts, fonts, validation, mailer, report emails, signatures)
views/                EJS templates
public/               CSS, JS, fonts, images
uploads/              uploaded files (git-ignored, created automatically)
```
