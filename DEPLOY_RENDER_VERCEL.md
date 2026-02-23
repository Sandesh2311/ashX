# AshX Deployment (Backend: Render, Frontend: Vercel)

## 1) Project layout
- Backend: `backend/`
- Frontend: `frontend/`

## 2) Deploy backend on Render
1. Push your repo to GitHub.
2. In Render: `New +` -> `Web Service` -> connect your repo.
3. Configure:
   - Root Directory: `backend`
   - Build Command: `pip install -r requirements.txt`
   - Start Command: `gunicorn -w 1 --threads 8 --bind 0.0.0.0:$PORT app:app`
4. Add env var:
   - `SECRET_KEY` = a long random string
5. Deploy and copy backend URL, for example:
   - `https://ashx-backend.onrender.com`

## 3) Point Vercel to Render
1. Open `frontend/vercel.json`.
2. Replace:
   - `https://REPLACE_WITH_YOUR_RENDER_BACKEND.onrender.com`
   with your actual Render backend URL.

## 4) Deploy frontend on Vercel
1. In Vercel: `Add New` -> `Project` -> import same repo.
2. Framework preset: `Other`.
3. Root Directory: `frontend`.
4. Deploy.

## 5) Verify
1. Open Vercel URL.
2. Signup/login.
3. Open two browsers/users and verify:
   - real-time messages
   - presence updates
   - media upload/download
   - calls/signaling

## Notes
- Current Vercel setup proxies all frontend paths to Render backend using `frontend/vercel.json`.
- SQLite on Render is ephemeral unless you attach a persistent disk or migrate DB to a managed database.
- Do not use eventlet worker on Render Python 3.14; use threaded gunicorn command above.
