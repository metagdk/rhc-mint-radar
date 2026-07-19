# Security policy

## Scope

Mint Radar is a **static** front-end that reads the **public** Robinhood Chain Blockscout API in the visitor’s browser.

## Guarantees we aim for

- No application secrets or API keys in the repository  
- No server-side storage of user data on Netlify free static hosting  
- No wallet connection, signatures, or private key handling  
- Output encoding for chain-provided text (XSS mitigation)  
- Strict URL allowlist (`http:` / `https:` only) for links  
- Security headers via `netlify.toml`  

## Out of scope / residual risks

- **Public chain data** is visible by design (addresses, txs, token metadata).  
- **Third-party NFT images** load from HTTPS/IPFS gateways; malicious metadata images are possible on any NFT explorer — images are `referrerPolicy=no-referrer` and sandboxed by CSP `img-src`.  
- **Blockscout availability / rate limits** are controlled by the explorer operator.  
- **Netlify account security** is your responsibility (2FA recommended).  

## Reporting

If you find a vulnerability in this project’s code (not the blockchain itself), open a private report with the repo maintainer. Do not commit proof-of-concept exploits that leak third-party secrets.

## Deployer checklist

- [ ] Repo has no `.env` or keys (`git status` clean of secrets)  
- [ ] Netlify env vars empty  
- [ ] Publish directory = `public`  
- [ ] Site loads over HTTPS (Netlify default)  
- [ ] Browser console shows only Blockscout API calls  
