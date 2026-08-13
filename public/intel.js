/* RHC Mint Radar — unified intelligence layer. */
(() => {
  'use strict';
  if (window.__RHC_INTEL_V4__) return;
  window.__RHC_INTEL_V4__ = true;

  const CFG = Object.freeze({ scanMs: 5000, rpcMs: 15000, sampleMs: 5000, cacheMs: 5 * 60 * 1000, timeoutMs: 7000, journalKey: 'rhc-intel-journal-v2' });
  const state = { cache: new Map(), journal: loadJournal(), hidden: document.hidden, lastRpc: 0, rpc: { latency:null, block:null, chainId:null, ok:false } };

  function loadJournal(){ try { const x=JSON.parse(localStorage.getItem(CFG.journalKey)||'[]'); return Array.isArray(x)?x:[]; } catch { return []; } }
  function saveJournal(){ try { localStorage.setItem(CFG.journalKey,JSON.stringify(state.journal.slice(-500))); } catch {} }
  function esc(v){ return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function txt(el,sel){ const n=el.querySelector(sel); return n?.textContent?.trim()||''; }
  function firstNumber(v){ const m=String(v??'').replace(/,/g,'').match(/-?\d+(?:\.\d+)?/); return m?Number(m[0]):null; }
  function idFor(row){ return String(row.dataset.addr||'').toLowerCase(); }
  function rows(){ return [...document.querySelectorAll('#collections > [data-addr]')].filter(r=>/^0x[a-f0-9]{40}$/.test(idFor(r))); }

  function evidence(row){
    const heat = firstNumber(txt(row,'.heat-val'));
    const supply = firstNumber(txt(row,'.supply-top b'));
    const session = firstNumber(txt(row,'.stats-box > div:first-child b'));
    const windowMints = firstNumber(txt(row,'.stats-box > div:nth-child(2) b'));
    const holders = firstNumber((txt(row,'.supply-sub').match(/holders\s+([\d,]+)/i)||[])[1]);
    const name = txt(row,'.cell-col .name') || txt(row,'.cell-col h3') || idFor(row).slice(0,10);
    return { heat, supply, session, windowMints, holders, name };
  }

  function analyze(row){
    const id=idFor(row), now=Date.now(), ev=evidence(row), cached=state.cache.get(id);
    const samples=(cached?.samples||[]).filter(s=>now-s.t<CFG.cacheMs);
    samples.push({t:now,heat:ev.heat});
    const valid=samples.filter(s=>Number.isFinite(s.heat));
    let velocity=ev.heat, acceleration=null;
    if(valid.length>=2){
      const a=valid[valid.length-2],b=valid[valid.length-1];
      velocity=b.heat;
      acceleration=(b.heat-a.heat)/Math.max(1,(b.t-a.t)/60000);
    }
    const signals=[];
    if(ev.heat!=null) signals.push({v:Math.max(0,Math.min(100,ev.heat)),w:.70});
    if(acceleration!=null) signals.push({v:Math.max(0,Math.min(100,50+acceleration*2)),w:.30});
    const weight=signals.reduce((s,x)=>s+x.w,0);
    const alpha=weight?Math.round(signals.reduce((s,x)=>s+x.v*x.w,0)/weight):null;
    const confidence=Math.round((signals.length/2)*100);
    const out={...ev,velocity,acceleration,alpha,confidence,samples};
    state.cache.set(id,{at:now,...out,samples});
    return out;
  }

  async function rpc(method,params=[]){
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),CFG.timeoutMs),started=performance.now();
    try{
      const r=await fetch('/api/intel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,params}),signal:ctrl.signal,credentials:'same-origin'});
      const data=await r.json(); if(!r.ok||data?.error) throw new Error(data?.error||`HTTP ${r.status}`);
      state.rpc.latency=Math.round(performance.now()-started); state.rpc.ok=true; return data.result;
    }catch{ state.rpc.ok=false; return null; } finally{ clearTimeout(timer); }
  }
  async function refreshRpc(){
    const [block,chain]=await Promise.all([rpc('eth_blockNumber'),rpc('eth_chainId')]);
    state.rpc.block=block?parseInt(block,16):null; state.rpc.chainId=chain?parseInt(chain,16):null;
  }

  function mount(){
    if(document.getElementById('rhc-intel-panel')) return;
    const panel=document.createElement('aside'); panel.id='rhc-intel-panel'; panel.setAttribute('aria-label','RHC intelligence');
    panel.innerHTML='<div class="rhc-intel-head"><b>INTELLIGENCE</b><span id="rhc-intel-status">● LIVE</span></div><div class="rhc-intel-grid"><div><small>HOT</small><strong id="rhc-hot">0</strong></div><div><small>ALPHA</small><strong id="rhc-alpha">—</strong></div><div><small>VELOCITY</small><strong id="rhc-velocity">—</strong></div><div><small>RPC</small><strong id="rhc-rpc">—</strong></div></div><div id="rhc-hot-list"></div>';
    document.body.appendChild(panel);
  }

  function render(){
    const data=rows().map(row=>({row,data:analyze(row)})).filter(x=>x.data.alpha!=null).sort((a,b)=>b.data.alpha-a.data.alpha);
    const hot=data.filter(x=>x.data.alpha>=75).slice(0,5),best=data[0]?.data||null;
    const q=id=>document.getElementById(id); q('rhc-hot').textContent=String(hot.length); q('rhc-alpha').textContent=best?String(best.alpha):'—'; q('rhc-velocity').textContent=best?.velocity!=null?`${best.velocity.toFixed(1)}/m`:'—'; q('rhc-rpc').textContent=state.rpc.ok?`${state.rpc.latency}ms`:'—';
    const list=q('rhc-hot-list'); list.innerHTML=hot.length?hot.map(x=>`<div class="rhc-hot-row"><b>🔥 ${esc(x.data.name)}</b><span>${x.data.alpha} · ${x.data.confidence}%</span></div>`).join(''):'<div class="rhc-empty">No high-confidence opportunities yet</div>';
    const status=q('rhc-intel-status'); status.textContent=state.rpc.ok?'● LIVE':'● RPC OFFLINE'; status.className=state.rpc.ok?'rhc-intel-status-ok':'rhc-intel-status-bad';
  }

  function bindJournal(row){
    if(row.dataset.rhcJournalBound) return; row.dataset.rhcJournalBound='1';
    row.querySelectorAll('a.btn').forEach(btn=>{
      const action=(btn.textContent||'').trim().toUpperCase(); if(!['MINT','PASS','WATCH'].includes(action)) return;
      btn.addEventListener('click',()=>{ state.journal.push({t:Date.now(),action,id:idFor(row),name:txt(row,'.cell-col .name')}); saveJournal(); },{passive:true});
    });
  }

  async function tick(){
    if(state.hidden) return;
    rows().forEach(bindJournal); render();
    if(Date.now()-state.lastRpc>=CFG.rpcMs){ state.lastRpc=Date.now(); refreshRpc().catch(()=>{}); }
  }
  function loop(){ tick().catch(()=>{}); setTimeout(loop,CFG.scanMs); }
  function boot(){
    mount();
    document.addEventListener('visibilitychange',()=>{state.hidden=document.hidden;});
    const target=document.getElementById('collections');
    if(target) new MutationObserver(()=>{ if(!state.hidden) tick().catch(()=>{}); }).observe(target,{childList:true,subtree:true});
    loop();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot,{once:true}); else boot();
})();
