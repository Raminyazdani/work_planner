import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeState} from '../public/core.mjs';
import {createCalendarService} from '../calendar-service.mjs';
import {createStore,ConflictError} from './store.mjs';
import {createAuth} from './auth.mjs';

const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC=path.join(ROOT,'public');
const MIME={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
const EMPTY={version:1,revision:0,entries:[]};
export class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
export function runtimeConfig(env=process.env){
  const mode=env.WORK_PLANNER_MODE||(env.VERCEL?'cloud':'local');
  if(!['local','cloud'].includes(mode)||env.VERCEL&&mode!=='cloud')throw Error('Invalid storage mode');
  const cloud=mode==='cloud';
  if(cloud&&(!env.BLOB_READ_WRITE_TOKEN||!/^[a-f0-9]{64}$/i.test(env.WORK_PLANNER_ACCESS_KEY_HASH||'')))throw Error('Private storage and access key must be configured');
  // Preview deployments never read or write production data.
  const scope=env.VERCEL_ENV==='preview'?'preview':env.VERCEL_ENV==='development'?'development':'production';
  const prefix=`${env.WORK_PLANNER_STORAGE_PREFIX||'work-planner'}-${scope}`;
  return {mode,cloud,prefix,blobToken:env.BLOB_READ_WRITE_TOKEN,accessKeyHash:env.WORK_PLANNER_ACCESS_KEY_HASH||'',dataDir:path.resolve(ROOT,env.WORK_PLANNER_DATA_DIR||'.data')};
}
function headers(res,cloud){
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if(cloud)res.setHeader('Strict-Transport-Security','max-age=31536000');
}
const json=(res,status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));};
async function readBody(req,limit=2*1024*1024){
  if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw new HttpError(415,'JSON required');
  if(Number(req.headers['content-length'])>limit)throw new HttpError(413,'Request too large');
  let n=0;const chunks=[];for await(const chunk of req){n+=Buffer.byteLength(chunk);if(n>limit)throw new HttpError(413,'Request too large');chunks.push(Buffer.from(chunk));}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HttpError(400,'Invalid JSON');}
}
export async function createApp({config=runtimeConfig(),store,calendarOptions={}}={}){
  store||=await createStore(config);
  const auth=createAuth(store,config);
  const calendar=await createCalendarService(store,calendarOptions);
  const allowedFiles=new Set((await fs.readdir(PUBLIC,{withFileTypes:true})).filter(f=>f.isFile()&&MIME[path.extname(f.name)]).map(f=>f.name));
  const anonymousFiles=new Set(['login.html','login.mjs','session.mjs','style.css','favicon.svg']);
  async function handler(req,res){
    headers(res,config.cloud);
    try{
      const host=String(req.headers.host||'');
      if(!/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host))throw new HttpError(403,'Host rejected');
      if(!config.cloud&&!['127.0.0.1','localhost'].includes(host.split(':')[0]))throw new HttpError(403,'Local access only');
      const expectedOrigin=`${config.cloud?'https':'http'}://${host}`;
      const url=new URL(req.url,expectedOrigin);
      if(!['GET','HEAD'].includes(req.method)){
        if(req.headers.origin!==expectedOrigin)throw new HttpError(403,'Origin rejected');
        if(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')throw new HttpError(403,'Cross-site request rejected');
      }
      if(url.pathname==='/api/health'&&req.method==='GET')return json(res,200,{app:'work-planner',version:2});
      if(url.pathname==='/api/session'&&req.method==='GET')return json(res,200,{authenticated:await auth.session(req),mode:config.mode,authRequired:auth.required});
      if(url.pathname==='/api/login'&&req.method==='POST'){
        const input=await readBody(req,4096),result=await auth.login(req,input?.accessKey);
        if(result.error)return json(res,result.status,{error:result.error});
        if(result.cookie)res.setHeader('Set-Cookie',result.cookie);
        return json(res,200,{authenticated:true});
      }
      const route=url.pathname==='/'?'index.html':url.pathname==='/login'?'login.html':url.pathname.slice(1);
      const isPublicAsset=anonymousFiles.has(route)&&['GET','HEAD'].includes(req.method);
      if(!isPublicAsset&&!await auth.session(req)){
        if(url.pathname.startsWith('/api/'))return json(res,401,{error:'برای ادامه وارد شو.'});
        res.statusCode=303;res.setHeader('Location','/login');return res.end();
      }
      if(url.pathname==='/api/logout'&&req.method==='POST'){res.setHeader('Set-Cookie',await auth.logout(req));return json(res,200,{authenticated:false});}
      if(url.pathname==='/api/state'&&req.method==='GET')return json(res,200,(await store.read('state',EMPTY)).value);
      if(url.pathname==='/api/state'&&req.method==='PUT'){
        const input=await readBody(req);let next;
        try{next=normalizeState(input);}catch{throw new HttpError(400,'Invalid work entries');}
        const current=await store.read('state',EMPTY);
        if(!Number.isSafeInteger(input.revision)||input.revision!==current.value.revision)throw new HttpError(409,'اطلاعات در دستگاه دیگری تغییر کرده؛ قبل از ادامه نسخهٔ خودت را ذخیره و صفحه را تازه کن.');
        const revision=current.value.revision+1;
        await store.write('state',{...next,revision},current.etag);return json(res,200,{revision});
      }
      if(url.pathname==='/api/calendar'&&req.method==='GET')return json(res,200,await calendar.getMonth(url.searchParams.get('month')));
      if(url.pathname==='/api/calendar/sync'&&req.method==='POST'){const input=await readBody(req,4096);await calendar.sync(input.month);return json(res,200,await calendar.getMonth(input.month));}
      if(url.pathname==='/api/calendar/config'&&req.method==='POST'){const input=await readBody(req,4096);await calendar.configure(input);await calendar.sync(input.month);return json(res,200,await calendar.getMonth(input.month));}
      if(url.pathname==='/api/export'&&req.method==='POST'){
        const input=await readBody(req),{exportWorkbook}=await import('../export.mjs');
        const output=await exportWorkbook(normalizeState(input),input.jobId,input.month);
        res.statusCode=200;res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition',`attachment; filename="${output.filename}"`);return res.end(output.bytes);
      }
      if(!['GET','HEAD'].includes(req.method))throw new HttpError(405,'Method not allowed');
      if(!allowedFiles.has(route))throw new HttpError(404,'Not found');
      const bytes=await fs.readFile(path.join(PUBLIC,route));res.statusCode=200;res.setHeader('Content-Type',MIME[path.extname(route)]);
      return res.end(req.method==='HEAD'?undefined:bytes);
    }catch(error){
      if(res.headersSent)return res.end();
      if(error instanceof ConflictError)return json(res,409,{error:'اطلاعات هم‌زمان تغییر کرد؛ صفحه را تازه کن.'});
      if(error instanceof HttpError)return json(res,error.status,{error:error.message});
      // Never expose file paths, feed URLs, tokens or upstream error bodies.
      return json(res,400,{error:'درخواست انجام نشد. ورودی‌ها یا تنظیمات سرویس را بررسی کن.'});
    }
  }
  handler.close=()=>calendar.close();return handler;
}
