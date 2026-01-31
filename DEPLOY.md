# Deploying Bidder to the Web

Your app is a Node.js Express server. To make it accessible on the web you need to:

1. **Deploy the app** to a host that runs Node.js.
2. **Set environment variables** (secrets) on the host.
3. **Add the production redirect URI** in your LinkedIn Developer app.

---

## 1. Environment variables for production

Set these on your hosting provider (never commit `.env` or real secrets to git):

| Variable | Required | Description |
|----------|----------|-------------|
| `LINKEDIN_CLIENT_ID` | Yes | From [LinkedIn Developer Console](https://www.linkedin.com/developers/apps) |
| `LINKEDIN_CLIENT_SECRET` | Yes | From same app → Auth tab |
| `BASE_URL` | Yes (when deployed) | Your app’s public URL, **no trailing slash** (e.g. `https://bidder.railway.app`) |
| `PORT` | Optional | Most hosts set this automatically (e.g. `3000`) |
| `LINKEDIN_ACCESS_TOKEN` | Optional | Pre-set token; if omitted, users sign in via OAuth |
| `LINKEDIN_AD_ACCOUNT_ID` | Optional | Default ad account |
| `SUPABASE_URL` | Optional | For persistent settings (see [Supabase](#5-optional-supabase-for-persistent-settings)) |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional | Supabase service role key (server-side only; keep secret) |

---

## 2. LinkedIn app: add redirect URI

After you have your live URL:

1. Go to [LinkedIn Developer Console](https://www.linkedin.com/developers/apps) → your app → **Auth**.
2. Under **Authorized redirect URLs**, add:  
   `https://YOUR-DEPLOYED-DOMAIN/auth/callback`  
   (e.g. `https://bidder.railway.app/auth/callback`).
3. Save.

OAuth will only work if this exact URL matches what your app uses (derived from `BASE_URL`).

---

## 3. Deployment options

### Option A: Railway (simple, free tier)

1. Push your code to GitHub (no `node_modules` or `.env` in the repo).
2. Go to [railway.app](https://railway.app) → **Start a New Project** → **Deploy from GitHub** → select the repo.
3. Railway detects Node.js. Set **Root Directory** if the app is in a subfolder, or leave blank if the repo root has `package.json`.
4. In the project → **Variables**, add:
   - `LINKEDIN_CLIENT_ID`
   - `LINKEDIN_CLIENT_SECRET`
   - `BASE_URL` = `https://YOUR-PROJECT.up.railway.app` (Railway shows this URL after first deploy).
5. Redeploy if needed. Your app will be at the given URL.

### Option B: Render

1. Push code to GitHub.
2. Go to [render.com](https://render.com) → **New** → **Web Service** → connect repo.
3. **Build command:** `npm install`  
   **Start command:** `npm start`  
   **Environment:** Node.
4. Under **Environment**, add `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, and `BASE_URL` (e.g. `https://your-service-name.onrender.com`).
5. Deploy. Add the redirect URI in LinkedIn as in step 2.

### Option C: Fly.io

1. Install [flyctl](https://fly.io/docs/hands-on/install-flyctl/) and log in: `fly auth login`.
2. In your project folder: `fly launch` (creates `fly.toml`). Choose a region and don’t attach a database.
3. Set secrets:
   ```bash
   fly secrets set LINKEDIN_CLIENT_ID=xxx LINKEDIN_CLIENT_SECRET=xxx BASE_URL=https://YOUR-APP.fly.dev
   ```
4. Deploy: `fly deploy`. Use `https://YOUR-APP.fly.dev` as `BASE_URL` and add `/auth/callback` in LinkedIn.

### Option D: VPS (DigitalOcean, Linode, etc.)

1. Create a droplet/VM (e.g. Ubuntu).
2. Install Node.js, clone your repo, run `npm install --production`, and run the app with `PORT=3000 node server.js` (or use a process manager like PM2).
3. Set env vars (e.g. in a `.env` file or systemd unit). Set `BASE_URL` to `https://your-domain.com` if you use a domain, or the server’s public IP and port.
4. Put a reverse proxy (e.g. Nginx or Caddy) in front and add SSL (e.g. Let’s Encrypt). Use the resulting `https://...` URL as `BASE_URL` and in LinkedIn’s redirect URI.

---

## 4. Checklist

- [ ] Code pushed to GitHub (without `.env` or `node_modules`).
- [ ] All env vars set on the host, including `BASE_URL` with your real app URL (no trailing slash).
- [ ] Redirect URI `https://YOUR-DOMAIN/auth/callback` added in the LinkedIn app.
- [ ] App starts with `npm start` (uses `PORT` from the host if provided).

After that, open `BASE_URL` in a browser; you should see the app and be able to sign in with LinkedIn.

---

## 5. Optional: Supabase for persistent settings

Without a database, **Settings** (which accounts are selected for optimization) are stored in a file on the server. On platforms like Railway or Render, that file is lost on every redeploy or restart, so your selection resets.

To persist settings across restarts and redeploys, use **Supabase** (free tier is enough):

1. **Create a Supabase project** at [supabase.com](https://supabase.com) → New project.
2. **Create the tables**: In the Supabase Dashboard → **SQL Editor** → New query. Paste and run the contents of `supabase-schema.sql` in this repo (it creates `app_settings` for selected accounts and `recently_optimized` for the 48h “recently optimized” window).
3. **Get credentials**: Dashboard → **Settings** → **API**. Copy:
   - **Project URL** → use as `SUPABASE_URL`
   - **service_role** key (under "Project API keys") → use as `SUPABASE_SERVICE_ROLE_KEY`  
   ⚠️ Never expose the service_role key in the browser; it’s for server-side only.
4. **Set env vars** on your host: add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

Once those two env vars are set, the app will:

- **Settings**: Read and write selected accounts in Supabase instead of a local file (survives restarts and redeploys).
- **48h window**: Store “recently optimized” campaigns in Supabase so the 48h cooldown is shared across devices and browsers instead of only in one browser’s localStorage.

If you don’t set Supabase, the app still works; it uses the local file for settings (which reset after each redeploy) and localStorage for the 48h window (per browser only).
