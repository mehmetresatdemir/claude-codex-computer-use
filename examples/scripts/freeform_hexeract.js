const t0 = Date.now();
const app = await cua.getApp("Freeform");
await app.click({find:"New Board", role:"button"}); let ax = await app.waitFor('Window: "Untitled');
log("pano:", app.text(ax, /Window: "([^"]+)"/));
// 6 eksen: 12-gen (30° aralık), orijinal koordinatlar 2560x1300, merkez (1400,700)
const D = 6, N = 1 << D, cx = 1400, cy = 690;
const axes = Array.from({length: D}, (_, k) => [Math.cos(Math.PI * k / 6), Math.sin(Math.PI * k / 6)]);
let raw = Array.from({length: N}, (_, n) => axes.reduce((p, v, i) => (n >> i) & 1 ? [p[0] + v[0], p[1] + v[1]] : [p[0] - v[0], p[1] - v[1]], [0, 0]));
const maxR = Math.max(...raw.map(([x, y]) => Math.hypot(x, y))); const R = 330 / maxR;
const pts = raw.map(([x, y]) => [Math.round(cx + x * R), Math.round(cy + y * R)]);
// Hierholzer: Euler devresi (her köşe derece 6)
const adj = Array.from({length: N}, () => []);
for (let n = 0; n < N; n++) for (let i = 0; i < D; i++) { const m = n ^ (1 << i); if (n < m) { adj[n].push(m); adj[m].push(n); } }
const used = new Set(); const key = (a, b) => a < b ? a * N + b : b * N + a;
const stack = [0], circuit = [];
while (stack.length) { const v = stack[stack.length - 1]; const nx = adj[v].find(u => !used.has(key(v, u))); if (nx === undefined) circuit.push(stack.pop()); else { used.add(key(v, nx)); stack.push(nx); } }
circuit.reverse(); log("devre uzunluğu (köşe ziyareti):", circuit.length, "kenar:", circuit.length - 1);
// parçala: her parça ≤ 33 nokta, parçalar bir köşe paylaşır (kenar kaybı yok); kapalı dönüşte başlangıca tıklama sorununu önler
// Kalem aracı: bir yol içinde aynı köşe iki kez tıklanamaz → tekrar görünce yeni yol başlat (son köşeyi paylaşarak)
const paths = []; let cur = [circuit[0]], seen = new Set(cur);
for (let i = 1; i < circuit.length; i++) { const v = circuit[i]; if (seen.has(v) || cur.length >= 40) { paths.push(cur); cur = [circuit[i - 1], v]; seen = new Set(cur); } else { cur.push(v); seen.add(v); } }
if (cur.length > 1) paths.push(cur);
log("yol sayısı:", paths.length, "toplam nokta:", paths.reduce((s, p) => s + p.length, 0));
async function clickFind(q) { for (let k = 0; k < 3; k++) { ax = await app.getAXState(); const i = app.find(ax, q); if (i === null) { await sleep(300); continue; } try { await app.click(i); return; } catch (e) { if (!/invalidElementID|Re-query/.test(String(e.message))) throw e; await sleep(300); } } throw new Error("clickFind failed: " + q); }
async function drawPath(p) {
  await clickFind("Insert Shape"); await clickFind("Draw with Pen");
  for (const n of p) await app.click(pts[n]);
  await app.pressKey("Return"); await app.pressKey("Escape");
}
for (const [i, p] of paths.entries()) { await drawPath(p); log(`yol ${i + 1}/${paths.length}: ${p.length} nokta, ${Math.round((Date.now() - t0) / 1000)} s`); }
await app.click([2350, 1200]);
await app.getAXStateAndScreenshot();
log(`bitti: ${Math.round((Date.now() - t0) / 1000)} s`);
