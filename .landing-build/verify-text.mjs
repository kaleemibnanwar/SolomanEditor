/** Dump visible text per surface to verify screenshot content. */
import { spawn } from "node:child_process";
const chrome = spawn("google-chrome-stable", [
  "--headless=new", "--remote-debugging-port=9335",
  "--user-data-dir=/tmp/soloman-landing-chrome", "--no-first-run",
  "--no-default-browser-check", "--hide-scrollbars", "--window-size=1600,1000",
  "--mute-audio", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wsUrl() {
  for (let i = 0; i < 40; i++) {
    try { return (await (await fetch("http://127.0.0.1:9335/json/version")).json()).webSocketDebuggerUrl; }
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
console.log("=== EDIT ===");
console.log(await evaluate(`document.body.innerText.slice(0, 1500)`));
await evaluate(`(async()=>{const m=await import('/src/store/editorStore.ts');m.editor().setUi({mode:'broadcast'});return true})()`);
await sleep(1200);
console.log("=== BROADCAST ===");
console.log(await evaluate(`document.body.innerText.slice(0, 2000)`));
chrome.kill(); ws.close(); process.exit(0);
