const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const archive = process.argv[2] || 'release/win-unpacked/resources/app.asar';
const html = asar.extractFile(archive, 'dist/index.html').toString('utf8');
const main = asar.extractFile(archive, 'electron/main.cjs').toString('utf8');
// Entry paths keep the platform separator, so they are read back verbatim rather than
// rebuilt from the bare file name.
const assets = asar.listPackage(archive).filter((entry) => /[\\/]dist[\\/]assets[\\/].+\.(js|css)$/.test(entry));
const bundled = assets.map((entry) => entry.replace(/^.*[\\/]/, ''));
// One bundle carries the game and the synthesizer; asserting on their contents proves the
// packaged build is not a stale dist from before these features existed.
/**
 * Archive entries arrive with a leading separator; asar resolves nested paths with the
 * host's separator, so the rest of the entry is passed through untouched.
 */
function readEntry(entry) {
  return asar.extractFile(archive, entry.replace(/^[\\/]+/, '')).toString('utf8');
}

const scripts = assets
  .filter((entry) => entry.endsWith('.js'))
  .map((entry) => readEntry(entry))
  .join('\n');

const iconFile = path.join(__dirname, '..', 'build', 'icon.ico');
const iconHeader = fs.existsSync(iconFile) ? fs.readFileSync(iconFile).subarray(0, 6) : Buffer.alloc(0);

const checks = {
  'online option': html.includes('value="ONLINE"'),
  'lobby markup': html.includes('id="lobby"'),
  'room code input': html.includes('id="room-code-input"'),
  'online help text': html.includes('Online / LAN:'),
  'sound toggle markup': html.includes('id="sound-toggle"') && html.includes('aria-label="Mute sound'),
  'sound help text': html.includes('<kbd>M</kbd>'),
  'sfx bundled': scripts.includes('jujutsu-cards.sfx.muted'),
  'sound cues bundled': scripts.includes('DOMAIN_EXPANSION') && scripts.includes('BLACK_FLASH'),
  'loads dist over file://': main.includes("loadFile(path.join(__dirname, '..', 'dist', 'index.html'))"),
  'dev window icon': main.includes("'build', 'icon.png'"),
  'relative asset urls': html.includes('./assets/'),
  'bundled assets': bundled.length >= 2,
  'icon.ico present': iconHeader.length === 6 && iconHeader.readUInt16LE(0) === 0 && iconHeader.readUInt16LE(2) === 1,
};

let failed = 0;
for (const [name, ok] of Object.entries(checks)) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
}
console.log(`bundled: ${bundled.join(', ')}`);
process.exit(failed === 0 ? 0 : 1);
