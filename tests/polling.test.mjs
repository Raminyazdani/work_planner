import test from 'node:test';
import assert from 'node:assert/strict';
import {RefreshBudget,watchRefresh} from '../public/polling.mjs';
import {responseError,sessionInfo,login} from '../public/session.mjs';

function fixture(interval=300000,cloud=true){
  let time=0,visible=true,calls=0;
  const budget=new RefreshBudget({interval:()=>interval,cloud:()=>cloud,visible:()=>visible,now:()=>time});
  return {budget,run:options=>budget.run(()=>{calls++;return true;},options),get calls(){return calls;},at(value,active=true){time=value;if(active)budget.touch();},hidden(value){visible=!value;}};
}

test('active cloud polling makes at most twelve automatic reads per hour',async()=>{
  const f=fixture();f.budget.attempted();
  for(let time=15000;time<=3600000;time+=15000){f.at(time);await f.run();}
  assert.equal(f.calls,12);
});

test('cloud calendar polling makes at most four automatic reads per hour',async()=>{
  const f=fixture(900000);f.budget.attempted();
  for(let time=15000;time<=3600000;time+=15000){f.at(time);await f.run();}
  assert.equal(f.calls,4);
});

test('focus, visibility and online bursts share a sixty-second attempt throttle',async()=>{
  const f=fixture();await f.run();
  for(let time=1;time<60000;time+=500){f.at(time);for(const reason of ['focus','online','resume'])await f.run({reason});}
  assert.equal(f.calls,1);
  f.at(60000);await f.run({reason:'focus'});assert.equal(f.calls,2);
});

test('hidden and idle cloud tabs stop reading, then resume once on interaction',async()=>{
  const f=fixture();await f.run();
  f.at(300001,false);await f.run();assert.equal(f.calls,1);
  assert.equal(f.budget.touch(),true);await f.run({reason:'resume'});assert.equal(f.calls,2);
  f.hidden(true);f.at(900000);await f.run({reason:'focus'});assert.equal(f.calls,2);
  f.hidden(false);f.budget.touch();await f.run({reason:'focus'});assert.equal(f.calls,3);
});

test('pending automatic and manual refreshes are deduplicated; explicit refresh bypasses intervals',async()=>{
  const f=fixture();let release,calls=0;
  const first=f.budget.run(()=>{calls++;return new Promise(resolve=>{release=resolve;});});
  const duplicate=f.budget.run(()=>{calls++;},{manual:true});assert.equal(duplicate,first);
  await Promise.resolve();assert.equal(calls,1);release();await first;
  await f.run({manual:true});assert.equal(f.calls,1);
});

test('retry delays survive focus and polling; local reads keep their thirty-second cadence',async()=>{
  const f=fixture();await f.run();f.budget.defer(600000);
  for(const time of [60000,300000,599999]){f.at(time);await f.run({reason:'retry'});await f.run({reason:'focus'});}
  assert.equal(f.calls,1);f.at(600000);await f.run({reason:'retry'});assert.equal(f.calls,2);
  const local=fixture(30000,false);await local.run();local.at(30000,false);await local.run();assert.equal(local.calls,2);
});

test('restoring a cached page retains refresh listeners; a real unload cleans them up',()=>{
  const f=fixture(),doc=new EventTarget(),win=new EventTarget(),reasons=[];doc.hidden=false;
  const stop=watchRefresh(f.budget,reason=>reasons.push(reason),{document:doc,window:win});
  try{
    win.dispatchEvent(Object.assign(new Event('pagehide'),{persisted:true}));
    win.dispatchEvent(Object.assign(new Event('pageshow'),{persisted:true}));
    win.dispatchEvent(new Event('focus'));assert.deepEqual(reasons,['focus','focus']);
    win.dispatchEvent(Object.assign(new Event('pagehide'),{persisted:false}));
    win.dispatchEvent(new Event('focus'));assert.equal(reasons.length,2);
  }finally{stop();}
});

test('storage errors preserve the safe message and respect seconds or HTTP-date Retry-After',async()=>{
  const blocked=seconds=>Response.json({code:'STORAGE_UNAVAILABLE',error:'فضای ذخیره‌سازی موقتاً در دسترس نیست.'},{status:503,headers:{'Retry-After':seconds}});
  assert.equal((await responseError(blocked('1'),'fallback')).retryAfterMs,300000);
  const error=await responseError(blocked('900'),'fallback');
  assert.equal(error.message,'فضای ذخیره‌سازی موقتاً در دسترس نیست.');assert.equal(error.code,'STORAGE_UNAVAILABLE');assert.equal(error.retryable,true);assert.equal(error.retryAfterMs,900000);
  const later=new Date(Date.now()+600000).toUTCString();assert.ok((await responseError(blocked(later),'fallback')).retryAfterMs>=599000);
});

test('login and session surface storage unavailability without treating it as an invalid key',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({code:'STORAGE_UNAVAILABLE',error:'فضای ذخیره‌سازی در دسترس نیست.'},{status:503,headers:{'Retry-After':'600'}}));
  for(const call of [sessionInfo,()=>login('test-only-key')])await assert.rejects(call,{code:'STORAGE_UNAVAILABLE',message:'فضای ذخیره‌سازی در دسترس نیست.',retryAfterMs:600000});
});
