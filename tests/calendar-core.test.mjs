import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarSegments,analyzeCalendar} from '../public/calendar-core.mjs';

const work=(id,date,start,end,extra={})=>({id,jobId:'jena',date,start,end,endNextDay:false,...extra});
const event=(id,start,end,extra={})=>({id,calendarId:'primary',calendarName:'Personal',title:id,start,end,allDay:false,busy:true,...extra});

test('September 10: two adjacent calendar events produce two pairs and 60 conflict minutes',()=>{
  const events=[event('first','2026-09-10T18:30:00+02:00','2026-09-10T19:00:00+02:00'),event('second','2026-09-10T19:00:00+02:00','2026-09-10T19:30:00+02:00')];
  const result=analyzeCalendar([work('shift','2026-09-10','18:00','21:00')],events,'2026-09');
  assert.equal(result.pairs.length,2);assert.equal(result.conflictMinutes,60);
  assert.equal(result.byEntryId.get('shift').length,2);assert.deepEqual([...result.eventIds],['first','second']);
  assert.deepEqual(result.pairs.map(p=>[p.date,p.startMinute,p.endMinute,p.minutes]),[['2026-09-10',1110,1140,30],['2026-09-10',1140,1170,30]]);
});

test('calendar overlaps and overlapping work rows count their union once',()=>{
  const events=[event('a','2026-09-10T10:00:00+02:00','2026-09-10T12:00:00+02:00'),event('b','2026-09-10T11:00:00+02:00','2026-09-10T13:00:00+02:00')];
  const result=analyzeCalendar([work('x','2026-09-10','09:00','14:00'),work('y','2026-09-10','11:30','12:30')],events,'2026-09');
  assert.equal(result.pairs.length,4);assert.equal(result.conflictMinutes,180);
});

test('Berlin conversion honors summer, winter, and explicit event offsets',()=>{
  const events=[event('summer','2026-10-24T12:00:00Z','2026-10-24T13:00:00Z'),event('winter','2026-10-26T12:00:00Z','2026-10-26T13:00:00Z'),event('other-zone','2026-10-26T08:00:00-04:00','2026-10-26T09:00:00-04:00')];
  assert.deepEqual(calendarSegments(events,'2026-10').map(s=>[s.id,s.start,s.end]),[['summer',840,900],['other-zone',780,840],['winter',780,840]]);
});

test('autumn repeated-hour event is not lost or counted twice',()=>{
  const events=[event('fold','2026-10-25T02:30:00+02:00','2026-10-25T02:30:00+01:00')];
  const segments=calendarSegments(events,'2026-10');
  assert.deepEqual(segments.map(s=>[s.date,s.start,s.end,s.duration,s.dstAdjusted]),[['2026-10-25',120,180,60,true]]);
  assert.ok(segments[0].dstNote);assert.equal(analyzeCalendar([work('x','2026-10-25','02:00','03:00')],events,'2026-10').conflictMinutes,60);
});

test('spring transition leaves nonexistent local-clock minutes empty',()=>{
  const events=[event('gap','2026-03-29T01:30:00+01:00','2026-03-29T03:30:00+02:00')];
  assert.deepEqual(calendarSegments(events,'2026-03').map(s=>[s.start,s.end,s.duration,s.dstAdjusted]),[[90,120,30,true],[180,210,30,true]]);
  assert.equal(analyzeCalendar([work('x','2026-03-29','01:00','04:00')],events,'2026-03').conflictMinutes,60);
});

test('midnight and month clipping compare on the correct following day',()=>{
  const events=[event('night','2026-08-31T23:30:00+02:00','2026-09-01T00:30:00+02:00')];
  assert.deepEqual(calendarSegments(events,'2026-09').map(s=>[s.date,s.start,s.end]),[['2026-09-01',0,30]]);
  const rows=[work('x','2026-08-31','23:45','00:15',{endNextDay:true})];
  assert.equal(analyzeCalendar(rows,events,'2026-09').conflictMinutes,15);
  assert.equal(analyzeCalendar(rows,events,'2026-08').conflictMinutes,15);
});

test('all-day end is exclusive, month clipping is correct, and busy all-day events intersect',()=>{
  const events=[event('trip','2026-08-31','2026-09-03',{allDay:true})];
  assert.deepEqual(calendarSegments(events,'2026-09').map(s=>[s.date,s.start,s.end]),[['2026-09-01',0,1440],['2026-09-02',0,1440]]);
  assert.equal(analyzeCalendar([work('x','2026-09-02','09:00','10:00'),work('y','2026-09-03','09:00','10:00')],events,'2026-09').conflictMinutes,60);
});

test('free, transparent, cancelled, and declined events remain visible but never conflict',()=>{
  const flags=[{busy:false},{transparency:'transparent'},{status:'cancelled'},{status:'declined'},{responseStatus:'declined'},{selfResponseStatus:'declined'},{declined:true}];
  const events=flags.map((flag,i)=>event(String(i),'2026-09-10T09:00:00+02:00','2026-09-10T10:00:00+02:00',flag));
  const result=analyzeCalendar([work('x','2026-09-10','09:00','10:00')],events,'2026-09');
  assert.equal(result.segments.length,flags.length);assert.ok(result.segments.every(s=>s.free&&!s.busy));assert.equal(result.pairs.length,0);
});

test('touching calendar and work boundaries do not overlap',()=>{
  const events=[event('a','2026-09-10T08:00:00+02:00','2026-09-10T09:00:00+02:00'),event('b','2026-09-10T10:00:00+02:00','2026-09-10T11:00:00+02:00')];
  assert.equal(analyzeCalendar([work('x','2026-09-10','09:00','10:00')],events,'2026-09').conflictMinutes,0);
});

test('invalid events are excluded with diagnostics, not coerced into local machine timezone',()=>{
  const events=[null,event('no-zone','2026-09-10T09:00:00','2026-09-10T10:00:00'),event('bad-date','2026-02-30T09:00:00Z','2026-03-03T10:00:00Z'),event('reversed','2026-09-10T10:00:00Z','2026-09-10T09:00:00Z'),event('empty','2026-09-10','2026-09-10',{allDay:true})];
  const result=analyzeCalendar([],events,'2026-09');assert.equal(result.invalid.length,5);assert.equal(result.segments.length,0);
});

test('events from different calendars retain their source and literal title',()=>{
  const events=[event('same','2026-09-10T09:00:00Z','2026-09-10T10:00:00Z',{title:'<script>literal</script>',calendarId:'a',url:'https://calendar.google.com/'}),event('same','2026-09-10T09:00:00Z','2026-09-10T10:00:00Z',{calendarId:'b'})];
  const result=analyzeCalendar([work('x','2026-09-10','11:00','12:00')],events,'2026-09');
  assert.equal(result.pairs.length,2);assert.equal(result.eventKeys.size,2);assert.equal(result.conflictMinutes,60);assert.equal(result.pairs[0].title,'<script>literal</script>');
});
