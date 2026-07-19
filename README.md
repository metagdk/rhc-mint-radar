# Mint Radar — Robinhood Chain NFT Tracker

Live **ERC-721 / ERC-1155** mint tracker for [Robinhood Chain](https://robinhoodchain.blockscout.com).

**Static site · no login · no wallets · no API keys · Netlify free tier ready**

**Made by [metagdk](https://x.com/metagdk)**

### Live site

**https://rhc-mint-radar-4949.netlify.app**

Netlify admin: https://app.netlify.com/projects/rhc-mint-radar-4949

---

## Security audit (summary)

| Check | Status |
|--------|--------|
| API keys / secrets in code | **None** — uses public Blockscout REST only |
| Backend / database | **None** on Netlify (static HTML/CSS/JS) |
| Personal data collection | **None** — no forms, no auth, no analytics by default |
| Wallet / private keys | **Not used** |
| Environment variables required | **None** |
| XSS | User/chain text escaped before render; URLs allowlisted to `http(s)` |
| CSP / clickjacking | Headers in `netlify.toml` + meta CSP |
| Path traversal (local server) | Guarded in optional `server.js` |
| Rate limits | Client polls every 2s; pauses when tab is hidden |

### What data leaves the browser?

Only requests to the **public** explorer:

- `https://robinhoodchain.blockscout.com/api/v2/...`

No data is sent to your Netlify account beyond normal static hosting (HTML/CSS/JS files). Session mint stats stay **in memory** in the visitor’s browser tab and disappear on refresh.

### What you must **not** commit

- `.env`, API keys, wallet seeds, private keys  
- Personal dumps like `state_tmp.json`  
- `node_modules/`  

`.gitignore` already blocks these.

---

## Project layout (deployed vs local)

```
rhc-nft-mint-tracker/
├── public/              ← Netlify publish folder (ONLY this goes live)
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── robots.txt
├── netlify.toml         ← security headers + publish config
├── .gitignore
├── package.json         ← optional local preview scripts
├── server.js            ← optional local static server (NOT used by Netlify)
└── README.md
```

---

## Local preview

```bash
# Option A — no install (needs Node 18+)
npx serve public -l 3847

# Option B
npm start
```

Open `http://localhost:3847`

---

## Deploy to Netlify (free) — step by step

### 1) Put the code on GitHub (recommended)

1. Create a **new empty** GitHub repository (public or private).
2. On your machine:

```bash
cd path/to/rhc-nft-mint-tracker
git init
git add public netlify.toml .gitignore README.md package.json server.js
git status
# Confirm: no .env, no node_modules, no state dumps
git commit -m "Secure static Mint Radar for Netlify"
git branch -M main
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```

> Never put API keys, seed phrases, or personal `.env` files in this repo.

### 2) Connect Netlify

1. Go to [https://app.netlify.com](https://app.netlify.com) and sign in (GitHub login is fine).
2. **Add new site → Import an existing project**
3. Choose your GitHub repo.
4. Build settings (should auto-read `netlify.toml`):
   - **Build command:** `echo 'Static site — no build step'` (or leave blank if UI allows)
   - **Publish directory:** `public`
5. **Environment variables:** leave **empty** (nothing required).
6. Click **Deploy site**.

### 3) After deploy

- Open the `*.netlify.app` URL on phone and desktop.
- Hard-refresh once if an old cache shows.
- Optional: **Domain settings → Options → Edit site name** for a nicer free subdomain.
- Optional: Site settings → **Disable** form detection / identity if you don’t use them.

### 4) Drag-and-drop (no Git)

1. Zip **only** the contents of `public/` **or** deploy the folder via Netlify CLI:

```bash
npx netlify-cli deploy --prod --dir=public
```

2. Still recommended to keep `netlify.toml` at repo root when using Git; for CLI-only, headers still apply if `netlify.toml` is in the project when you run the CLI from the repo root.

---

## Responsive layouts

| Viewport | Behavior |
|----------|----------|
| **Desktop / PC** | Side-by-side leaderboard + mint stream |
| **Tablet** | Stacked panels, 4-column KPI row |
| **Mobile** | 2-col KPIs, 2×2 sort buttons, card-style rows, large touch targets |

---

## Features

- Live mint detection via Blockscout `token_minting` events  
- Hottest collections climb the board (FLIP animation)  
- Supply bars relative to largest live collection  
- Collection / mint / X links when present in **public** metadata  
- Uniswap LP position NFTs hidden by default  

---

## Disclaimer

This tool surfaces **public on-chain activity**. NFT mints can be spam, scams, or unaudited contracts. Always verify contracts yourself. Not financial advice.
