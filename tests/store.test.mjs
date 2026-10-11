import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {BlobError,BlobPreconditionFailedError} from '@vercel/blob';
import {createStore,ConflictError,StoreCorruptionError} from '../lib/store.mjs';

async function local(t) {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'planner-store-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  return {dataDir,store:await createStore({dataDir})};
}
function fakeBlob() {
  const values=new Map();let sequence=0;
  return {values,BlobError,BlobPreconditionFailedError,
    async get(key,options){
      assert.equal(options.access,'private');assert.equal(options.useCache,false);
      assert.equal(options.token,'test-only-token');
      const current=values.get(key);
      // Match the real provider: compressed representations have weak ETags.
      const transformed=current&&current.text.length>1024&&options.headers?.['accept-encoding']!=='identity';
      return current?{statusCode:200,stream:new Response(current.text).body,blob:{etag:(transformed?'W/':'')+current.etag,size:Buffer.byteLength(current.text)}}:null;
    },
    async put(key,text,options){
      assert.equal(options.access,'private');assert.equal(options.addRandomSuffix,false);
      assert.equal(options.token,'test-only-token');
      const current=values.get(key);
      if(current&&!options.allowOverwrite)throw new BlobError('This blob already exists; enable allowOverwrite to replace it.');
      if(options.allowOverwrite&&(!options.ifMatch||current?.etag!==options.ifMatch))throw new BlobPreconditionFailedError();
      const etag='"'+(++sequence)+'"';values.set(key,{text,etag});return {etag};
    }
  };
}

test('local data persists, ETags reject stale or unconditional writes, and keys cannot escape the data directory',async t=>{
  const {store,dataDir}=await local(t);
  const blank=await store.read('state',{rows:[]});assert.equal(blank.etag,null);
  const first=await store.write('state',{rows:[1]},null);
  await assert.rejects(store.write('state',{rows:[2]},null),ConflictError);
  await assert.rejects(store.write('state',{rows:[2]}),/explicit prior ETag/);
  const second=await store.write('state',{rows:[2]},first);assert.notEqual(first,second);
  await assert.rejects(store.write('state',{rows:[3]},first),ConflictError);
  assert.deepEqual((await (await createStore({dataDir})).read('state')).value,{rows:[2]});
  for(const key of ['../secrets','__proto__','state.json','/etc/passwd'])await assert.rejects(store.read(key),/Invalid storage key/);
  assert.deepEqual((await fs.readdir(dataDir)).sort(),['state.json']);
});

test('local updates serialize across separate store instances without losing writes',async t=>{
  const {store,dataDir}=await local(t),other=await createStore({dataDir});
  await Promise.all(Array.from({length:30},(_,index)=>(index%2?store:other).update('auth-rate-limits',{count:0},async value=>{
    await new Promise(r=>setTimeout(r,1));return {count:value.count+1};
  })));
  assert.equal((await store.read('auth-rate-limits')).value.count,30);
});

test('independent Node processes also serialize local writes',async t=>{
  const {store,dataDir}=await local(t);
  const moduleUrl=new URL('../lib/store.mjs',import.meta.url).href;
  const script=`import {createStore} from ${JSON.stringify(moduleUrl)};
    const store=await createStore({dataDir:process.argv[1]});
    for(let n=0;n<8;n++)await store.update('state',{count:0},async value=>{
      await new Promise(resolve=>setTimeout(resolve,3));return {count:value.count+1};
    });`;
  const run=()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',script,dataDir],{windowsHide:true});
    let error='';child.stderr.on('data',data=>error+=data);
    child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(error)));
  });
  await Promise.all([run(),run()]);
  assert.equal((await store.read('state')).value.count,16);
});

test('malformed local data is preserved and fails explicitly rather than silently resetting',async t=>{
  const {store,dataDir}=await local(t);
  await fs.writeFile(path.join(dataDir,'state.json'),'not-json');
  await assert.rejects(store.read('state',{}),StoreCorruptionError);
  await assert.rejects(store.write('state',{},null),StoreCorruptionError);
  assert.equal(await fs.readFile(path.join(dataDir,'state.json'),'utf8'),'not-json');
});

test('private cloud storage is mandatory in cloud mode and has no disk fallback',async()=>{
  await assert.rejects(createStore({mode:'cloud',blobToken:''}),/BLOB_READ_WRITE_TOKEN/);
  await assert.rejects(createStore({mode:'cloud',blobToken:'test-only-token',prefix:'../other'}),/Invalid private storage prefix/);
  await assert.rejects(createStore({mode:'unknown'}),/mode must be/);
});

test('Blob reads bypass CDN caches; create-only and ETag writes reject overwrite races',async()=>{
  const sdk=fakeBlob(),store=await createStore({mode:'cloud',blobToken:'test-only-token',blobSdk:sdk,prefix:'planner/production'});
  assert.deepEqual(await store.read('state',{count:0}),{value:{count:0},etag:null});
  const first=await store.write('state',{count:1},null);
  await assert.rejects(store.write('state',{count:2},null),ConflictError);
  const second=await store.write('state',{count:2},first);
  await assert.rejects(store.write('state',{count:3},first),ConflictError);
  assert.deepEqual(await store.read('state'),{value:{count:2},etag:second});
  assert.deepEqual([...sdk.values.keys()],['planner/production/state.json']);
});

test('Blob CAS update retries merge simultaneous updates and never overwrites corrupted JSON',async()=>{
  const sdk=fakeBlob(),store=await createStore({mode:'cloud',blobToken:'test-only-token',blobSdk:sdk});
  await Promise.all(Array.from({length:4},()=>store.update('auth-sessions',{count:0},value=>({count:value.count+1}))));
  assert.equal((await store.read('auth-sessions')).value.count,4);
  sdk.values.set('work-planner/state.json',{text:'broken {',etag:'"bad"'});
  await assert.rejects(store.read('state',{}),StoreCorruptionError);
  assert.equal(sdk.values.get('work-planner/state.json').text,'broken {');
});

test('large cloud records remain writable after every read without weakening stale-write protection',async()=>{
  const sdk=fakeBlob(),store=await createStore({mode:'cloud',blobToken:'test-only-token',blobSdk:sdk});
  const original={revision:0,entries:Array.from({length:24},(_,i)=>({id:`row-${i}`,tasks:'شرح کار چندخطی\nDatenprüfung '.repeat(12)}))};
  await store.write('state',original,null);
  const stale=await store.read('state');
  for(let i=1;i<=5;i++){
    const current=await store.read('state');assert.ok(!current.etag.startsWith('W/'));
    current.value.revision=i;current.value.entries[0].tasks+=`\nEdit ${i}`;
    await store.write('state',current.value,current.etag);
    assert.deepEqual((await store.read('state')).value,current.value);
  }
  await assert.rejects(store.write('state',original,stale.etag),ConflictError);
  assert.equal((await store.read('state')).value.revision,5);
});

test('an unexpected weak cloud ETag is never stripped or reused as a write precondition',async()=>{
  let cancelled=false;
  const sdk={get:async()=>({statusCode:200,stream:new ReadableStream({cancel(){cancelled=true;}}),blob:{etag:'W/"compressed"',size:20}})};
  const store=await createStore({mode:'cloud',blobToken:'test-only-token',blobSdk:sdk});
  await assert.rejects(store.read('state',{}),/storage is unavailable/);assert.equal(cancelled,true);
});

test('provider errors cannot leak token-bearing URLs and do not return empty data',async()=>{
  const sdk={get:async()=>{throw new Error('secret-provider-url-and-token');}};
  const store=await createStore({mode:'cloud',blobToken:'test-only-token',blobSdk:sdk});
  await assert.rejects(store.read('state',{}),error=>error.name==='StorageError'&&!error.message.includes('secret'));
});

test('a missing ETag or unexpected 304 fails closed and cancels any unused body',async()=>{
  let cancelled=false;
  const stream=new ReadableStream({cancel(){cancelled=true;}});
  const sdk={get:async()=>({statusCode:200,stream,blob:{etag:'',size:1}})};
  const store=await createStore({mode:'cloud',blobToken:'test-only-token',blobSdk:sdk});
  await assert.rejects(store.read('state',{}),/storage is unavailable/);assert.equal(cancelled,true);
  sdk.get=async()=>({statusCode:304,stream:null,blob:{etag:'"test"'}});
  await assert.rejects(store.read('state',{}),/storage is unavailable/);
});
