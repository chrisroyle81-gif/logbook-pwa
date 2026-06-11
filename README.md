# Logbook — setup

A two-piece system for capturing timestamped, located notes into the **2026 Master Notes** Google Doc from your Android phone.

```
┌─────────────────────┐    HTTPS POST     ┌────────────────────────┐
│  Logbook PWA        │ ────────────────► │  Apps Script web app   │
│  (Android home)     │  {ts, lat, lng,   │  - verifies token      │
│                     │   content, token} │  - resolves location   │
│                     │                   │  - appends to doc      │
└─────────────────────┘                   └────────────────────────┘
                                                     │
                                                     ▼
                                          📄  2026 Master Notes
                                              (newest day on top,
                                               entries chronological
                                               within each day)
```

---

## 1. Deploy the Apps Script web app

1. Go to <https://script.google.com> and click **New project**. Name it **Logbook**.
2. Replace the default `Code.gs` contents with the contents of `Code.gs` from this bundle.
3. At the top of the file, set:
   - `DOC_ID` — already pre-filled with the 2026 Master Notes ID.
   - `SHARED_TOKEN` — change to something long and random (e.g. a 32-char string from a password manager). Keep a copy; you'll paste it into the PWA.
   - `TIMEZONE` — already set to `Australia/Sydney`.
   - `KNOWN_LOCATIONS` — leave empty for now; fill in after a few captures (see step 5).
4. Save (Ctrl+S).
5. Click **Deploy → New deployment**.
   - **Type**: Web app
   - **Description**: Logbook v1
   - **Execute as**: Me (your account)
   - **Who has access**: Anyone
6. Click **Deploy**. You'll be prompted to authorise — accept. Google will warn that the app is "unverified" because it's your own script; click **Advanced → Go to Logbook (unsafe)** and continue.
7. Copy the **Web app URL** (ends in `/exec`). You'll paste it into the PWA next.

> Re-deploying: if you change `Code.gs`, use **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. Re-using the same deployment keeps the URL stable so the PWA doesn't need reconfiguring.

---

## 2. Host the PWA

You need an HTTPS host. Two easy options:

### Option A — GitHub Pages (recommended, free)

1. Create a new GitHub repo, e.g. `logbook-pwa`. Public is fine — the PWA holds no secrets; the token lives only in your phone's localStorage.
2. Upload these four files to the repo root:
   - `index.html`
   - `manifest.json`
   - `sw.js`
   - `icon-192.png`
   - `icon-512.png`
3. **Settings → Pages → Source: Deploy from a branch → Branch: main / root → Save**.
4. After ~1 minute, your URL is `https://<your-username>.github.io/logbook-pwa/`.

### Option B — Netlify Drop

Drag the folder onto <https://app.netlify.com/drop> — you'll get an HTTPS URL immediately.

---

## 3. Install on your Android phone

1. Open the PWA URL in **Chrome** on your phone.
2. Tap the **⋮ menu → Add to Home screen** (or **Install app** if Chrome offers it).
3. The Logbook icon will appear on your home screen — looks and behaves like a native app.

---

## 4. First-run configuration

When you launch Logbook for the first time, the **Setup** screen opens automatically.

- **Apps Script Web App URL** → paste the `/exec` URL from step 1.7.
- **Shared Token** → paste the same `SHARED_TOKEN` you set in `Code.gs`.
- Tap **Save**.

Grant **Microphone** and **Location** permissions when prompted (Chrome will ask the first time you use Talk and the first time you submit, respectively).

---

## 5. Test the round trip

1. Tap **Type**, write `test entry`, tap **Save**. You should see a "Saved" toast.
2. Open the 2026 Master Notes doc. The entry should be at the top under today's date.
3. Open Apps Script → **Executions** to see the request. If it failed, the error is logged there.

---

## 6. (Optional) Fill in known locations

After a few captures, open the doc and look at the coordinates in entries you saved at home, at work, at your parents' house, etc. Copy them into `KNOWN_LOCATIONS` in `Code.gs`:

```js
const KNOWN_LOCATIONS = [
  { name: 'Home',                          lat: -33.7123, lng: 150.8456, radius_m: 150 },
  { name: '115 Thunderbolt',               lat: -33.7000, lng: 150.8000, radius_m: 150 },
  { name: 'Cement Australia, Rooty Hill',  lat: -33.7700, lng: 150.8350, radius_m: 250 },
];
```

Re-deploy (Deploy → Manage deployments → edit → New version). Future entries from those spots will show the name instead of coordinates.

---

## How entries land in the doc

```
2026-06-09 Tuesday        ← Heading 1 (one per day, created on first entry)
14:32 · Home              ← Heading 2 (time + resolved location)
Mum took her Sinemet late again, said she forgot.

15:10 · Cement Australia, Rooty Hill
Charmaine wants Bridgestone matching extended to returns.

2026-06-08 Monday
…
```

Newest day on top. Within a day, entries are appended in the order they arrive (chronological).

This format is friendly to the existing Co-work skills (medical-log-sync, dad-medical-log-sync, camera-notes-sync) — day headers and time/location headers are predictable for parsing.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Set URL and token in Setup" toast | URL or token missing — tap **Setup** in the header. |
| "Offline — queued" toast | Phone has no network, or Apps Script returned non-200. Queue auto-flushes when network returns or next time you tap Save. |
| Bad token error in Apps Script logs | PWA token doesn't match `SHARED_TOKEN`. Re-check both. |
| "Voice not supported" | Use Chrome (Firefox/Samsung Internet have spotty Web Speech support). |
| Microphone keeps stopping | Normal — the PWA auto-restarts the recogniser. If it stops permanently, check the mic permission in Chrome's site settings. |
| Location shows coords instead of suburb | Reverse-geocoding service didn't return a locality (rural areas). Add a known location entry instead. |

---

## Security notes

- The Apps Script is deployed as **Anyone** because the phone can't authenticate as your Google account. The `SHARED_TOKEN` is the gate — keep it private. If you ever suspect leak, rotate it: change the value in both `Code.gs` and the PWA Setup screen.
- The token is stored in the PWA's `localStorage`. It never leaves your phone except in POST bodies to your own Apps Script.
- HTTPS is enforced on both ends (GitHub Pages and `script.google.com`) so the token isn't sent in clear text.
