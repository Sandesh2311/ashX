# Fly + Vercel Split Deploy (AshX)

This repo is split for deployment:

- backend/: Flask + Socket.IO app (deploy to Fly.io)
- frontend/: Vercel edge proxy (deploy to Vercel)

## 1) Deploy Backend to Fly.io

From project root:

```powershell
cd c:\asher\backend
fly auth login
fly launch
```

When asked during `fly launch`:
- App name: choose (example `ashx-chat-backend`)
- Region: nearest to your users
- Database: skip for now (you currently use SQLite)

Set env var:

```powershell
fly secrets set SECRET_KEY="change-this-to-a-long-random-string"
```

Deploy:

```powershell
fly deploy
```

Backend URL format:
- `https://<your-fly-app>.fly.dev`

## 2) Configure Frontend (Vercel proxy)

Edit:
- `frontend/vercel.json`

Replace:
- `REPLACE_WITH_YOUR_FLY_APP`
with your real Fly app subdomain.

Example destination:
- `https://ashx-chat-backend.fly.dev/$1`

## 3) Deploy Frontend to Vercel

```powershell
cd c:\asher\frontend
vercel login
vercel
vercel --prod
```

Use default options. Vercel will serve your app domain and proxy all routes to Fly backend.

## 4) Important Notes

- This setup keeps your current Flask templates/auth/chat working without a major frontend refactor.
- WebSocket signaling (Socket.IO) is handled by Fly backend.
- If browser cache/service worker causes stale behavior, do a hard refresh (`Ctrl+F5`).

## 5) (Recommended next) Production database

SQLite is not ideal for multi-instance production. Migrate backend to Postgres when possible.
