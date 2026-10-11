import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../lib/app.mjs';
import {analyze, normalizeState, splitEntry, visibleEntries} from '../public/core.mjs';

const DESCRIPTION='Analyse der Messwerte – Änderungen prüfen\nشرح کار: بررسی داده‌ها و یادداشت‌ها\n  Preserve indentation, <tag> & "quotes", =SUM(A1:A2), and 🧪.';
const row=(id,extra={})=>({id,jobId:'jena',date:'2030-06-12',start:'09:00',end:'11:30',endNextDay:false,tasks:DESCRIPTION,...extra});

// Each fixture exercises the production HTTP handler and real atomic disk store.
// No application data, credentials, calendar feeds, or network services are used.
async function fixture(t){
  const parent=path.resolve(os.tmpdir());
  const dataDir=await fs.mkdtemp(path.join(parent,'planner-description-test-'));
  const apps=new Set();
  t.after(async()=>{
    for(const instance of apps)await instance.close();
    assert.equal(path.dirname(path.resolve(dataDir)),parent);
    await fs.rm(dataDir,{recursive:true,force:true});
  });
  async function start(){
    const app=await createApp({
      config:{mode:'local',cloud:false,accessKeyHash:'',dataDir},
      calendarOptions:{autoSync:false,fetch:()=>{throw Error('Unexpected external request');}},
    });
    const server=http.createServer(app);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=server.address().port,origin=`http://127.0.0.1:${port}`;
    const instance={
      async request(method,body){
        const content=body===undefined?undefined:JSON.stringify(body);
        return new Promise((resolve,reject)=>{
          const req=http.request({hostname:'127.0.0.1',port,path:'/api/state',method,headers:{
            ...(!['GET','HEAD'].includes(method)?{Origin:origin}:{}),
            ...(content===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(content)}),
          }},res=>{
            const chunks=[];res.on('data',chunk=>chunks.push(chunk));
            res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
          });
          req.on('error',reject);req.end(content);
        });
      },
      async close(){if(!apps.delete(instance))return;await new Promise(resolve=>server.close(resolve));await app.close();},
    };
    apps.add(instance);return instance;
  }
  return {start};
}

test('multiline Unicode descriptions survive save, server restart, and backup import on another installation',async t=>{
  const first=await fixture(t),app=await first.start();
  const entries=[row('jena-description'),row('seewiesen-description',{jobId:'seewiesen',date:'2030-06-14',tasks:'Separate job\nDifferent activity'})];
  assert.deepEqual(await app.request('PUT',{revision:0,entries}),{status:200,value:{revision:1}});
  await app.close();
  const restarted=await first.start(),loaded=await restarted.request('GET');
  assert.equal(loaded.status,200);
  assert.deepEqual(loaded.value.entries,entries);
  assert.equal(loaded.value.revision,1);

  // Same serialization/normalization used by the app's backup and import controls.
  const backup=JSON.stringify(normalizeState(loaded.value),null,2);
  const incoming=normalizeState(JSON.parse(backup));
  const second=await fixture(t),importTarget=await second.start();
  assert.equal((await importTarget.request('PUT',{...incoming,revision:0})).status,200);
  assert.deepEqual((await importTarget.request('GET')).value.entries,entries);
  assert.deepEqual((await restarted.request('GET')).value.entries,entries);
});

test('legacy blank descriptions and incomplete drafts remain valid; invalid descriptions cannot replace saved work',async t=>{
  const fixtureState=await fixture(t),app=await fixtureState.start();
  const legacy=row('legacy');delete legacy.tasks;
  const draft=row('draft',{start:'09:',end:'',tasks:'Pending time details\nیادداشت موقت'});
  const limit=row('description-limit',{tasks:'آ'.repeat(2000)});
  assert.equal((await app.request('PUT',{revision:0,entries:[legacy,draft,limit]})).status,200);
  const initial=(await app.request('GET')).value;
  assert.equal(initial.entries[0].tasks,'');
  assert.equal(initial.entries[1].tasks,draft.tasks);
  assert.equal(initial.entries[1].start,'09:');
  assert.equal(initial.entries[2].tasks,limit.tasks);
  for(const invalid of ['x'.repeat(2001),'bad\u0000text',{text:'not a string'}]){
    assert.equal((await app.request('PUT',{revision:1,entries:[row('bad',{tasks:invalid})]})).status,400);
    assert.deepEqual((await app.request('GET')).value,initial);
  }
});

test('time and job edits retain descriptions, and month/overnight projections do not mutate records',async t=>{
  const fixtureState=await fixture(t),app=await fixtureState.start();
  const initial=row('move-me');
  assert.equal((await app.request('PUT',{revision:0,entries:[initial]})).status,200);
  const before=(await app.request('GET')).value;
  const edited={...before.entries[0],jobId:'seewiesen',date:'2030-06-30',start:'23:30',end:'02:00',endNextDay:true};
  assert.equal((await app.request('PUT',{revision:before.revision,entries:[edited]})).status,200);
  const after=(await app.request('GET')).value;
  assert.deepEqual(after.entries,[edited]);
  assert.equal(after.entries[0].tasks,DESCRIPTION);
  const snapshot=JSON.stringify(after);
  const june=splitEntry(after.entries[0],'2030-06'),july=splitEntry(after.entries[0],'2030-07');
  assert.deepEqual(june.map(s=>[s.date,s.duration,s.tasks]),[['2030-06-30',30,DESCRIPTION]]);
  assert.deepEqual(july.map(s=>[s.date,s.duration,s.tasks]),[['2030-07-01',120,DESCRIPTION]]);
  assert.equal(visibleEntries(after.entries,'2030-07')[0].tasks,DESCRIPTION);
  assert.deepEqual(analyze(after.entries,'2030-06').totals,{jena:0,seewiesen:30});
  assert.deepEqual(analyze(after.entries,'2030-07').totals,{jena:0,seewiesen:120});
  assert.equal(JSON.stringify(after),snapshot);
  assert.deepEqual((await app.request('GET')).value,after);
});

test('a stale device cannot overwrite a newer description or its hours',async t=>{
  const fixtureState=await fixture(t),app=await fixtureState.start();
  assert.equal((await app.request('PUT',{revision:0,entries:[row('shared-row')]})).status,200);
  const deviceA=(await app.request('GET')).value,deviceB=(await app.request('GET')).value;
  deviceA.entries[0].tasks+='\nCompleted verification.';
  assert.equal((await app.request('PUT',deviceA)).status,200);
  const saved=(await app.request('GET')).value;
  deviceB.entries[0].end='12:30';
  assert.equal((await app.request('PUT',deviceB)).status,409);
  assert.deepEqual((await app.request('GET')).value,saved);
  assert.equal(saved.entries[0].end,'11:30');
  assert.equal(saved.entries[0].tasks,deviceA.entries[0].tasks);
});
