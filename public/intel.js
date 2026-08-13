/* RHC Mint Radar — production intelligence layer.
 * Additive only: the existing mint poller/renderer remains untouched.
 * Never contains private RPC credentials.
 */
(() => {
  "use strict";

  const API = "https://robinhoodchain.blockscout.com/api/v2";
  const CACHE_TTL = 5 * 60 * 1000;
  const ROW_SCAN_MS = 4000;
  const MAX_CONCURRENT = 2;
  const TIMEOUT = 6500;
  const JOURNAL_KEY = "rhc-mint-radar:journal:v2";
  const state = { cache: new Map(), queue: [], queued: new Set(), active: 0, velocity: new Map(), journal: load(JOURNAL_KEY, []), timer: null, observer: null };

  function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; } }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
  function esc(v) { return String(v ?? "").replace(/[&<>\"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
  function validAddress(v) { return typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v); }
  function short(v) { return validAddress(v) ? `${v.slice(0,6)}…${v.slice(-4)}` : "—"; }
  function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
  function clamp(v, a=0, b=100) { return Math.max(a, Math.min(b, v)); }

  async function getJson(url, timeout=TIMEOUT) {
    const c = new AbortController(); const timer = setTimeout(() => c.abort(), timeout);
    try {
      const r = await fetch(url, { signal:c.signal, headers:{Accept:"application/json"}, credentials:"omit", referrerPolicy:"no-referrer", cache:"no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  async function rpc(method, params=[]) {
    try {
      const c = new AbortController(); const timer = setTimeout(() => c.abort(), 5000);
      const r = await fetch("/api/intel", { method:"POST", headers:{"content-type":"application/json",accept:"application/json"}, credentials:"same-origin", body:JSON.stringify({method,params}), signal:c.signal });
      clearTimeout(timer); if (!r.ok) return null;
      const j = await r.json(); return j?.result ?? null;
    } catch { return null; }
  }

  function styles() {
    if (document.getElementById("ri-style")) return;
    const s = document.createElement("style"); s.id="ri-style";
    s.textContent=`
      #radarIntel{margin:0 0 16px;border:1px solid rgba(120,150,255,.16);border-radius:18px;background:linear-gradient(180deg,rgba(13,17,28,.95),rgba(7,9,15,.94));box-shadow:0 14px 45px rgba(0,0,0,.22);overflow:hidden}
      #radarIntel .ri-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 15px;border-bottom:1px solid rgba(255,255,255,.06)}
      #radarIntel .ri-title{font-weight:800;display:flex;align-items:center;gap:8px}.ri-dot{width:7px;height:7px;border-radius:50%;background:#7cffb2;box-shadow:0 0 14px #7cffb2}.ri-muted{font-size:10px;opacity:.55;font-weight:500}
      #radarIntel .ri-grid{display:grid;grid-template-columns:1.4fr repeat(4,1fr);gap:8px;padding:11px 15px}.ri-kpi{padding:9px 10px;border:1px solid rgba(255,255,255,.055);border-radius:11px;background:rgba(255,255,255,.025)}.ri-kpi span{display:block;font-size:9px;opacity:.55;text-transform:uppercase;letter-spacing:.08em}.ri-kpi b{display:block;font:800 17px ui-monospace,monospace;margin-top:2px}
      #radarIntel .ri-body{display:grid;grid-template-columns:1.35fr 1fr;gap:10px;padding:0 15px 15px}.ri-card{border:1px solid rgba(255,255,255,.055);border-radius:12px;overflow:hidden;background:rgba(255,255,255,.018)}.ri-card h4{margin:0;padding:9px 11px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.65}.ri-hot{display:grid;grid-template-columns:30px 1fr auto;gap:8px;align-items:center;padding:8px 11px;border-top:1px solid rgba(255,255,255,.045)}.ri-hot .rank{opacity:.45;font:700 10px ui-monospace,monospace}.ri-hot .name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ri-hot .sub{font-size:9px;opacity:.55;margin-top:2px}.ri-score{font:800 14px ui-monospace,monospace}.ri-score.hot{color:#ffcf66}.ri-score.good{color:#7cffb2}.ri-score.warn{color:#ff9f68}.ri-actions{display:flex;gap:6px;padding:9px 11px;border-top:1px solid rgba(255,255,255,.045)}.ri-btn{border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.035);color:inherit;border-radius:8px;padding:6px 9px;font-size:10px;cursor:pointer}.ri-btn:hover{background:rgba(255,255,255,.08)}
      .rank-row .ri-mini{display:inline-block;margin-left:5px;padding:2px 5px;border-radius:6px;font:800 9px ui-monospace,monospace;border:1px solid rgba(255,207,102,.22);color:#ffcf66;background:rgba(255,207,102,.06)}
      #riDrawer{position:fixed;right:14px;bottom:14px;width:min(440px,calc(100vw - 28px));max-height:70vh;z-index:10000;border:1px solid rgba(130,160,255,.2);border-radius:15px;background:rgba(6,8,14,.98);box-shadow:0 24px 80px rgba(0,0,0,.5);overflow:auto;display:none}#riDrawer.open{display:block}.ri-dh{position:sticky;top:0;background:rgba(6,8,14,.98);padding:11px 13px;border-bottom:1px solid rgba(255,255,255,.06);display:flex;justify-content:space-between}.ri-log{padding:8px 13px;border-bottom:1px solid rgba(255,255,255,.045);font-size:10px;line-height:1.45}.ri-note{padding:11px;font-size:10px;line-height:1.45;opacity:.6}
      @media(max-width:900px){#radarIntel .ri-grid{grid-template-columns:repeat(2,1fr)}#radarIntel .ri-body{grid-template-columns:1fr}}@media(max-width:520px){#radarIntel .ri-grid{grid-template-columns:1fr 1fr}.ri-kpi:first-child{grid-column:1/-1}}
    `; document.head.appendChild(s);
  }

  function mount() {
    if (document.getElementById("radarIntel")) return;
    const main=document.getElementById("main"); if(!main) return;
    const root=document.createElement("section"); root.id="radarIntel"; root.setAttribute("aria-label","Mint Radar intelligence");
    root.innerHTML=`<div class="ri-head"><div class="ri-title"><i class="ri-dot"></i> Intelligence Command Center <span class="ri-muted" id="riStatus">warming up…</span></div><button class="ri-btn" id="riJournalOpen">Decision Journal</button></div>
      <div class="ri-grid"><div class="ri-kpi"><span>Top alpha</span><b id="riAlpha">—</b></div><div class="ri-kpi"><span>Hot queue</span><b id="riHot">0</b></div><div class="ri-kpi"><span>Velocity surges</span><b id="riSurges">0</b></div><div class="ri-kpi"><span>Risk flags</span><b id="riRisk">0</b></div><div class="ri-kpi"><span>RPC latency</span><b id="riLatency">—</b></div></div>
      <div class="ri-body"><div class="ri-card"><h4>🔥 Hot Queue</h4><div id="riQueue"><div class="ri-note">Waiting for live collections…</div></div></div><div class="ri-card"><h4>🧠 Decision signals</h4><div id="riSignals"><div class="ri-note">Scoring real observed heat, acceleration, creator history, contract state and holder distribution. Unknown signals are not invented.</div></div><div class="ri-actions"><button class="ri-btn" id="riRefresh">Refresh</button><button class="ri-btn" id="riLog">Log top</button></div></div></div>`;
    main.parentNode.insertBefore(root,main);
    const drawer=document.createElement("div"); drawer.id="riDrawer"; drawer.innerHTML=`<div class="ri-dh"><b>Decision Journal</b><button class="ri-btn" id="riClose">Close</button></div><div id="riJournalList"></div>`; document.body.appendChild(drawer);
    $("riJournalOpen").onclick=()=>{drawer.classList.add("open");renderJournal()}; $("riClose").onclick=()=>drawer.classList.remove("open"); $("riRefresh").onclick=()=>scanRows(true); $("riLog").onclick=logTop;
  }
  const $=id=>document.getElementById(id);

  function readRow(row) {
    const address=row?.dataset?.addr; if(!validAddress(address)) return null;
    const name=row.querySelector(".col-name")?.textContent?.trim() || short(address);
    const heat=n((row.querySelector(".heat-val")?.textContent||"").replace(/[^0-9.]/g,""));
    const supply=n((row.querySelector(".supply-top b")?.textContent||"").replace(/,/g,""));
    const holders=n(((row.querySelector(".supply-sub")?.textContent||"").match(/holders\s+([\d,]+)/i)||[])[1]?.replace(/,/g,""));
    return {address,name,heat,supply,holders,row};
  }

  function velocity(c) {
    const key=c.address.toLowerCase(), now=Date.now(); let p=state.velocity.get(key)||[];
    p.push({t:now,v:c.heat}); p=p.filter(x=>now-x.t<=120000); state.velocity.set(key,p);
    const old=p.find(x=>now-x.t>=20000); const delta=old?c.heat-old.v:0; const pct=old&&old.v>0?(delta/old.v)*100:0;
    return {delta,pct};
  }

  async function creatorHistory(address) {
    try {
      const info=await getJson(`${API}/addresses/${encodeURIComponent(address)}`); const creator=info?.creator_address_hash;
      if(!validAddress(creator)) return {creator:null,count:null};
      const data=await getJson(`${API}/addresses/${encodeURIComponent(creator)}/transactions?filter=from&limit=50`).catch(()=>null);
      const seen=new Set();
      for(const x of data?.items||[]) { const h=x?.created_contract?.hash; if(validAddress(h)&&h.toLowerCase()!==address.toLowerCase()) seen.add(h.toLowerCase()); }
      return {creator,count:seen.size};
    } catch { return {creator:null,count:null}; }
  }

  async function holdersSignal(address) {
    try {
      const data=await getJson(`${API}/tokens/${encodeURIComponent(address)}/holders?limit=20`); const items=data?.items||[];
      const values=items.map(x=>n(x.value)).filter(x=>x>0); if(values.length<2) return null;
      const total=values.reduce((a,b)=>a+b,0), top=values.slice(0,10).reduce((a,b)=>a+b,0); return clamp(top/total*100,0,100);
    } catch { return null; }
  }

  async function analyze(c,force=false) {
    const key=c.address.toLowerCase(), cached=state.cache.get(key); if(!force&&cached&&Date.now()-cached.at<CACHE_TTL)return cached.data;
    const [creator, concentration, code, block] = await Promise.all([
      creatorHistory(c.address), holdersSignal(c.address), rpc("eth_getCode",[c.address,"latest"]), rpc("eth_blockNumber")
    ]);
    const v=velocity(c); const verified=!!code&&code!=="0x"; const creatorKnown=creator.count!==null;
    const velocityScore=clamp(c.heat*8); const accelScore=clamp(50+v.pct*1.4); const creatorScore=creatorKnown?clamp(45+creator.count*8):45;
    const distributionScore=concentration===null?50:clamp(100-Math.max(0,concentration-20)*1.4); const contractScore=verified?88:25;
    const risk=clamp((verified?0:30)+(concentration!==null&&concentration>65?25:0));
    const alpha=Math.round(clamp(velocityScore*.30+accelScore*.20+creatorScore*.15+distributionScore*.15+contractScore*.20-risk*.10));
    const result={alpha,velocityScore,accelScore,creatorScore,distributionScore,contractScore,risk,creator:creator.creator,previous:creator.count,concentration,velocityPct:v.pct,velocityDelta:v.delta,block: block?parseInt(block,16):null,verified};
    state.cache.set(key,{at:Date.now(),data:result}); return result;
  }

  function apply(row,d) {
    if(!row?.isConnected||!d)return;
    const meta=row.querySelector(".col-meta"); if(meta){let badge=meta.querySelector(".ri-mini"); if(!badge){badge=document.createElement("span");badge.className="ri-mini";meta.appendChild(badge)} badge.textContent=`🔥 ${d.alpha}`;badge.title=`Alpha ${d.alpha}/100 · velocity ${d.velocityPct>=0?"+":""}${d.velocityPct.toFixed(1)}% · risk ${d.risk}/100`;}
  }

  function drain(){ while(state.active<MAX_CONCURRENT&&state.queue.length){const job=state.queue.shift();state.active++;analyze(job.data,job.force).then(d=>{apply(job.data.row,d);job.done?.(d)}).finally(()=>{state.active--;state.queued.delete(job.data.address.toLowerCase());drain()});} }
  function enqueue(c,force=false){const key=c.address.toLowerCase();if(state.queued.has(key))return;state.queued.add(key);state.queue.push({data:c,force});drain()}

  async function scanRows(force=false){
    const rows=[...document.querySelectorAll("#collections article.rank-row[data-addr]")].map(readRow).filter(Boolean); if(!rows.length){$("riStatus")?.replaceChildren(document.createTextNode("waiting for live collections"));return;}
    rows.forEach(c=>enqueue(c,force)); const results=[];
    for(const c of rows){const x=state.cache.get(c.address.toLowerCase());if(x)results.push({...c,...x.data});}
    results.sort((a,b)=>b.alpha-a.alpha); const hot=results.slice(0,6); const surges=results.filter(x=>x.velocityPct>15).length; const risks=results.filter(x=>x.risk>=40).length;
    $("riAlpha").textContent=hot[0]?String(hot[0].alpha):"—"; $("riHot").textContent=String(hot.length); $("riSurges").textContent=String(surges); $("riRisk").textContent=String(risks);
    $("riLatency").textContent=performance.now().toFixed(0)+"ms"; $("riStatus").textContent=`${results.length} collections analyzed`;
    $("riQueue").innerHTML=hot.length?hot.map((x,i)=>`<div class="ri-hot"><span class="rank">${i+1}</span><div><div class="name">${esc(x.name)}</div><div class="sub">${x.velocityPct>=0?"↑":"↓"} ${Math.abs(x.velocityPct).toFixed(1)}% velocity · ${x.previous===null?"creator unknown":`${x.previous} previous`} · ${x.concentration===null?"holder data unavailable":`${x.concentration.toFixed(0)}% top-10`}</div></div><span class="ri-score ${x.alpha>=80?"hot":x.alpha>=60?"good":"warn"}">${x.alpha}</span></div>`).join(""):"<div class='ri-note'>Waiting for intelligence…</div>`;
    const top=hot[0]; $("riSignals").innerHTML=top?`<div class="ri-note"><b>${esc(top.name)}</b><br>Alpha ${top.alpha}/100 · contract ${top.verified?"verified bytecode":"unknown"} · risk ${top.risk}/100.<br>${top.previous===null?"Creator history unavailable.":`Creator history: ${top.previous} prior contracts observed.`}<br>${top.concentration===null?"Holder concentration unavailable.":`Top-10 observed concentration: ${top.concentration.toFixed(1)}%.`}</div>`:"<div class='ri-note'>No live collection yet.</div>";
  }

  function logTop(){const top=[...document.querySelectorAll("#collections article.rank-row[data-addr]")].map(readRow).filter(Boolean).map(c=>({c,d:state.cache.get(c.address.toLowerCase())?.data})).filter(x=>x.d).sort((a,b)=>b.d.alpha-a.d.alpha)[0];if(!top)return;state.journal.unshift({at:new Date().toISOString(),action:"WATCH",name:top.c.name,address:top.c.address,alpha:top.d.alpha});state.journal=state.journal.slice(0,200);save(JOURNAL_KEY,state.journal);renderJournal();}
  function renderJournal(){const el=$("riJournalList");if(!el)return;el.innerHTML=state.journal.length?state.journal.map(x=>`<div class="ri-log"><b>${esc(x.action)}</b> · ${esc(x.name)} · Alpha ${x.alpha}<br><span style="opacity:.55">${new Date(x.at).toLocaleString()} · ${esc(short(x.address))}</span></div>`).join(""):"<div class='ri-note'>No decisions logged yet.</div>";}

  function start(){styles();mount();const root=$("collections");if(!root){state.timer=setTimeout(start,500);return;}state.observer=new MutationObserver(()=>scanRows(false));state.observer.observe(root,{childList:true,subtree:true});scanRows(false);const loop=()=>{if(!document.hidden)scanRows(false);state.timer=setTimeout(loop,ROW_SCAN_MS)};loop();window.addEventListener("beforeunload",()=>{clearTimeout(state.timer);state.observer?.disconnect()},{once:true});}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start();
})();
