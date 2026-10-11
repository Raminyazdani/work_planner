import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeState,interval} from '../public/core.mjs';
import {sessionInfo,login} from '../public/session.mjs';

const entry=overrides=>({id:'test-entry',jobId:'jena',date:'2030-06-12',start:'09:00',end:'11:30',endNextDay:false,tasks:'',...overrides});
const state=overrides=>({entries:[entry(overrides)]});

test('import rejects malformed or impossible dates and attribute injection',()=>{
  for(const date of ['2030-02-30','2030-06-12" autofocus onfocus="alert(1)','<img src=x onerror=alert(1)>',[],{},42,null]){
    assert.throws(()=>normalizeState(state({date})),undefined,JSON.stringify(date));
  }
  assert.equal(normalizeState(state({date:''})).entries[0].date,'');
});

test('import rejects coercible types, unsafe times, duplicate IDs and malformed flags',()=>{
  for(const overrides of [{tasks:{}},{tasks:['a']},{tasks:'\u0000'},{start:'<img>'},{start:'09\n00'},{end:123},{endNextDay:'false'},{id:'bad"id'},{jobId:'unknown'}])assert.throws(()=>normalizeState(state(overrides)));
  assert.throws(()=>normalizeState({entries:[entry({}),entry({})]}));
});

test('incomplete clock drafts survive normalization but cannot enter totals',()=>{
  for(const start of ['', '1','13:', '13:4']){
    const value=normalizeState(state({start}));
    assert.equal(value.entries[0].start,start);
    assert.ok(interval(value.entries[0]).error);
  }
});

test('normalization preserves ordinary text and drops unknown/private fields',()=>{
  const result=normalizeState({...state({tasks:'شرح کار\n<not executable>',privateToken:'discard'}),privateToken:'discard'});
  assert.deepEqual(Object.keys(result),['version','entries']);
  assert.equal(result.entries[0].tasks,'شرح کار\n<not executable>');
  assert.equal(result.entries[0].privateToken,undefined);
  assert.equal(interval(result.entries[0]).duration,150);
});

test('session requests are same-origin and never cache authentication state',async t=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return Response.json({authenticated:true,mode:'cloud',authRequired:true});});
  assert.equal((await sessionInfo()).mode,'cloud');
  assert.equal(calls[0].url,'/api/session');
  assert.equal(calls[0].options.cache,'no-store');
  assert.equal(calls[0].options.credentials,'same-origin');
});

test('login puts access key only in POST JSON and then verifies session',async t=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return Response.json(url==='/api/session'?{authenticated:true,mode:'cloud',authRequired:true}:{ok:true});});
  assert.equal((await login('example-test-key')).authenticated,true);
  assert.equal(calls[0].url,'/api/login');
  assert.equal(calls[0].options.method,'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body),{accessKey:'example-test-key'});
  assert.equal(calls[0].options.cache,'no-store');
  assert.equal(calls[1].url,'/api/session');
});

test('failed login returns a safe message, not server response contents',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:'internal details must not display'},{status:401}));
  await assert.rejects(login('invalid'),{message:'کلید دسترسی درست نیست.'});
});

test('malformed session data fails closed',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({authenticated:'yes',mode:'cloud',authRequired:false}));
  await assert.rejects(sessionInfo());
});
