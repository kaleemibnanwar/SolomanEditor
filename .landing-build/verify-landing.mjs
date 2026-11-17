/** Verify the standalone landing page: assets decode, theme + menu work, no errors. */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const OUT = fileURLToPath(new URL("./shots/", import.meta.url));
const PAGE = "file://" + fileURLToPath(new URL("../soloman-editor-landing.html", import.meta.url));
const chrome = spawn("google-chrome-stable", [
  "--headless=new", "--remote-debugging-port=9337",
  "--user-data-dir=/tmp/soloman-landing-verify", "--no-first-run",
  "--no-default-browser-check", "--hide-scrollbars", "--window-size=1440,900",
  "--mute-audio", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wsUrl() {
  for (let i = 0; i < 40; i++) {
    try { return (await (await fetch("http://127.0.0.1:9337/json/version")).json()).webSocketDebuggerUrl; }
    catch { await sleep(250); }
  }
  throw new Error("no CDP");
}
const ws = new WebSocket(await wsUrl());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1; const pending = new Map(); const errors = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  else if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") errors.push(m.params.entry.text.slice(0, 300));
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const cmd = (m, p) => send(m, p, sessionId);
await cmd("Page.enable"); await cmd("Runtime.enable"); await cmd("Log.enable");
const evaluate = async (expression) => {
  const r = await cmd("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
await cmd("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd("Page.navigate", { url: PAGE });
await sleep(3500);

console.log("images:", await evaluate(`[...document.images].map(i => ({ ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth }))`));
console.log("title:", await evaluate(`document.title`));
console.log("sections:", await evaluate(`[...document.querySelectorAll('main section')].length`));
console.log("h1:", await evaluate(`document.querySelector('h1').innerText`));
console.log("year:", await evaluate(`document.querySelector('[data-year]').textContent`));
console.log("scrollHeight:", await evaluate(`document.body.scrollHeight`));
console.log("h-overflow:", await evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`));

// Theme cycle: system → light → dark → system
console.log("theme before:", await evaluate(`document.documentElement.getAttribute('data-theme')`));
await evaluate(`document.querySelector('[data-theme-toggle]').click(); true`);
console.log("theme after 1:", await evaluate(`document.documentElement.getAttribute('data-theme')`));
await evaluate(`document.querySelector('[data-theme-toggle]').click(); true`);
console.log("theme after 2:", await evaluate(`document.documentElement.getAttribute('data-theme')`));
console.log("dark bg:", await evaluate(`getComputedStyle(document.body).backgroundColor`));
let { data } = await cmd("Page.captureScreenshot", { format: "png" });
writeFileSync(OUT + "landing-dark.png", Buffer.from(data, "base64"));
await evaluate(`document.querySelector('[data-theme-toggle]').click(); true`); // back to system
await evaluate(`document.documentElement.setAttribute('data-theme','light'); true`);
await sleep(400);
({ data } = await cmd("Page.captureScreenshot", { format: "png" }));
writeFileSync(OUT + "landing-light.png", Buffer.from(data, "base64"));

// Mobile layout + menu
await cmd("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await sleep(600);
console.log("mobile h-overflow:", await evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`));
console.log("menu visible:", await evaluate(`getComputedStyle(document.querySelector('[data-menu]')).display !== 'none'`));
await evaluate(`document.querySelector('[data-menu]').click(); true`);
console.log("mobile nav open:", await evaluate(`document.querySelector('[data-mobile-nav]').classList.contains('open')`));
({ data } = await cmd("Page.captureScreenshot", { format: "png" }));
writeFileSync(OUT + "landing-mobile.png", Buffer.from(data, "base64"));

// Scroll through so lazy images decode, then re-check.
await cmd("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await evaluate(`(async()=>{for(let y=0;y<=document.body.scrollHeight;y+=700){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,120));}return true})()`);
await sleep(1200);
console.log("images after scroll:", await evaluate(`[...document.images].every(i => i.complete && i.naturalWidth > 0)`));
console.log("panelshot:", await evaluate(`(() => { const i = document.querySelector('.panelshot img'); const r = i.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), ratio: +(r.width / r.height).toFixed(3), natural: +(i.naturalWidth / i.naturalHeight).toFixed(3) }; })()`));
console.log("page errors:", errors.length ? errors : "none");
chrome.kill(); ws.close(); process.exit(0);
