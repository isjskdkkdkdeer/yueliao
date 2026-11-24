import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const projectRoot=fileURLToPath(new URL('../',import.meta.url));
await mkdir(new URL('../dist/vendor/',import.meta.url),{recursive:true});
await build({
  absWorkingDir:projectRoot,
  entryPoints:['node_modules/peerjs/dist/bundler.mjs'],
  outfile:'dist/vendor/peerjs.js',
  bundle:true,
  format:'esm',
  platform:'browser',
  target:['es2020'],
  minify:true,
  legalComments:'eof',
});
await copyFile(new URL('../node_modules/peerjs/LICENSE',import.meta.url),new URL('../dist/vendor/peerjs.LICENSE.txt',import.meta.url));
console.log('Built browser ESM vendor bundle: dist/vendor/peerjs.js');
