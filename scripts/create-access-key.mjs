import fs from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
const dir=new URL('../.secrets/',import.meta.url);
await fs.mkdir(dir,{recursive:true,mode:0o700});
const key=randomBytes(32).toString('base64url');
const hash=createHash('sha256').update(key).digest('hex');
await fs.writeFile(new URL('access-key.txt',dir),key+'\n',{flag:'wx',mode:0o600});
await fs.writeFile(new URL('cloud.env',dir),`WORK_PLANNER_ACCESS_KEY_HASH=${hash}\nWORK_PLANNER_MODE=cloud\n`,{flag:'wx',mode:0o600});
console.log('Created .secrets/access-key.txt and .secrets/cloud.env. Keep them private; never commit or share them.');
