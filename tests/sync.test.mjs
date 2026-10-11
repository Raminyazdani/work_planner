import test from 'node:test';
import assert from 'node:assert/strict';
import {PlannerSync} from '../public/sync.mjs';

const copy=value=>structuredClone(value);
const row=(id='entry-a',changes={})=>({id,jobId:'jena',date:'2030-06-12',start:'09:00',end:'12:00',endNextDay:false,tasks:'Original activity',...changes});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

// An in-memory revisioned server exercises the real controller without timers,
// network services, credentials, or any of the user's records.
function fixture(initial=[row()],revision=1){
  let editor=copy(initial),server={version:1,entries:copy(initial),revision},hook;
  const statuses=[],rebases=[],calls=[];
  let pending=0,maxPending=0;
  const commit=call=>{
    if(call.method==='GET')return Response.json(copy(server));
    if(call.body.revision!==server.revision)return Response.json({error:'Stale revision'},{status:409});
    server={version:1,entries:copy(call.body.entries),revision:server.revision+1};
    return Response.json({revision:server.revision});
  };
  const sync=new PlannerSync({
    request:async(url,options={})=>{
      assert.equal(url,'/api/state');
      const call={method:options.method||'GET',body:options.body?JSON.parse(options.body):undefined};
      calls.push(call);pending++;maxPending=Math.max(maxPending,pending);
      try{return hook?await hook(call,()=>commit(call)):commit(call);}
      finally{pending--;}
    },
    getEntries:()=>editor,
    setEntries:entries=>{editor=copy(entries);},
    onStatus:status=>statuses.push(copy(status)),
    onRebase:(base,remote)=>rebases.push({base,remote}),
  });
  sync.initialize(copy(server));
  return {
    sync,calls,statuses,rebases,
    get editor(){return editor;},set editor(entries){editor=copy(entries);},
    get server(){return copy(server);},set server(value){server=copy(value);},
    get maxPending(){return maxPending;},
    hook(value){hook=value;},
  };
}

test('an unchanged state needs no save and detached acknowledged data detects later edits',async()=>{
  const f=fixture();
  assert.equal(f.sync.dirty,false);
  assert.equal(await f.sync.save(),true);
  assert.equal(f.calls.length,0);
  f.editor[0].tasks='Changed after initialization';
  assert.equal(f.sync.dirty,true);
  assert.equal(await f.sync.save(),true);
  assert.equal(f.server.entries[0].tasks,'Changed after initialization');
  assert.equal(f.sync.dirty,false);
  f.editor[0].tasks='Changed after acknowledgment';
  assert.equal(f.sync.dirty,true);
});

test('rapid edits, a deletion and an addition during PUT are queued after its exact snapshot',async()=>{
  const f=fixture(),started=deferred(),release=deferred();let first=true;
  f.hook(async(call,commit)=>{if(call.method==='PUT'&&first){first=false;started.resolve();await release.promise;}return commit();});
  f.editor=[row('entry-a',{tasks:'Sent snapshot'}),row('entry-b')];
  const saving=f.sync.save();await started.promise;
  f.editor=[row('entry-b',{start:'13:00',end:'15:30',tasks:'\nشرح فعالیت جدید\nEnglish 🧪'}),row('entry-c',{tasks:'Added while saving'})];
  assert.equal(f.sync.save(),saving);
  assert.equal(f.sync.refresh(),saving);
  release.resolve();assert.equal(await saving,true);
  assert.deepEqual(f.calls.map(call=>call.method),['PUT','PUT']);
  assert.equal(f.calls[0].body.entries[0].tasks,'Sent snapshot');
  assert.deepEqual(f.server.entries,f.editor);
  assert.deepEqual(f.server.entries.map(entry=>entry.id),['entry-b','entry-c']);
  assert.equal(f.server.revision,3);
  assert.equal(f.maxPending,1);
  assert.equal(f.sync.dirty,false);
});

test('stale-tab draft deletion preserves all remotely migrated records and their descriptions',async()=>{
  const draft=row('draft',{start:'',end:'',tasks:''}),f=fixture([draft]);
  const migrated=[row('jena',{tasks:'\nImported description\nشرح فعالیت'}),row('seewiesen',{jobId:'seewiesen',start:'13:00',end:'17:00'})];
  f.server={version:1,entries:[...migrated,draft],revision:2};
  f.editor=[];
  assert.equal(await f.sync.save(),true);
  assert.deepEqual(f.server.entries,migrated);
  assert.deepEqual(f.editor,migrated);
  assert.deepEqual(f.calls.map(call=>call.method),['PUT','GET','PUT']);
  assert.equal(f.sync.conflicts.length,0);
  assert.equal(f.sync.dirty,false);
  assert.deepEqual(f.rebases,[{base:[draft],remote:[...migrated,draft]}]);
});

test('local changes made while a conflict GET is pending are included in the retry',async()=>{
  const f=fixture(),started=deferred(),release=deferred();
  const remote=row('entry-a',{start:'14:00',end:'17:00'});
  f.server={version:1,revision:2,entries:[remote,row('remote-only')]};
  f.editor=[row('entry-a',{tasks:'First local description'})];
  f.hook(async(call,commit)=>{if(call.method==='GET'){started.resolve();await release.promise;}return commit();});
  const saving=f.sync.save();await started.promise;
  f.editor=[row('entry-a',{tasks:'Latest local description\nدقیقاً حفظ شود'}),row('local-only')];
  release.resolve();assert.equal(await saving,true);
  assert.deepEqual(f.server.entries,[{...remote,tasks:'Latest local description\nدقیقاً حفظ شود'},row('remote-only'),row('local-only')]);
  assert.deepEqual(f.editor,f.server.entries);
  assert.equal(f.maxPending,1);
});

test('a lost successful response is recognized before applying subsequent local description edits',async()=>{
  const f=fixture(),committed=deferred(),release=deferred();let fail=true;
  f.hook(async(call,commit)=>{
    const response=commit();
    if(call.method==='PUT'&&fail){fail=false;committed.resolve();await release.promise;throw Error('Connection lost after commit');}
    return response;
  });
  f.editor=[row('entry-a',{tasks:'Successfully sent, no acknowledgment'})];
  const saving=f.sync.save();await committed.promise;
  f.editor=[row('entry-a',{tasks:'More typing after send\n研究・شرح کار'}),row('new-after-send')];
  release.resolve();assert.equal(await saving,false);
  assert.equal(f.statuses.at(-1).state,'retry');
  assert.equal(f.sync.dirty,true);
  assert.equal(await f.sync.save(),true);
  assert.deepEqual(f.calls.map(call=>call.method),['PUT','GET','PUT']);
  assert.deepEqual(f.server.entries,f.editor);
  assert.equal(f.server.entries[0].tasks,'More typing after send\n研究・شرح کار');
  assert.equal(f.sync.conflicts.length,0);
});

test('lost successful response with no further edits is reconciled without an extra write',async()=>{
  const f=fixture();let fail=true;
  f.hook((call,commit)=>{const response=commit();if(call.method==='PUT'&&fail){fail=false;throw Error('Lost ack');}return response;});
  f.editor=[row('entry-a',{tasks:'Already stored'})];
  assert.equal(await f.sync.save(),false);
  assert.equal(await f.sync.save(),true);
  assert.deepEqual(f.calls.map(call=>call.method),['PUT','GET']);
  assert.equal(f.server.revision,2);
  assert.equal(f.sync.dirty,false);
});

test('undoing a deletion after its lost acknowledgment restores the intended record',async()=>{
  const original=row(),f=fixture([original]);let fail=true;
  f.hook((call,commit)=>{const response=commit();if(call.method==='PUT'&&fail){fail=false;throw Error('Lost ack');}return response;});
  f.editor=[];assert.equal(await f.sync.save(),false);
  assert.deepEqual(f.server.entries,[]);
  f.editor=[original];assert.equal(await f.sync.save(),true);
  assert.deepEqual(f.server.entries,[original]);
  assert.equal(f.sync.conflicts.length,0);
});

test('a disconnected request retains work and retries without changing the server first',async()=>{
  const f=fixture();let offline=true;
  f.hook((call,commit)=>{if(offline)throw Error('Offline');return commit();});
  f.editor=[row('entry-a',{tasks:'Offline draft\nشرح فعالیت'})];
  assert.equal(await f.sync.save(),false);
  assert.equal(f.server.revision,1);
  assert.equal(f.sync.dirty,true);
  assert.equal(f.statuses.at(-1).state,'retry');
  offline=false;
  assert.equal(await f.sync.save(),true);
  assert.deepEqual(f.server.entries,f.editor);
  assert.equal(f.server.revision,2);
});

test('authentication expiry pauses saving without retry loops or lost edits and resumes after login',async()=>{
  const f=fixture();let authenticated=false;
  f.hook((call,commit)=>{if(!authenticated){const error=Error('Login required');error.authRequired=true;throw error;}return commit();});
  f.editor=[row('entry-a',{tasks:'Unsaved during login'})];
  assert.equal(await f.sync.save(),false);
  assert.equal(f.calls.length,1);
  assert.equal(f.statuses.at(-1).state,'error');
  assert.equal(f.sync.dirty,true);
  assert.equal(f.server.revision,1);
  authenticated=true;
  assert.equal(await f.sync.save(),true);
  assert.equal(f.server.entries[0].tasks,'Unsaved during login');
  assert.equal(f.sync.dirty,false);
});

test('independent remote changes arrive through refresh and never create redundant writes',async()=>{
  const f=fixture(),remote=[row('entry-a',{tasks:'Updated elsewhere'}),row('new-remote')];
  f.server={version:1,revision:2,entries:remote};
  assert.equal(await f.sync.refresh(),true);
  assert.deepEqual(f.editor,remote);
  assert.deepEqual(f.calls.map(call=>call.method),['GET']);
  assert.equal(f.sync.revision,2);
  assert.equal(f.sync.dirty,false);
});

test('an intentional import removes known rows but preserves additions made by another device',async()=>{
  const f=fixture([row('known-a'),row('known-b')]);
  f.server={version:1,revision:2,entries:[...f.server.entries,row('unseen-remote')]};
  f.editor=[row('imported',{tasks:'Imported backup description'})];
  assert.equal(await f.sync.save(),true);
  assert.deepEqual(f.server.entries,[row('unseen-remote'),row('imported',{tasks:'Imported backup description'})]);
});

test('conflicting descriptions pause until explicit choice; choosing local keeps later typing',async()=>{
  const f=fixture();
  f.server={version:1,revision:2,entries:[row('entry-a',{tasks:'Other device description'}),row('remote-only')]};
  f.editor=[row('entry-a',{tasks:'My description'})];
  assert.equal(await f.sync.save(),false);
  assert.equal(f.statuses.at(-1).state,'conflict');
  assert.equal(f.sync.conflicts.length,1);
  assert.equal(f.sync.conflicts[0].id,'entry-a');
  assert.equal(f.server.revision,2);
  const calls=f.calls.length;
  assert.equal(await f.sync.save(),false);
  assert.equal(f.calls.length,calls);
  f.editor[0].tasks='My latest description';
  f.sync.resolve('entry-a','local');
  assert.equal(await f.sync.save(),true);
  assert.deepEqual(f.server.entries,[row('entry-a',{tasks:'My latest description'}),row('remote-only')]);
});

test('choosing the remote record resolves edits without an unnecessary write',async()=>{
  const f=fixture(),remote=row('entry-a',{tasks:'Keep remote version'});
  f.server={version:1,revision:2,entries:[remote]};
  f.editor=[row('entry-a',{tasks:'Local version'})];
  assert.equal(await f.sync.save(),false);
  f.sync.resolve('entry-a','remote');
  assert.equal(await f.sync.save(),true);
  assert.deepEqual(f.editor,[remote]);
  assert.equal(f.server.revision,2);
  assert.deepEqual(f.calls.map(call=>call.method),['PUT','GET']);
});

test('delete versus edit choices preserve the selected side in both directions',async()=>{
  const localDelete=fixture(),remote=row('entry-a',{tasks:'Remote edit before delete'});
  localDelete.server={version:1,revision:2,entries:[remote]};localDelete.editor=[];
  assert.equal(await localDelete.sync.save(),false);
  assert.equal(localDelete.sync.conflicts[0].kind,'delete-edit');
  localDelete.sync.resolve('entry-a','remote');assert.equal(await localDelete.sync.save(),true);
  assert.deepEqual(localDelete.server.entries,[remote]);
  assert.deepEqual(localDelete.editor,[remote]);

  const remoteDelete=fixture();remoteDelete.server={version:1,revision:2,entries:[]};
  remoteDelete.editor=[row('entry-a',{tasks:'My edit while deleted remotely'})];
  assert.equal(await remoteDelete.sync.save(),false);
  assert.equal(remoteDelete.sync.conflicts[0].kind,'edit-delete');
  remoteDelete.sync.resolve('entry-a','local');assert.equal(await remoteDelete.sync.save(),true);
  assert.deepEqual(remoteDelete.server.entries,remoteDelete.editor);
  assert.equal(remoteDelete.server.entries[0].tasks,'My edit while deleted remotely');
});

test('concurrent time edits are not combined into an unintended interval',async()=>{
  const f=fixture();
  f.server={version:1,revision:2,entries:[row('entry-a',{end:'14:00'})]};
  f.editor=[row('entry-a',{start:'08:00'})];
  assert.equal(await f.sync.save(),false);
  assert.deepEqual(f.sync.conflicts[0].fields,['time']);
  assert.equal(f.server.entries[0].start,'09:00');
  assert.equal(f.editor[0].end,'12:00');
});

test('continuous concurrent writers yield after a bounded retry chain and retain pending work',async()=>{
  const f=fixture();let remoteCounter=0;
  f.hook((call,commit)=>{
    if(call.method==='PUT'){
      const server=f.server;server.entries.push(row('remote-'+(++remoteCounter)));server.revision++;f.server=server;
    }
    return commit();
  });
  f.editor.push(row('pending-local'));
  assert.equal(await f.sync.save(),false);
  assert.equal(f.calls.filter(call=>call.method==='PUT').length,8);
  assert.equal(f.statuses.at(-1).state,'retry');
  assert.equal(f.sync.dirty,true);
  assert.ok(f.editor.some(entry=>entry.id==='pending-local'));
  assert.equal(f.maxPending,1);
  f.hook(undefined);assert.equal(await f.sync.save(),true);
  assert.deepEqual(f.server.entries,f.editor);
});

test('invalid server state cannot replace local work or advance the acknowledged revision',async()=>{
  const f=fixture();
  f.hook(()=>Response.json({version:1,revision:2,entries:[row('unsafe',{tasks:'bad\u0000text'})]}));
  assert.equal(await f.sync.refresh(),false);
  assert.deepEqual(f.editor,[row()]);
  assert.equal(f.sync.revision,1);
});
