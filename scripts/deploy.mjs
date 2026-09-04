// Copies the built plugin into an Obsidian vault. Obsidian loads plugins from
// the vault's .obsidian/plugins folder, never from this repo, so a build alone
// changes nothing in the app.
//
// The target path is per-machine (and usually contains a personal vault path),
// so it stays out of git: set OBSIDIAN_PLUGIN_DIR, or drop the path in a
// .deploy-target file next to this repo's package.json.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetFile = join(root, ".deploy-target");

const target = (
	process.env.OBSIDIAN_PLUGIN_DIR ||
	(existsSync(targetFile) ? readFileSync(targetFile, "utf8") : "")
).trim();

if (!target) {
	console.error(
		"No deploy target. Set OBSIDIAN_PLUGIN_DIR, or write the plugin folder\n" +
			"path (…/YourVault/.obsidian/plugins/link-hover-reveal) to .deploy-target."
	);
	process.exit(1);
}

mkdirSync(target, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
	copyFileSync(join(root, file), join(target, file));
}
console.log(`Deployed to ${target}`);
console.log("Reload the plugin in Obsidian (or Cmd-R) to pick it up.");
