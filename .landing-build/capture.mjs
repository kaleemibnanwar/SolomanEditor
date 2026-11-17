/**
 * Landing-page screenshot capture. Drives a throwaway headless Chrome over CDP
 * against the running Vite dev server. Nothing here touches the app source.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const PORT = 32111;
const CDP = 9333;
const OUT = new URL("./shots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const chrome = spawn("google-chrome-stable", [
  "--headless=new",
  `--remote-debugging-port=${CDP}`,
  "--user-data-dir=/tmp/soloman-landing-chrome",
  "--no-first-run",
  "--no-default-browser-check",
  "--hide-scrollbars",
  "--window-size=1600,1000",
  "--mute-audio",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browserWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
      return v.webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  throw new Error("Chrome CDP never came up");
}

const ws = new WebSocket(await browserWsUrl());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let nextId = 1;
const pending = new Map();
const listeners = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method) {
    for (const l of listeners) l(msg);
  }
});
function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const cmd = (m, p) => send(m, p, sessionId);

await cmd("Page.enable");
await cmd("Runtime.enable");
await cmd("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1.5, mobile: false });

async function evaluate(expression) {
  const r = await cmd("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
}

async function shot(name) {
  await sleep(900);
  const { data } = await cmd("Page.captureScreenshot", { format: "png" });
  writeFileSync(OUT + name + ".png", Buffer.from(data, "base64"));
  console.log("captured", name);
}

console.log("navigating…");
await cmd("Page.navigate", { url: `http://localhost:${PORT}/` });

// Wait for the welcome project to finish booting (photos + music render).
let booted = false;
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  try {
    booted = await evaluate(`(async () => {
      const m = await import('/src/store/editorStore.ts');
      return !m.editorStore.getState().ui.booting;
    })()`);
  } catch { /* page still loading */ }
  if (booted) break;
}
if (!booted) throw new Error("editor never finished booting");
console.log("booted");
await evaluate(`document.fonts.ready.then(() => true)`);

// 1 — Edit surface, paused on the night scene with its guided-tour title.
await evaluate(`(async () => {
  const m = await import('/src/store/editorStore.ts');
  m.editor().pause();
  m.editor().setCurrentTime(6.5);
  return true;
})()`);
await shot("edit");

// 2 — Background library tab (the bundled photography).
await evaluate(`(async () => {
  const m = await import('/src/store/editorStore.ts');
  m.editor().setUi({ libraryTab: 'background' });
  return true;
})()`);
await shot("library");
await evaluate(`(async () => {
  const m = await import('/src/store/editorStore.ts');
  m.editor().setUi({ libraryTab: 'media' });
  return true;
})()`);

// 3 — Agent panel over the editor.
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Agent')?.click(); true`);
await shot("agent");
await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(500);

// 4 — Image studio (same project rendered as a still).
await evaluate(`(async () => {
  const m = await import('/src/store/editorStore.ts');
  m.editor().setUi({ mode: 'image' });
  return true;
})()`);
await shot("image");

// 5 — Broadcast studio, with two plausible destinations seeded in this throwaway profile.
await evaluate(`(async () => {
  const b = await import('/src/lib/broadcast.ts');
  await b.saveStreamConfig({ name: 'YouTube · Main channel', protocol: 'rtmp', address: 'rtmp://a.rtmp.youtube.com/live2', streamKey: 'xxxx-xxxx-xxxx-xxxx', platform: 'YouTube' });
  await b.saveStreamConfig({ name: 'Hardware encoder', protocol: 'srt', address: 'srt://192.168.1.40:9000', streamKey: '', platform: 'SRT' });
  const m = await import('/src/store/editorStore.ts');
  m.editor().setUi({ mode: 'broadcast' });
  return true;
})()`);
await shot("broadcast");

chrome.kill();
ws.close();
console.log("done");
process.exit(0);
