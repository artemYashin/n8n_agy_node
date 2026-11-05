const { copyFileSync, mkdirSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const root = resolve(__dirname, '..');
for (const [source, destination] of [
  ['nodes/AgyChatModel/agy.svg', 'dist/nodes/AgyChatModel/agy.svg'],
  ['nodes/AgyAccount/agy-account.svg', 'dist/nodes/AgyAccount/agy-account.svg'],
  ['nodes/AgyChatModel/agy.svg', 'dist/credentials/agy.svg'],
]) {
  const output = resolve(root, destination);
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(resolve(root, source), output);
}
