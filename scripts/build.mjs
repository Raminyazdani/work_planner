import fs from 'node:fs/promises';
// Only the public robots file is static. The app and APIs are served by the
// authenticated function; no data or environment file enters the output.
await fs.mkdir(new URL('../dist/',import.meta.url), {recursive:true});
await fs.writeFile(new URL('../dist/robots.txt',import.meta.url),'User-agent: *\nDisallow: /\n');
console.log('Build ready: authenticated Node function + private runtime storage.');
