# Project Rules

- Node.js app (Express + EJS + MySQL), run with PM2 (pm2.config.cjs, app name "itsupport", script index.js).
- After every change: git add ., commit with a clear message, and git push to origin main.
- Never commit .env. Config lives in .env (PORT 5009, DB_* vars for MySQL, SESSION_SECRET); .env.example lists the keys.
- Users live only in the database, never in .env or code. Add them with `npm run create-user -- <username> <password>` or the Users page.
- Parameterised queries only. Never build SQL from user input.
- Every page requires login; every POST form needs the CSRF field (`<%- csrfField %>`).
- Schema changes go in db/schema.sql and must be safe to re-run (CREATE TABLE IF NOT EXISTS). `npm run seed` must stay safe to run twice.
- No frontend framework: EJS views, plain responsive CSS in public/css/style.css, Mermaid from cdn.jsdelivr.net.
- Branding: Azure Blue #00A6FF (primary), Charcoal #222222, Off-White #FAF8F0 (background), Navy #0B1B5C (accent). Kollektif (body) and Made Tommy (headings) from public/fonts, falling back to Poppins, then sans-serif.
- npm scripts: migrate, seed, create-user, dev (node index.js), start (pm2 start pm2.config.cjs), stop (pm2 stop itsupport), restart (pm2 restart itsupport).
- Do not test locally: no starting the app and no connecting to the database. `npm install` and `node --check` on .js files are fine.
- Keep README server setup steps up to date.
