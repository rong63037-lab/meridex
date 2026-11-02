import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const apps = ["web", "web-admin", "web-pool"];

function walk(dir, out) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "cache") continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(path, out);
    else if (/\.(js|css|html|json)$/.test(name) && !name.endsWith(".map")) out.push(path);
  }
}

const built = [];
for (const app of apps) {
  const dir = join(root, app, ".next");
  try {
    if (statSync(dir).isDirectory()) walk(dir, built);
  } catch {
    /* not built */
  }
}

const source = [];
for (const app of apps) {
  walk(join(root, app), source);
}
const mode = built.length ? "built" : "source";
const scan = mode === "built" ? built : source.filter((path) => !path.includes("/.next/") && !path.endsWith(".map"));

const stringRe = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;
const hits = [];

function unescape(body) {
  return body.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}

for (const path of scan) {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  if (text.includes("演示")) {
    hits.push(`${path}: contains 演示`);
    continue;
  }
  if (path.endsWith(".css") && /demo/i.test(text)) {
    hits.push(`${path}: css contains demo`);
    continue;
  }
  const seen = new Set();
  for (const match of text.matchAll(stringRe)) {
    const raw = match[0];
    const body = unescape(raw.slice(1, -1));
    if (!/demo|演示/i.test(body)) continue;
    if (seen.has(body)) continue;
    seen.add(body);
    // Copy keys and the API code are identifiers. A label has a space or other words.
    if (/^[A-Za-z0-9_.]+$/.test(body) && /demo/i.test(body)) continue;
    hits.push(`${path}: ${body.slice(0, 180)}`);
    if (hits.length > 40) break;
  }
  if (hits.length > 40) break;
}

if (!scan.length) {
  console.error("no UI files to scan");
  process.exit(1);
}
if (hits.length) {
  console.error(`leftover demo wording (${mode}, ${scan.length} files)`);
  for (const hit of hits) console.error(hit);
  process.exit(1);
}
console.log(`no demo wording in ${mode} UI strings (${scan.length} files)`);
