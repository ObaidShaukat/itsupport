# Project Rules

- Node.js app (Express + EJS + MySQL). PM2 is run manually with `pm2 start pm2.config.cjs` (app name "itsupport", script index.js); there are no PM2 npm scripts.
- After every change: git add ., commit with a clear message, and git push to origin main.
- Never commit .env. Config lives in .env (PORT 5009, DB_* vars for MySQL, SESSION_SECRET); .env.example lists the keys.
- Users live only in the database, never in .env or code. Add them with `npm run create-user -- <username> <password>` or the Users page.
- Parameterised queries only. Never build SQL from user input.
- Every page requires login; every POST form needs the CSRF field (`<%- csrfField %>`).
- Schema changes go in db/schema.sql and must be safe to re-run (CREATE TABLE IF NOT EXISTS). `npm run seed` must stay safe to run twice.
- No frontend framework: EJS views, plain responsive CSS in public/css/style.css, Mermaid from cdn.jsdelivr.net.
- Branding: Azure Blue #00A6FF (primary), Charcoal #222222, Off-White #FAF8F0 (background), Navy #0B1B5C (accent). Kollektif (body) and Made Tommy (headings) from public/fonts, falling back to Poppins, then sans-serif.
- npm scripts: start (node index.js, foreground for testing, Ctrl+C stops it), migrate, seed, create-user.
- Logo is public/logo.png (/logo.png); favicon is public/favicon.svg (/favicon.svg).
- Do not test locally: no starting the app and no connecting to the database. `npm install` and `node --check` on .js files are fine.
- Keep README server setup steps up to date.
