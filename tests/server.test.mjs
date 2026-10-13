import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp,runtimeConfig} from '../lib/app.mjs';
import {createStore,StorageError,StoreCorruptionError} from '../lib/store.mjs';
import {digest} from '../lib/auth.mjs';

const KEY='synthetic-test-only-key-01234567890123456789';
const entry={id:'entry-one',jobId:'jena',date:'2030-06-12',start:'09:00',end:'11:30',endNextDay:false,tasks:'synthetic-private-task'};
async function setup(t,{cloud=false,wrapStore=store=>store}={}){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'planner-http-test-'));
  const store=wrapStore(await createStore({mode:'local',dataDir}));
  const config={mode:cloud?'cloud':'local',cloud,accessKeyHash:cloud?digest(KEY):'',dataDir};
  const app=await createApp({config,store,calendarOptions:{autoSync:false,fetch:()=>{throw Error('Network forbidden in synthetic tests');}}});
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,host=cloud?'planner.example':`127.0.0.1:${port}`,origin=`${cloud?'https':'http'}://${host}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await app.close();assert.equal(path.dirname(path.resolve(dataDir)),path.resolve(os.tmpdir()));await fs.rm(dataDir,{recursive:true,force:true});});
  async function call(route,{method='GET',body,headers={}}={}){
    const content=body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body);
    const defaults={Host:host,...(!['GET','HEAD'].includes(method)?{Origin:origin}:{}),...(content!==undefined?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(content)}:{})};
    return new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port,path:route,method,headers:{...defaults,...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const bytes=Buffer.concat(chunks);resolve({status:res.statusCode,headers:res.headers,bytes,text:bytes.toString(),json:()=>JSON.parse(bytes.toString())});});});
      req.on('error',reject);req.end(content);
    });
  }
  async function signIn(){const response=await call('/api/login',{method:'POST',body:{accessKey:KEY}});assert.equal(response.status,200);return response.headers['set-cookie'][0].split(';')[0];}
  return {store,call,signIn,origin};
}

test('runtime config refuses unsafe cloud/local fallback and separates preview data',()=>{
  assert.throws(()=>runtimeConfig({VERCEL:'1',WORK_PLANNER_MODE:'local'}),/Invalid storage/);
  assert.throws(()=>runtimeConfig({VERCEL:'1'}),/must be configured/);
  const env={VERCEL:'1',BLOB_READ_WRITE_TOKEN:'test-only-token',WORK_PLANNER_ACCESS_KEY_HASH:digest(KEY)};
  assert.equal(runtimeConfig({...env,VERCEL_ENV:'production'}).prefix,'work-planner-production');
  assert.equal(runtimeConfig({...env,VERCEL_ENV:'preview'}).prefix,'work-planner-preview');
});

test('postgres cloud storage requires a database and access key without falling back to Blob',()=>{
  const env={VERCEL:'1',WORK_PLANNER_STORAGE:'postgres',DATABASE_URL:'postgresql://synthetic:password@db.example/planner',WORK_PLANNER_ACCESS_KEY_HASH:digest(KEY)};
  const config=runtimeConfig(env);
  assert.equal(config.storage,'postgres');assert.equal(config.mode,'cloud');
  assert.equal(config.databaseUrl,env.DATABASE_URL);assert.equal(config.blobToken,undefined);
  assert.equal(runtimeConfig({...env,WORK_PLANNER_DATABASE_URL:'explicit-test-url'}).databaseUrl,'explicit-test-url');
  assert.throws(()=>runtimeConfig({...env,DATABASE_URL:'',BLOB_READ_WRITE_TOKEN:'unused'}),/must be configured/);
  assert.throws(()=>runtimeConfig({...env,WORK_PLANNER_ACCESS_KEY_HASH:''}),/must be configured/);
  assert.throws(()=>runtimeConfig({...env,WORK_PLANNER_STORAGE:'unknown'}),/Invalid storage/);
  assert.equal(runtimeConfig({WORK_PLANNER_MODE:'local',WORK_PLANNER_STORAGE:'postgres'}).storage,'local');
});

test('anonymous cloud users get only login assets and public status; private routes are denied',async t=>{
  const {call,store}=await setup(t,{cloud:true});
  await store.write('state',{version:1,revision:0,entries:[entry]},null);
  const info=await call('/api/session');assert.deepEqual(info.json(),{authenticated:false,mode:'cloud',authRequired:true});
  assert.equal((await call('/api/health')).status,200);
  for(const asset of ['/login','/login.html','/login.mjs','/session.mjs','/style.css','/favicon.svg']){
    const response=await call(asset);assert.equal(response.status,200,asset);assert.ok(!response.text.includes(entry.tasks));assert.equal(response.headers['cache-control'],'no-store');
  }
  for(const route of ['/','/index.html','/app.mjs','/.data/state.json']){const response=await call(route);assert.equal(response.status,303,route);assert.equal(response.headers.location,'/login');}
  for(const [route,method] of [['/api/state','GET'],['/api/state','PUT'],['/api/calendar?month=2030-06','GET'],['/api/export','POST'],['/api/calendar/config','POST'],['/api/logout','POST']]){
    const response=await call(route,{method,body:method==='GET'?undefined:{}});assert.equal(response.status,401,route);assert.ok(!response.text.includes(entry.tasks));
  }
});

test('authenticated cloud state and export work; logout revokes session',async t=>{
  const {call,signIn}=await setup(t,{cloud:true}),cookie=await signIn(),headers={Cookie:cookie};
  const session=(await call('/api/session',{headers})).json();assert.equal(session.authenticated,true);
  const html=await call('/',{headers});assert.equal(html.status,200);assert.match(html.headers['content-security-policy'],/script-src 'self'/);assert.equal(html.headers['x-frame-options'],'DENY');assert.equal(html.headers['referrer-policy'],'no-referrer');assert.equal(html.headers['x-content-type-options'],'nosniff');
  const saved=await call('/api/state',{method:'PUT',headers,body:{revision:0,entries:[entry]}});assert.deepEqual(saved.json(),{revision:1});
  assert.equal((await call('/api/state',{headers})).json().entries[0].tasks,entry.tasks);
  const exported=await call('/api/export',{method:'POST',headers,body:{entries:[entry],jobId:'jena',month:'2030-06'}});
  assert.equal(exported.status,200);assert.equal(exported.bytes.subarray(0,2).toString(),'PK');assert.match(exported.headers['content-type'],/spreadsheetml/);assert.match(exported.headers['content-disposition'],/Jena_2030-06\.xlsx/i);assert.equal(exported.headers['cache-control'],'no-store');
  assert.equal((await call('/api/logout',{method:'POST',headers})).status,200);
  assert.equal((await call('/api/state',{headers})).status,401);
});

test('local server rejects DNS-rebinding hosts and cross-origin mutations',async t=>{
  const {call,origin}=await setup(t);
  assert.equal((await call('/api/state',{headers:{Host:'attacker.example'}})).status,403);
  for(const headers of [{Origin:'https://attacker.example'},{Origin:''},{Origin:origin,'Sec-Fetch-Site':'cross-site'}]){
    assert.equal((await call('/api/state',{method:'PUT',headers,body:{revision:0,entries:[entry]}})).status,403);
    assert.equal((await call('/api/login',{method:'POST',headers,body:{accessKey:KEY}})).status,403);
  }
  assert.deepEqual((await call('/api/state')).json().entries,[]);
});

test('local state writes reject stale revisions, malformed records and oversized bodies',async t=>{
  const {call}=await setup(t);
  assert.equal((await call('/api/state',{method:'PUT',body:{revision:0,entries:[entry]}})).status,200);
  assert.equal((await call('/api/state',{method:'PUT',body:{revision:0,entries:[]}})).status,409);
  assert.equal((await call('/api/state',{method:'PUT',body:{revision:1,entries:[{...entry,date:'2030-06-12" onclick="bad'}]}})).status,400);
  assert.equal((await call('/api/state',{method:'PUT',body:'{invalid json'})).status,400);
  assert.equal((await call('/api/state',{method:'PUT',body:'{}',headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await call('/api/state',{method:'PUT',body:' '.repeat(2*1024*1024+1)})).status,413);
  const after=(await call('/api/state')).json();assert.equal(after.revision,1);assert.equal(after.entries[0].tasks,entry.tasks);
});

test('concurrent state writes cannot silently overwrite each other',async t=>{
  const {call}=await setup(t);
  const responses=await Promise.all(['first','second'].map(tasks=>call('/api/state',{method:'PUT',body:{revision:0,entries:[{...entry,tasks}]}})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  assert.equal((await call('/api/state')).json().revision,1);
});

test('static serving never exposes data, source, env, or path traversal',async t=>{
  const {call}=await setup(t);
  for(const route of ['/.env','/.data/state.json','/lib/auth.mjs','/../package.json','/%2e%2e/package.json','/public/../package.json','/calendar-service.mjs'])assert.equal((await call(route)).status,404,route);
  assert.equal((await call('/index.html',{method:'HEAD'})).bytes.length,0);
});

test('blocked cloud storage leaves login assets and health available while private routes fail closed',async t=>{
  let reads=0,updates=0,writes=0;
  const upstreamSecret='upstream-token-and-calendar-secret';
  const fail=()=>{throw new StorageError(upstreamSecret);};
  const {call}=await setup(t,{cloud:true,wrapStore:store=>({...store,
    read:async()=>{reads++;fail();},update:async()=>{updates++;fail();},write:async()=>{writes++;fail();},
  })});
  assert.equal(reads,0,'starting the app must not access Blob');
  const headers={Cookie:'__Host-work_planner='+'x'.repeat(43)};
  for(const route of ['/api/health','/login','/login.mjs','/session.mjs','/style.css','/favicon.svg']){
    const response=await call(route,{headers});assert.equal(response.status,200,route);
    assert.equal(response.headers['cache-control'],'no-store');
  }
  assert.equal(reads,0,'public assets must not attempt session or calendar reads');
  assert.equal((await call('/api/state')).status,401);
  for(const route of ['/api/session','/api/state','/']){
    const response=await call(route,{headers});assert.equal(response.status,503,route);
    assert.equal(response.json().code,'STORAGE_UNAVAILABLE');assert.equal(response.headers['retry-after'],'300');
    assert.ok(!response.text.includes(upstreamSecret));assert.ok(!response.text.includes('entries'));
  }
  const login=await call('/api/login',{method:'POST',body:{accessKey:KEY}});
  assert.equal(login.status,503);assert.equal(login.json().code,'STORAGE_UNAVAILABLE');
  assert.equal(login.headers['set-cookie'],undefined);assert.equal(updates,1);assert.equal(writes,0);
  for(const route of ['/','/index.html']){
    const page=await call(route,{headers:{...headers,Accept:'text/html,application/xhtml+xml'}});
    assert.equal(page.status,503);assert.match(page.headers['content-type'],/text\/html/);assert.equal(page.headers['retry-after'],'300');
    assert.match(page.text,/id="login-form"/);assert.ok(!page.text.includes('/app.mjs'));assert.ok(!page.text.includes(upstreamSecret));
    assert.equal(page.headers['set-cookie'],undefined,'outage must not revoke an existing session');
  }
  const privateAsset=await call('/app.mjs',{headers:{...headers,Accept:'text/html'}});
  assert.equal(privateAsset.status,503);assert.equal(privateAsset.json().code,'STORAGE_UNAVAILABLE');
  const api=await call('/api/state',{headers:{...headers,Accept:'text/html'}});
  assert.equal(api.status,503);assert.equal(api.json().code,'STORAGE_UNAVAILABLE');
});

test('storage outage never replaces existing entries and saving recovers without restarting the app',async t=>{
  let unavailable=false,original,writes=0;
  const {call,signIn,store}=await setup(t,{cloud:true,wrapStore:underlying=>{
    original=underlying;
    return {...underlying,
      read:async(key,fallback)=>{if(unavailable&&key==='state')throw new StorageError('private upstream failure');return underlying.read(key,fallback);},
      write:async(...args)=>{writes++;return underlying.write(...args);},
    };
  }});
  await store.write('state',{version:1,revision:7,entries:[entry]},null);
  const headers={Cookie:await signIn()};unavailable=true;
  for(const [route,options] of [['/api/state',{headers}],['/api/state',{method:'PUT',headers,body:{revision:7,entries:[]}}]]){
    const response=await call(route,options);assert.equal(response.status,503);assert.equal(response.json().code,'STORAGE_UNAVAILABLE');
  }
  assert.equal(writes,1,'an unavailable read must never trigger a replacement write');
  assert.deepEqual((await original.read('state')).value,{version:1,revision:7,entries:[entry]});
  unavailable=false;
  assert.deepEqual((await call('/api/state',{headers})).json().entries,[entry]);
  const changed={...entry,tasks:'Updated after storage recovery'};
  assert.deepEqual((await call('/api/state',{method:'PUT',headers,body:{revision:7,entries:[changed]}})).json(),{revision:8});
  assert.deepEqual((await call('/api/state',{headers})).json().entries,[changed]);
});

test('calendar initialization is lazy and can retry after failure without blocking work records',async t=>{
  let unavailable=true,calendarReads=0;
  const {call,store}=await setup(t,{wrapStore:underlying=>({...underlying,
    read:async(key,fallback)=>{
      if(key.startsWith('calendar-')){calendarReads++;if(unavailable)throw new StorageError('private feed unavailable');}
      return underlying.read(key,fallback);
    },
  })});
  assert.equal(calendarReads,0);
  await store.write('state',{version:1,revision:2,entries:[entry]},null);
  assert.equal((await call('/')).status,200);
  assert.deepEqual((await call('/api/state')).json().entries,[entry]);
  const failure=await call('/api/calendar?month=2030-06');
  assert.equal(failure.status,503);assert.equal(failure.json().code,'STORAGE_UNAVAILABLE');
  unavailable=false;
  const recovered=await call('/api/calendar?month=2030-06');
  assert.equal(recovered.status,200);assert.deepEqual(recovered.json().events,[]);
  assert.deepEqual((await call('/api/state')).json().entries,[entry]);
});

test('unreadable persisted records return an explicit service error instead of an empty state',async t=>{
  let writes=0;
  const {call}=await setup(t,{wrapStore:underlying=>({...underlying,
    read:async()=>{throw new StoreCorruptionError();},write:async()=>{writes++;},
  })});
  const response=await call('/api/state');
  assert.equal(response.status,503);assert.equal(response.json().code,'STORAGE_UNREADABLE');
  assert.ok(!response.text.includes('entries'));assert.equal(writes,0);
  assert.equal((await call('/login')).status,200);
});
