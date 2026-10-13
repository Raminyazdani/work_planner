import {execFileSync} from 'node:child_process';

// Inspect the exact tracked/staged snapshot, never ignored runtime data.
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const bad=[];
const forbidden=/(^|\/)(?:\.data|data|\.secrets|\.vercel|node_modules|runtime|exports|outputs|audits|proposals)(\/|$)|\.(?:pdf|xlsx?|ics|png|jpe?g|bak|log)$/i;
const patterns=[
  ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['provider credential',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|vercel_blob_rw_[A-Za-z0-9_]{20,})/],
  ['Neon database credential',/\bnpg_[A-Za-z0-9]{12,}/],
  ['Neon connection string',/postgres(?:ql)?:\/\/[^\s"'<>]+:[^\s"'<>]+@[^\s"'<>]+\.neon\.tech\b/i],
  ['private calendar feed',/calendar\.google\.com\/calendar\/ical\/[^\s"'<>]+\/private-[A-Za-z0-9_-]{24,}\/basic\.ics/],
  ['machine-specific path',/[A-Z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+[\\/]/i],
  ['unredacted access hash',/WORK_PLANNER_ACCESS_KEY_HASH\s*=\s*[a-f0-9]{64}\b/i],
];
for(const file of files){
  if(forbidden.test(file)||/(^|\/)\.env(?:\.|$)/.test(file)&&file!=='.env.example'){bad.push(`${file}: private/runtime file`);continue;}
  const data=execFileSync('git',['show',`:${file}`],{maxBuffer:5*1024*1024});
  if(data.includes(0)){bad.push(`${file}: unexpected binary file`);continue;}
  const body=data.toString('utf8');
  for(const [label,pattern] of patterns)if(pattern.test(body))bad.push(`${file}: ${label}`);
}
if(!files.includes('package.json'))bad.push('package.json is not staged/tracked; stage the intended public sources before running this scan.');
if(bad.length){console.error(bad.join('\n'));process.exitCode=1;}
else console.log(`Checked ${files.length} tracked files: no forbidden runtime files or known credential patterns found.`);
