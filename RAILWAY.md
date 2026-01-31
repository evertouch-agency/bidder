# Deploy Bidder to Railway

Follow these steps in order.

---

## 1. Don’t push secrets

Create a `.gitignore` in the project root (if you don’t have one) so `.env` and `node_modules` are never committed:

```
.env
node_modules
selected-accounts.json
```

---

## 2. Push your code to GitHub

1. Create a new repo on [github.com](https://github.com/new) (e.g. `bidder`).
2. In your project folder, run:

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/bidder.git
   git push -u origin main
   ```

   Replace `YOUR_USERNAME` and `bidder` with your GitHub username and repo name.

---

## 3. Deploy on Railway

1. Go to **[railway.app](https://railway.app)** and sign in (GitHub is easiest).
2. Click **“New Project”**.
3. Choose **“Deploy from GitHub repo”** and select your `bidder` repo.
4. Railway will detect Node.js and build with `npm install`; start command is `npm start`.  
   - If your app is in the repo root (where `package.json` is), leave **Root Directory** blank.
5. After the first deploy, Railway will show a URL like `https://bidder-production-xxxx.up.railway.app`.  
   - Click the service → **Settings** → **Networking** → **Generate domain** if you don’t see a public URL yet.
6. Copy that URL (no trailing slash). You’ll use it as `BASE_URL` in the next step.

---

## 4. Set environment variables on Railway

1. In your Railway project, click your service (the app).
2. Open the **Variables** tab.
3. Add these variables (use **“Raw Editor”** to paste several at once if you like):

   | Name | Value |
   |------|--------|
   | `LINKEDIN_CLIENT_ID` | Your LinkedIn app Client ID |
   | `LINKEDIN_CLIENT_SECRET` | Your LinkedIn app Client secret |
   | `BASE_URL` | Your Railway URL, e.g. `https://bidder-production-xxxx.up.railway.app` (no trailing slash) |

   Get **Client ID** and **Client secret** from [LinkedIn Developer Console](https://www.linkedin.com/developers/apps) → your app → **Auth** tab.

4. (Optional) If you use **Supabase** for persistent settings and 48h window, add:

   | Name | Value |
   |------|--------|
   | `SUPABASE_URL` | Your Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase service_role key |

5. Save. Railway will redeploy with the new variables.

---

## 5. Add redirect URI in LinkedIn

1. Go to [LinkedIn Developer Console](https://www.linkedin.com/developers/apps) → your app → **Auth**.
2. Under **Authorized redirect URLs**, add:
   ```text
   https://YOUR-RAILWAY-URL/auth/callback
   ```
   Example: `https://bidder-production-xxxx.up.railway.app/auth/callback`  
   (Use the same host as your `BASE_URL`, no trailing slash on the domain.)
3. Save.

---

## 6. Test

1. Open your Railway URL in a browser (e.g. `https://bidder-production-xxxx.up.railway.app`).
2. Click **Sign in with LinkedIn** and complete OAuth.
3. You should land on the app; pick an ad account and use the optimizer.

If something fails, check Railway **Deployments** → latest deploy → **View logs**, and confirm all variables are set and the LinkedIn redirect URI matches exactly.
