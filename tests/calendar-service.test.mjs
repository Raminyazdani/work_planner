import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../lib/store.mjs';
import {parseCalendar,validateFeedUrl,createCalendarService} from '../calendar-service.mjs';

const feed={id:'test',calendarId:'owner@example.com',name:'Test calendar'};
const wrap=events=>`BEGIN:VCALENDAR\nVERSION:2.0\nX-WR-TIMEZONE:Europe/Berlin\n${events}\nEND:VCALENDAR`;
const event=lines=>`BEGIN:VEVENT\n${lines}\nEND:VEVENT`;
const simple=wrap(event('UID:one\nDTSTART:20260903T080000Z\nDTEND:20260903T093000Z\nSUMMARY:Meeting'));
const url='https://calendar.google.com/calendar/ical/owner%40example.com/private-testsecret/basic.ics';

test('only canonical Google calendar feed URLs are accepted; credentials, redirects and query endpoints cannot enter settings',()=>{
  assert.equal(validateFeedUrl(url).calendarId,'owner@example.com');
  assert.equal(validateFeedUrl('https://calendar.google.com/calendar/ical/example/public/basic.ics').calendarId,'example');
  for(const x of ['http://calendar.google.com/calendar/ical/example/public/basic.ics','https://calendar.google.com.evil.test/calendar/ical/example/public/basic.ics','https://localhost/calendar/ical/example/public/basic.ics',url+'?redirect=evil',url+'#secret',url.replace('https://','https://user:pass@'),url.replace('.com/','.com:8765/')]) assert.throws(()=>validateFeedUrl(x));
});

test('recurrences use Berlin timezone and DST even without a VTIMEZONE; EXDATE and moved/cancelled exceptions work',()=>{
  const ics=wrap([
    event('UID:repeat\nDTSTART;TZID=Europe/Berlin:20261023T100000\nDTEND;TZID=Europe/Berlin:20261023T110000\nRRULE:FREQ=DAILY;COUNT=6\nEXDATE;TZID=Europe/Berlin:20261024T100000\nSUMMARY:Regular'),
    event('UID:repeat\nRECURRENCE-ID;TZID=Europe/Berlin:20261026T100000\nDTSTART;TZID=Europe/Berlin:20261026T140000\nDTEND;TZID=Europe/Berlin:20261026T150000\nSUMMARY:Moved'),
    event('UID:repeat\nRECURRENCE-ID;TZID=Europe/Berlin:20261027T100000\nSTATUS:CANCELLED')
  ].join('\n'));
  const result=parseCalendar(ics,feed,'2026-10');
  assert.deepEqual(result.map(e=>[e.title,e.start]),[
    ['Regular','2026-10-23T08:00:00.000Z'],['Regular','2026-10-25T09:00:00.000Z'],
    ['Moved','2026-10-26T13:00:00.000Z'],['Regular','2026-10-28T09:00:00.000Z']
  ]);
});

test('exceptions stay related to their own UID, and a moved occurrence enters another month',()=>{
  const result=parseCalendar(wrap([
    event('UID:a\nDTSTART:20260801T100000Z\nDTEND:20260801T110000Z\nRRULE:FREQ=DAILY;COUNT=2\nSUMMARY:A'),
    event('UID:a\nRECURRENCE-ID:20260802T100000Z\nDTSTART:20260915T100000Z\nDTEND:20260915T110000Z\nSUMMARY:Moved A'),
    event('UID:b\nDTSTART:20260915T100000Z\nDTEND:20260915T110000Z\nRRULE:FREQ=DAILY;COUNT=2\nSUMMARY:B'),
  ].join('\n')),feed,'2026-09');
  assert.deepEqual(result.map(e=>e.title).sort(),['B','B','Moved A']);
});

test('feed-provided VTIMEZONE components control recurring offsets',()=>{
  const zone=`BEGIN:VTIMEZONE\nTZID:CustomBerlin\nBEGIN:DAYLIGHT\nDTSTART:19700329T020000\nTZOFFSETFROM:+0100\nTZOFFSETTO:+0200\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\nEND:DAYLIGHT\nBEGIN:STANDARD\nDTSTART:19701025T030000\nTZOFFSETFROM:+0200\nTZOFFSETTO:+0100\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\nEND:STANDARD\nEND:VTIMEZONE`;
  const result=parseCalendar(wrap(zone+'\n'+event('UID:zoned\nDTSTART;TZID=CustomBerlin:20261022T100000\nDTEND;TZID=CustomBerlin:20261022T110000\nRRULE:FREQ=WEEKLY;COUNT=2')),feed,'2026-10');
  assert.deepEqual(result.map(e=>e.start),['2026-10-22T08:00:00.000Z','2026-10-29T09:00:00.000Z']);
});

test('all-day DTEND stays exclusive; transparent or self-declined meetings do not block work; cancelled series absent',()=>{
  const result=parseCalendar(wrap([
    event('UID:day\nDTSTART;VALUE=DATE:20260903\nDTEND;VALUE=DATE:20260905\nSUMMARY:Days\nTRANSP:TRANSPARENT'),
    event('UID:declined\nDTSTART:20260903T080000Z\nDTEND:20260903T090000Z\nATTENDEE;PARTSTAT=DECLINED:mailto:owner@example.com'),
    event('UID:cancelled\nDTSTART:20260903T080000Z\nDTEND:20260903T090000Z\nSTATUS:CANCELLED'),
  ].join('\n')),feed,'2026-09');
  assert.equal(result.length,2);
  const day=result.find(e=>e.allDay);assert.equal(day.start,'2026-09-03');assert.equal(day.end,'2026-09-05');assert.equal(day.busy,false);
  assert.equal(result.find(e=>!e.allDay).busy,false);
});

test('persisted caches survive offline, snapshot coverage is explicit, and secret URLs never appear in responses or errors',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'planner-calendar-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=await createStore({dataDir:root});
  await store.write('calendar-snapshot',{version:1,fetchedAt:'2026-10-08T10:00:00Z',months:['2026-09'],events:[{id:'seed',calendarId:feed.calendarId,calendarName:'Google',title:'Snapshot',start:'2026-09-02T10:00:00Z',end:'2026-09-02T11:00:00Z',allDay:false,busy:true}]},null);
  let online=true, requests=0;
  const options={poll:false,autoSync:false,settingsDir:path.join(root,'private'),fetch:async(input,config)=>{requests++;assert.equal(config.redirect,'error');if(!online)throw new Error('fetch '+url);return new Response(simple);}};
  let service=await createCalendarService(store,options);t.after(()=>service.close());
  let value=await service.getMonth('2026-09');assert.equal(value.events[0].title,'Snapshot');assert.equal(value.status.source,'snapshot');assert.equal(value.status.snapshotCoversMonth,true);
  assert.equal((await service.getMonth('2026-08')).status.snapshotCoversMonth,false);
  await service.configure({add:{url,name:'Google'}});await service.sync('2026-09');
  value=await service.getMonth('2026-09');assert.equal(value.events.length,1);assert.equal(value.events[0].title,'Meeting');assert.equal(value.status.autoSync,true);assert.equal(value.coverage.feeds.length,1);
  assert.ok(!JSON.stringify(value).includes('testsecret'));assert.ok(!JSON.stringify(value).includes('https://'));
  assert.ok((await store.read('calendar-settings')).value.feeds[0].url.includes('testsecret'));
  online=false;await service.sync('2026-09');value=await service.getMonth('2026-09');
  assert.equal(value.events[0].title,'Meeting');assert.ok(value.status.feeds[0].error);assert.ok(!JSON.stringify(value).includes('testsecret'));
  service.close();service=await createCalendarService(store,options);assert.equal((await service.getMonth('2026-09')).events[0].title,'Meeting');
  const feedId=service.status().feeds[0].id;await service.configure({remove:feedId});
  assert.equal((await service.getMonth('2026-09')).events[0].title,'Snapshot');assert.equal(service.status().autoSync,false);assert.equal(requests,2);
});

test('uncached and stale GETs await a refresh; concurrent GETs share one sync and failures are throttled',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'planner-calendar-auto-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=await createStore({dataDir:root});
  let requests=0,clock=Date.parse('2026-10-08T10:00:00Z'),online=true;
  const service=await createCalendarService(store,{now:()=>clock,fetch:async()=>{requests++;await new Promise(r=>setTimeout(r,10));if(!online)throw new Error('offline');return new Response(simple);}});t.after(()=>service.close());
  await service.configure({add:{url,name:'Google'}});
  const initial=await Promise.all(Array.from({length:8},()=>service.getMonth('2026-09')));
  assert.equal(requests,1);for(const result of initial){assert.equal(result.events.length,1);assert.ok(result.status.lastSynced);}
  await service.getMonth('2026-09');assert.equal(requests,1);
  clock+=60000;await service.getMonth('2026-09');assert.equal(requests,2);
  online=false;clock+=60000;
  const offline=await service.getMonth('2026-09');assert.equal(offline.events.length,1);assert.ok(offline.status.feeds[0].error);
  await service.getMonth('2026-09');assert.equal(requests,3);
  const next=await service.getMonth('2026-10');assert.equal(next.status.lastSynced,null);assert.equal(next.coverage.feeds.length,0);assert.equal(requests,4);
});

test('mixed coverage keeps empty primary snapshot distinct from a live secondary feed; removing last feed disables polling',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'planner-calendar-mixed-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=await createStore({dataDir:root});
  await store.write('calendar-snapshot',{version:1,fetchedAt:'2026-10-08T10:00:00Z',months:['2026-09'],calendars:[{id:'OWNER@example.com',name:'Primary'}],events:[]},null);
  const service=await createCalendarService(store,{poll:false,autoSync:false,settingsDir:path.join(root,'private'),fetch:async()=>new Response(wrap(''))});t.after(()=>service.close());
  await service.configure({add:{url:url.replace('owner%40example.com','secondary%40example.com'),name:'Secondary'}});await service.sync('2026-09');
  let value=await service.getMonth('2026-09');
  assert.deepEqual(value.coverage.snapshotCalendars,['OWNER@example.com']);assert.deepEqual(value.coverage.feedCalendars,['secondary@example.com']);assert.equal(value.status.autoSync,true);
  assert.deepEqual((await service.getMonth('2026-08')).coverage.snapshotCalendars,[]);
  await service.configure({add:{url,name:'Primary'}});await service.sync('2026-09');value=await service.getMonth('2026-09');
  assert.deepEqual(value.coverage.snapshotCalendars,[]);assert.equal(value.coverage.feedCalendars.length,2);
  for(const f of service.status().feeds)await service.configure({remove:f.id});
  value=await service.getMonth('2026-09');assert.deepEqual(value.coverage.snapshotCalendars,['OWNER@example.com']);assert.deepEqual(value.coverage.feedCalendars,[]);assert.equal(value.status.autoSync,false);
});


test('a syncing instance cannot overwrite concurrent feed configuration or expose events from a replaced URL',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'planner-calendar-race-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=await createStore({dataDir:root});
  let finish,started;
  const pending=new Promise(r=>finish=r),ready=new Promise(r=>started=r);
  const syncing=await createCalendarService(store,{autoSync:false,fetch:async()=>{started();await pending;return new Response(simple);}});
  const editing=await createCalendarService(await createStore({dataDir:root}),{autoSync:false});
  t.after(()=>Promise.all([syncing.close(),editing.close()]));
  await syncing.configure({add:{url,name:'Before'}});
  const operation=syncing.sync('2026-09');await ready;
  const replaced=url.replace('private-testsecret','private-replacement');
  await editing.configure({add:{url:replaced,name:'After'}});
  finish();await operation;
  const settings=(await store.read('calendar-settings')).value;
  assert.equal(settings.feeds[0].name,'After');assert.equal(settings.feeds[0].url,replaced);
  const result=await syncing.getMonth('2026-09');assert.equal(result.events.length,0);assert.equal(result.status.feeds[0].name,'After');
  assert.ok(!JSON.stringify(result).includes('replacement'));
});

test('sync never resurrects a removed feed, and corruption is not treated as an empty calendar',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'planner-calendar-remove-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=await createStore({dataDir:root});
  let finish,started;
  const pending=new Promise(r=>finish=r),ready=new Promise(r=>started=r);
  const service=await createCalendarService(store,{autoSync:false,fetch:async()=>{started();await pending;return new Response(simple);}});
  const editing=await createCalendarService(store,{autoSync:false});
  t.after(()=>Promise.all([service.close(),editing.close()]));
  await service.configure({add:{url,name:'Test'}});
  const id=service.status().feeds[0].id,operation=service.sync('2026-09');await ready;
  await editing.configure({remove:id});finish();await operation;
  const result=await service.getMonth('2026-09');assert.equal(result.status.feeds.length,0);assert.equal(result.events.length,0);
  await fs.writeFile(path.join(root,'calendar-settings.json'),'broken {');
  await assert.rejects(service.getMonth('2026-09'),/unreadable/);
  assert.equal(await fs.readFile(path.join(root,'calendar-settings.json'),'utf8'),'broken {');
});
