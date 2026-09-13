import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 8_000_000 });
const files = git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean);
const skipExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".zip", ".xcassets"]);
const forbiddenPath = (file) => {
  const base = path.basename(file);
  return (base.startsWith(".env") && base !== ".env.example") || /\.(?:sqlite(?:-wal|-shm)?|pem|key)$/i.test(base) || base === "appcast.xml";
};
const patterns = [
  [/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/, "private key"],
  [/\bgh[opusr]_[A-Za-z0-9_]{30,}\b/, "GitHub token"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/, "API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [new RegExp(["ssh-key", "removing-restricted"].join("-")), "private infrastructure path"],
  [new RegExp(["leo-web-key", "pem"].join("\\.")), "private infrastructure path"]
];
const findings = [];
function check(file, data, where) {
  if (forbiddenPath(file)) findings.push(`${where}: forbidden file ${file}`);
  if (skipExtensions.has(path.extname(file).toLowerCase()) || data.length > 2_000_000) return;
  const content = data.toString("utf8");
  for (const [pattern, label] of patterns) if (pattern.test(content)) findings.push(`${where}: ${file}: ${label}`);
}
for (const file of files) check(file, fs.readFileSync(file), "working tree");

const objects = git("rev-list", "--objects", "--all").split("\n").filter(Boolean);
const seen = new Set();
for (const line of objects) {
  const separator = line.indexOf(" ");
  if (separator < 0) continue;
  const hash = line.slice(0, separator);
  const file = line.slice(separator + 1);
  if (seen.has(hash)) continue;
  seen.add(hash);
  if (git("cat-file", "-t", hash).trim() !== "blob") continue;
  if (Number(git("cat-file", "-s", hash)) > 2_000_000) { if (forbiddenPath(file)) findings.push(`history: forbidden file ${file}`); continue; }
  check(file, execFileSync("git", ["cat-file", "blob", hash], { maxBuffer: 3_000_000 }), `history ${hash.slice(0, 12)}`);
}
if (findings.length) { console.error(findings.join("\n")); process.exit(1); }
console.log(`Secret scan passed (${files.length} working files, ${seen.size} historical objects checked).`);
