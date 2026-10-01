const app = await cua.getApp("Freeform");
let ax = await app.getAXState();
const nb = app.find(ax, "New Board", {role:"button"}) ?? app.find(ax, "New Board");
if (nb !== null) { await app.click(nb); await app.waitFor('Window: "Untitled'); }
// --- Codex reçetesi: 5 eksen vektörü, 32 köşe bit maskesiyle, Gray kodu ana yolu ---
const vs=[[240,0],[0,240],[80,-80],[130,100],[350,-80]];
const points=Array.from({length:32},(_,n)=>vs.reduce((p,v,i)=>n&(1<<i)?[p[0]+v[0],p[1]+v[1]]:p,[800,550]));
const gray=Array.from({length:32},(_,n)=>n^(n>>1));
const key=(a,b)=>[a,b].sort((x,y)=>x-y).join(',');
const used=new Set(gray.slice(1).map((n,i)=>key(gray[i],n)));
const rem=Array.from({length:32},()=>new Set());
for(let n=0;n<32;n++)for(let i=0;i<5;i++){const m=n^(1<<i);if(!used.has(key(n,m)))rem[n].add(m);}
const paths=[gray];
while(rem.some(s=>s.size)){const start=rem.map((s,i)=>[i,s.size]).filter(a=>a[1]).sort((a,b)=>a[1]-b[1])[0][0];const p=[start];const seen=new Set(p);
  while(true){const next=[...rem[p.at(-1)]].filter(n=>!seen.has(n)).sort((a,b)=>rem[a].size-rem[b].size)[0];if(next===undefined)break;const last=p.at(-1);rem[last].delete(next);rem[next].delete(last);p.push(next);seen.add(next);}
  paths.push(p);}
log(`yol sayısı ${paths.length}, kenar ${paths.reduce((s,p)=>s+p.length-1,0)}`);
async function drawPath(p){
  ax=await app.getAXState(); await app.click(app.find(ax,"Insert Shape"));
  ax=await app.getAXState(); await app.click(app.find(ax,"Draw with Pen"));
  for(const n of p) await app.click(points[n]);
  await app.pressKey("Return"); await app.pressKey("Escape");
}
const t0=Date.now();
for(const [i,p] of paths.entries()){ await drawPath(p); log(`yol ${i+1}: ${p.length} nokta, ${Math.round((Date.now()-t0)/1000)} s`); }
await app.click([1770,950]);
await app.getAXStateAndScreenshot();
