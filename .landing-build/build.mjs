/** Inline the captured assets into the template → one self-contained HTML file. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const data = (p) => "data:image/webp;base64," + readFileSync(here(p)).toString("base64");

let html = readFileSync(here("./template.html"), "utf8");
const assets = {
  "%%LOGO%%": data("./logo.webp"),
  "%%SHOT_EDIT%%": data("./shots/edit.webp"),
  "%%SHOT_AGENT%%": data("./shots/agent-panel.webp"),
  "%%SHOT_IMAGE%%": data("./shots/image.webp"),
  "%%SHOT_BROADCAST%%": data("./shots/broadcast.webp"),
  "%%SHOT_LIBRARY%%": data("./shots/library.webp"),
};
for (const [token, uri] of Object.entries(assets)) html = html.split(token).join(uri);
if (/%%[A-Z_]+%%/.test(html)) throw new Error("unreplaced token remains");

const out = here("../soloman-editor-landing.html");
writeFileSync(out, html);
console.log("wrote", out, (html.length / 1024).toFixed(0) + " KB");
