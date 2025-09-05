# Railway deployment

## Prereqs
- GitHub repo ready (this repo)
- Railway account

## One-time setup (via Dashboard)
1. New Project → Deploy from GitHub → choose `Kryotec_Cliente` repo.
2. When asked for a service, pick **Node.js** (Nixpacks auto-detect).
3. Add environment variables in Project → Variables:
   - `DB_HOST`
   - `DB_PORT` (5432)
   - `DB_USER`
   - `DB_PASSWORD`
   - `DB_NAME`
   - `JWT_SECRET`
   - `DEFAULT_TENANT` (optional for localhost behaviour)
4. Set `NODE_ENV=production`.
5. Trigger a deploy; Railway will run `npm run build && npm start` from `Procfile`.

## Local dev remains the same
- Use `.env` locally (not committed). The code reads `process.env.*`.
- Run `npm run dev` for hot reload.

## GitHub → Railway CI/CD
- Every push to main triggers a new deploy.
- For feature branches, enable **Preview Environments** in Railway settings.

## Notes
- Expose HTTP on the default port (Railway sets `PORT`). Our server uses it.
- Ensure DB IP allows outbound from Railway (managed Postgres is recommended).
- If Tailwind CSS isn’t present at first load, ensure `npm run build:css` runs during build (Procfile covers this).
