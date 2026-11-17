/** Re-capture the broadcast surface with a populated stream draft. */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("./shots/", import.meta.url));
const chrome = spawn("google-chrome-stable", [
  "--headless=new", "--remote-debugging-port=9334",
  "--user-data-dir=/tmp/soloman-landing-chrome", "--no-first-run",
  "--no-default-browser-check", "--hide-scrollbars", "--window-size=1600,1000",
  "--mute-audio", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wsUrl() {
  for (let i = 0; i < 40; i++) {
    try { return (await (await fetch("http://127.0.0.1:9334/json/version")).json()).webSocketDebuggerUrl; }
    catch { await sleep(250); }
  }
  throw new Error("no CDP");
}
const ws = new WebSocket(await wsUrl());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1; const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const cmd = (m, p) => send(m, p, sessionId);
await cmd("Page.enable"); await cmd("Runtime.enable");
await cmd("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1.5, mobile: false });
const evaluate = async (expression) => {
  const r = await cmd("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};

await cmd("Page.navigate", { url: "http://localhost:32111/" });
let booted = false;
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  try { booted = await evaluate(`(async()=>{const m=await import('/src/store/editorStore.ts');return !m.editorStore.getState().ui.booting})()`); } catch {}
  if (booted) break;
}
if (!booted) throw new Error("no boot");

await evaluate(`(async () => {
  const m = await import('/src/store/editorStore.ts');
  m.editor().pause();
  m.editor().setUi({ mode: 'broadcast' });
  return true;
})()`);
await sleep(1200);
// Add a stream, make it a timeline stream, tick the YouTube destination.
console.log(await evaluate(`(() => {
  const byText = (t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t);
  byText('Add stream')?.click();
  return !!byText('Add stream');
})()`));
await sleep(600);
console.log(await evaluate(`(() => {
  const byText = (t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t);
  byText('Timeline')?.click();
  return !!byText('Timeline');
})()`));
await sleep(400);
console.log(await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('YouTube · Main channel'));
  b?.click();
  return !!b;
})()`));
await sleep(900);
console.log(await evaluate(`document.querySelector('main')?.innerText.slice(0, 900)`));
const { data } = await cmd("Page.captureScreenshot", { format: "png" });
writeFileSync(OUT + "broadcast.png", Buffer.from(data, "base64"));
console.log("captured broadcast");
chrome.kill(); ws.close(); process.exit(0);
