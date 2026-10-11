import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../lib/store.mjs';
import {createAuth,digest} from '../lib/auth.mjs';

const KEY='synthetic-test-only-key-01234567890123456789';
const request=(cookie='',ip='192.0.2.10')=>({headers:{cookie,'x-real-ip':ip},socket:{remoteAddress:'127.0.0.1'}});
async function setup(t,options={}){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'planner-auth-test-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(dataDir)),path.resolve(os.tmpdir()));await fs.rm(dataDir,{recursive:true,force:true});});
  const store=await createStore({mode:'local',dataDir});
  return {store,auth:createAuth(store,{cloud:true,accessKeyHash:digest(KEY),...options})};
}
const cookieHeader=value=>value.split(';')[0];

test('cloud auth fails closed without a valid key hash; optional local auth works',async t=>{
  const {store}=await setup(t);
  assert.throws(()=>createAuth(store,{cloud:true}),/not configured/);
  assert.throws(()=>createAuth(store,{cloud:true,accessKeyHash:'not-a-hash'}),/not configured/);
  const local=createAuth(store,{cloud:false});
  assert.equal(local.required,false);assert.equal(await local.session(request()),true);
});

test('cloud login creates HttpOnly secure host cookie; storage retains only token digest',async t=>{
  const {store,auth}=await setup(t);
  assert.equal(await auth.session(request()),false);
  const result=await auth.login(request(),KEY);
  assert.match(result.cookie,/^__Host-work_planner=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800; Secure$/);
  const cookie=cookieHeader(result.cookie),token=cookie.split('=')[1];
  assert.equal(await auth.session(request(cookie)),true);
  const stored=(await store.read('auth-sessions')).value;
  assert.ok(stored.sessions[digest(token)]);
  assert.ok(!JSON.stringify(stored).includes(token));assert.ok(!JSON.stringify(stored).includes(KEY));
  assert.equal(await auth.session(request('__Host-work_planner='+'a'.repeat(43))),false);
});

test('logout revokes a copied cookie and sets an expired browser cookie',async t=>{
  const {auth}=await setup(t),cookie=cookieHeader((await auth.login(request(),KEY)).cookie);
  const expired=await auth.logout(request(cookie));
  assert.match(expired,/Max-Age=0/);assert.match(expired,/HttpOnly/);assert.match(expired,/Secure/);
  assert.equal(await auth.session(request(cookie)),false);
});

test('sessions expire and access-key rotation revokes existing sessions',async t=>{
  let clock=Date.UTC(2030,0,1);
  const {auth,store}=await setup(t,{now:()=>clock});
  const cookie=cookieHeader((await auth.login(request(),KEY)).cookie);
  const sameKey=createAuth(store,{cloud:true,accessKeyHash:digest(KEY).toUpperCase(),now:()=>clock});
  assert.equal(await sameKey.session(request(cookie)),true);
  const rotated=createAuth(store,{cloud:true,accessKeyHash:digest(KEY+'rotated'),now:()=>clock});
  assert.equal(await rotated.session(request(cookie)),false);
  clock+=8*60*60*1000;
  assert.equal(await auth.session(request(cookie)),false);
});

test('invalid keys are rate limited, the limit survives a fresh auth instance, and expires',async t=>{
  let clock=Date.UTC(2030,0,1);
  const {auth,store}=await setup(t,{now:()=>clock});
  for(let i=0;i<10;i++)assert.equal((await auth.login(request(),i%2?'incorrect-key':null)).status,401);
  assert.equal((await auth.login(request(),KEY)).status,429);
  const restarted=createAuth(store,{cloud:true,accessKeyHash:digest(KEY),now:()=>clock});
  assert.equal((await restarted.login(request(),KEY)).status,429);
  assert.ok((await restarted.login(request('', '192.0.2.11'),KEY)).cookie);
  clock+=15*60*1000;
  assert.ok((await restarted.login(request(),KEY)).cookie);
});

test('successful login resets the attempt count and local keyed mode omits Secure',async t=>{
  const {auth}=await setup(t,{cloud:false});
  for(let round=0;round<2;round++){
    for(let i=0;i<9;i++)assert.equal((await auth.login(request(),'wrong')).status,401);
    const result=await auth.login(request(),KEY);
    assert.match(result.cookie,/^work_planner_session=/);assert.ok(!result.cookie.includes('Secure'));
  }
});
