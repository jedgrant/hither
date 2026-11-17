// Copies the self-hosted Latin WOFF2 subsets from npm packages into public/fonts.
import { copyFileSync, mkdirSync } from "node:fs";
const src = "node_modules/@fontsource-variable";
const files = [
  [`${src}/fraunces/files/fraunces-latin-opsz-normal.woff2`, "fraunces.woff2"],
  [`${src}/fraunces/files/fraunces-latin-wght-italic.woff2`, "fraunces-italic.woff2"],
  [`${src}/geist/files/geist-latin-wght-normal.woff2`, "geist.woff2"],
];
mkdirSync("public/fonts", { recursive: true });
for (const [from, to] of files) copyFileSync(from, `public/fonts/${to}`);
console.log("fonts copied");
