import {randomUUID, createHash} from 'node:crypto';
import ICAL from './vendor/ical-2.2.1.mjs';

const DAY = 86400000, MAX_BYTES = 12 * 1024 * 1024, POLL_MS = 60000;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const cut = (value, n = 500) => String(value ?? '').slice(0, n);
function validMonth(month) { if (!MONTH.test(month)) throw new Error('ماه تقویم معتبر نیست.'); return month; }
function bounds(month) {
  validMonth(month);
  const [y,m] = month.split('-').map(Number);
  // Extra days include intervals crossing midnight and UTC/local month boundaries.
  return {start: Date.UTC(y,m-1,1)-DAY, end: Date.UTC(y,m,1)+DAY};
}
export function validateFeedUrl(value) {
  let u; try { u = new URL(value); } catch { throw new Error('نشانی iCal معتبر نیست.'); }
  if (u.protocol !== 'https:' || u.hostname !== 'calendar.google.com' || u.port || u.username || u.password || u.search || u.hash ||
      !/^\/calendar\/ical\/[^/]+\/(private-[A-Za-z0-9_-]+|public)\/basic\.ics$/.test(u.pathname)) {
    throw new Error('لینک iCal باید مستقیماً از تنظیمات Google Calendar کپی شود.');
  }
  let calendarId;
  try { calendarId = decodeURIComponent(u.pathname.split('/')[3]); } catch { throw new Error('نشانی iCal معتبر نیست.'); }
  return {url:u.href, calendarId};
}

const formatters = new Map();
function wallToEpoch(t, zone) {
  let f = formatters.get(zone);
  if (!f) { f = new Intl.DateTimeFormat('en-GB', {timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}); formatters.set(zone,f); }
  const target = Date.UTC(t.year,t.month-1,t.day,t.hour,t.minute,t.second);
  let guess = target;
  for (let n=0;n<4;n++) {
    const p = Object.fromEntries(f.formatToParts(new Date(guess)).map(x=>[x.type,x.value]));
    const shown = Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
    const delta = target-shown; if (!delta) return guess; guess += delta;
  }
  return guess;
}
function epoch(t, event, prop, defaultZone) {
  if (t.isDate) return Date.UTC(t.year,t.month-1,t.day);
  if (t.zone?.tzid && t.zone.tzid !== 'floating') return t.toUnixTime()*1000;
  const zone = event.component.getFirstProperty(prop)?.getParameter('tzid') || defaultZone;
  return wallToEpoch(t,zone);
}
function dateOnly(t) { return `${String(t.year).padStart(4,'0')}-${String(t.month).padStart(2,'0')}-${String(t.day).padStart(2,'0')}`; }
function cancelled(event) { return event.component.getFirstPropertyValue('status') === 'CANCELLED'; }

/** Expand Google iCal events with recurrence exceptions, EXDATE and timezone rules. */
export function parseCalendar(ics, feed, month) {
  const window = bounds(month);
  if (Buffer.byteLength(ics,'utf8') > MAX_BYTES) throw new Error('Calendar is too large');
  const calendar = new ICAL.Component(ICAL.parse(ics));
  if (calendar.name !== 'vcalendar') throw new Error('Invalid calendar');
  const defaultZone = calendar.getFirstPropertyValue('x-wr-timezone') || 'Europe/Berlin';
  const components = calendar.getAllSubcomponents('vevent');
  const byUid = new Map(), results = new Map();
  for (const c of components) { const uid = c.getFirstPropertyValue('uid') || createHash('sha256').update(c.toString()).digest('hex'); if (!byUid.has(uid)) byUid.set(uid,[]); byUid.get(uid).push(c); }
  let iterations = 0;
  function add(event, start, end, occurrence) {
    if (cancelled(event) || !start || !end) return;
    const a=epoch(start,event,'dtstart',defaultZone), b=epoch(end,event,'dtend',defaultZone);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || b <= window.start || a >= window.end) return;
    const id = createHash('sha256').update(`${feed.calendarId}\n${event.uid}\n${occurrence || start.toString()}`).digest('hex').slice(0,32);
    const ownAttendee = event.attendees.find(p => String(p.getFirstValue()).replace(/^mailto:/i,'').toLowerCase() === feed.calendarId.toLowerCase());
    results.set(id,{id,calendarId:feed.calendarId,calendarName:feed.name,title:cut(event.summary || '(بدون عنوان)'),
      start:start.isDate?dateOnly(start):new Date(a).toISOString(),end:end.isDate?dateOnly(end):new Date(b).toISOString(),allDay:start.isDate,
      busy:event.component.getFirstPropertyValue('transp') !== 'TRANSPARENT' && ownAttendee?.getParameter('partstat') !== 'DECLINED',
      source:'ical'});
  }
  for (const group of byUid.values()) {
    const exceptions=group.filter(c=>c.hasProperty('recurrence-id'));
    const masters=group.filter(c=>!c.hasProperty('recurrence-id'));
    if (masters.length && masters.every(c=>c.getFirstPropertyValue('status')==='CANCELLED')) continue;
    const cancelledOccurrences=new Set(exceptions.filter(c=>c.getFirstPropertyValue('status')==='CANCELLED').map(c=>c.getFirstPropertyValue('recurrence-id').toString()));
    for (const c of masters) {
      const event = new ICAL.Event(c,{exceptions,strictExceptions:true});
      if (cancelled(event) || !event.startDate) continue;
      if (!event.isRecurring()) {add(event,event.startDate,event.endDate);continue;}
      // DTSTART iteration is required for COUNT rules. Bound work and reject unsupported huge feeds,
      // retaining the previous good cache instead of silently presenting an incomplete calendar.
      const iterator=event.iterator();
      let occurrence;
      while ((occurrence=iterator.next())) {
        if (++iterations > 200000) throw new Error('Recurrence expansion limit');
        if (epoch(occurrence,event,'dtstart',defaultZone) >= window.end) break;
        if(cancelledOccurrences.has(occurrence.toString())||cancelledOccurrences.has(occurrence.convertToZone(ICAL.Timezone.utcTimezone).toString()))continue;
        const details=event.getOccurrenceDetails(occurrence);
        add(details.item,details.startDate,details.endDate,occurrence.toString());
      }
    }
    // A moved exception may enter this month while its original occurrence is outside it.
    for (const c of exceptions) {
      const event=new ICAL.Event(c,{exceptions:[]});
      if (!cancelled(event)&&event.startDate) add(event,event.startDate,event.endDate,event.recurrenceId.toString());
    }
  }
  return [...results.values()].sort((a,b)=>a.start.localeCompare(b.start));
}

function normalizeEvent(e) {
  if (!e || !e.id || !e.start || !e.end) return null;
  const allDay=!!e.allDay;
  if (allDay ? !/^\d{4}-\d{2}-\d{2}$/.test(e.start)||!/^\d{4}-\d{2}-\d{2}$/.test(e.end) : !Number.isFinite(Date.parse(e.start))||!Number.isFinite(Date.parse(e.end))) return null;
  if (Date.parse(e.end)<=Date.parse(e.start)) return null;
  let url=null;
  try {const u=new URL(e.url);if(u.protocol==='https:'&&['calendar.google.com','www.google.com'].includes(u.hostname)&&!u.username&&!u.password)url=u.href;}catch{}
  return {id:cut(e.id,200),calendarId:cut(e.calendarId,250),calendarName:cut(e.calendarName,150),title:cut(e.title||'(بدون عنوان)'),start:e.start,end:e.end,allDay,busy:e.busy!==false,source:cut(e.source||'snapshot',30),status:['confirmed','tentative','cancelled'].includes(e.status)?e.status:'confirmed',url};
}
function inMonth(e,month) {const w=bounds(month);return Date.parse(e.start)<w.end && Date.parse(e.end)>w.start;}

const SETTINGS = {version:1,feeds:[]};
const CACHE = {version:1,months:{}};
const SNAPSHOT = {months:[],events:[]};
const SYNC_ERROR = 'همگام‌سازی انجام نشد؛ آخرین نسخهٔ ذخیره‌شده نمایش داده می‌شود. اینترنت یا لینک iCal را بررسی کن.';

/** Requests await refreshes: no background timer or post-response work is needed on Vercel. */
export async function createCalendarService(store, options={}) {
  if (!store?.read || !store?.update) throw new TypeError('A private persistence store is required');
  const fetcher=options.fetch || globalThis.fetch, now=options.now || Date.now;
  let view={settings:SETTINGS,cache:CACHE,snapshot:SNAPSHOT}, activeMonth=null, closed=false;
  const requestedSync=new Map();

  async function load() {
    const [a,b,c]=await Promise.all([
      store.read('calendar-settings',SETTINGS), store.read('calendar-cache',CACHE), store.read('calendar-snapshot',SNAPSHOT)
    ]);
    const settings=a.value,cache=b.value,snapshot=c.value;
    if (!settings || !Array.isArray(settings.feeds) || settings.feeds.length>10 ||
        !cache || !cache.months || Array.isArray(cache.months) || typeof cache.months!=='object' ||
        !snapshot || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.months)) throw new Error('تنظیمات ذخیره‌شدهٔ تقویم معتبر نیست.');
    const ids=new Set();
    for (const f of settings.feeds) {
      const validated=validateFeedUrl(f.url);
      if(typeof f.id!=='string'||ids.has(f.id)||validated.calendarId!==f.calendarId) throw new Error('تنظیمات ذخیره‌شدهٔ تقویم معتبر نیست.');
      ids.add(f.id);
    }
    snapshot.events=snapshot.events.map(normalizeEvent).filter(Boolean);
    return view={settings,cache,snapshot};
  }
  function entry(data,month,feed) {
    const value=data.cache.months[month]?.[feed.id];
    return value && value.configVersion===feed.configVersion ? value : undefined;
  }
  function status(month=activeMonth,data=view) {
    const {settings,cache,snapshot}=data;
    const source=settings.feeds.length?'feed':snapshot.events.length||snapshot.months.length?'snapshot':'none';
    const lastSynced=settings.feeds.map(f=>entry(data,month,f)?.fetchedAt).filter(Boolean).sort().at(-1)||
      (snapshot.months.includes(month)?snapshot.fetchedAt:null)||null;
    const coveredMonths=[...new Set([...snapshot.months,...Object.keys(cache.months).filter(m=>settings.feeds.some(f=>entry(data,m,f)?.fetchedAt))])].sort();
    return {mode:source,source,autoSync:!!settings.feeds.length,pollSeconds:POLL_MS/1000,
      snapshotAt:snapshot.fetchedAt||null,fetchedAt:lastSynced,lastSynced,coveredMonths,snapshotCoversMonth:snapshot.months.includes(month),
      feeds:settings.feeds.map(f=>({id:f.id,name:f.name,calendarId:f.calendarId,lastSynced:entry(data,month,f)?.fetchedAt||null,
        lastAttempt:entry(data,month,f)?.lastAttempt||null,error:entry(data,month,f)?.error||null}))};
  }
  async function download(url) {
    validateFeedUrl(url);
    const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{Accept:'text/calendar'}});
    if (!response.ok || !response.body) throw new Error('Download failed');
    if (+response.headers.get('content-length')>MAX_BYTES) {await response.body.cancel();throw new Error('Calendar too large');}
    let size=0;const chunks=[];
    for await (const chunk of response.body) {size+=chunk.length;if(size>MAX_BYTES)throw new Error('Calendar too large');chunks.push(Buffer.from(chunk));}
    return Buffer.concat(chunks).toString('utf8');
  }
  async function doSync(month,force) {
    if (closed) throw new Error('Calendar service is closed');
    const initial=await load();
    const feeds=initial.settings.feeds.filter(f=>force||now()-Date.parse(entry(initial,month,f)?.lastAttempt||'1970-01-01')>=POLL_MS);
    if(!feeds.length)return status(month,initial);
    const outcomes=[];
    let index=0;
    // At most three Google requests run concurrently, each with an eight-second bound.
    await Promise.all(Array.from({length:Math.min(3,feeds.length)},async()=>{
      while(index<feeds.length) {
        const f=feeds[index++],lastAttempt=new Date(now()).toISOString();
        try {const ics=await download(f.url);outcomes.push({feed:f,events:parseCalendar(ics,f,month),fetchedAt:new Date(now()).toISOString(),lastAttempt,error:null});}
        catch {outcomes.push({feed:f,lastAttempt,error:SYNC_ERROR});}
      }
    }));
    // Sync never writes settings. CAS merges cache entries without reviving removed feeds or
    // applying an old URL's events to an updated configuration, even on another instance.
    const latest=await load();
    await store.update('calendar-cache',CACHE,cache=>{
      cache.months ||= {};
      cache.months[month] ||= {};
      for(const outcome of outcomes) {
        const f=latest.settings.feeds.find(x=>x.id===outcome.feed.id&&x.configVersion===outcome.feed.configVersion);
        if(!f)continue;
        const old=cache.months[month][f.id];
        const validOld=old?.configVersion===f.configVersion?old:{};
        // A later completed sync must not be replaced by an earlier attempt.
        if(Date.parse(validOld.lastAttempt||'1970-01-01')>Date.parse(outcome.lastAttempt))continue;
        cache.months[month][f.id]={...validOld,configVersion:f.configVersion,lastAttempt:outcome.lastAttempt,error:outcome.error,
          ...(outcome.events?{events:outcome.events,fetchedAt:outcome.fetchedAt}:{})};
      }
      return cache;
    });
    return status(month,await load());
  }
  function sync(month=activeMonth,{force=true}={}) {
    validMonth(month);activeMonth=month;
    if(requestedSync.has(month))return requestedSync.get(month);
    const operation=doSync(month,force).finally(()=>requestedSync.delete(month));
    requestedSync.set(month,operation);return operation;
  }
  async function getMonth(month) {
    validMonth(month);activeMonth=month;
    let data=await load();
    if(options.autoSync!==false&&data.settings.feeds.some(f=>now()-Date.parse(entry(data,month,f)?.lastAttempt||'1970-01-01')>=POLL_MS)) {
      await sync(month,{force:false});data=await load();
    }
    const {settings,snapshot}=data,covered=new Set();let events=[];
    for (const f of settings.feeds) {
      const stored=entry(data,month,f);
      if(stored?.fetchedAt) {covered.add(f.calendarId.toLowerCase());events.push(...(stored.events||[]).map(normalizeEvent).filter(Boolean));}
    }
    const snapshotEvents=snapshot.events.filter(e=>!covered.has(e.calendarId.toLowerCase())&&inMonth(e,month));
    events.push(...snapshotEvents);
    const snapshotCoversMonth=snapshot.months.includes(month);
    const snapshotSources=[...(snapshotCoversMonth?(snapshot.calendars||[]).map(c=>cut(c.id,250)):[]),...snapshotEvents.map(e=>e.calendarId)];
    const snapshotCalendars=[...new Map(snapshotSources.filter(id=>id&&!covered.has(id.toLowerCase())).map(id=>[id.toLowerCase(),id])).values()];
    const liveFeeds=settings.feeds.filter(f=>entry(data,month,f)?.fetchedAt);
    const merged=[...new Map(events.map(e=>[`${e.calendarId}:${e.id}`,e])).values()].sort((a,b)=>a.start.localeCompare(b.start));
    return {month,events:merged,status:status(month,data),coverage:{snapshot:snapshotCoversMonth,snapshotCalendars,
      feedCalendars:liveFeeds.map(f=>f.calendarId),feeds:liveFeeds.map(f=>({id:f.id,fetchedAt:entry(data,month,f).fetchedAt}))}};
  }
  async function configure(change) {
    if(closed)throw new Error('Calendar service is closed');
    if (!change || typeof change!=='object')throw new Error('تغییر تنظیمات معتبر نیست.');
    // Validate before opening the transaction, including untrusted feed URLs.
    const parsed=change.add?validateFeedUrl(change.add.url):null;
    if(!parsed&&typeof change.remove!=='string')throw new Error('تغییر تنظیمات معتبر نیست.');
    await store.update('calendar-settings',SETTINGS,settings=>{
      if(parsed) {
        const {url,calendarId}=parsed;
        const existing=settings.feeds.find(f=>f.calendarId.toLowerCase()===calendarId.toLowerCase());
        if(settings.feeds.length>=10&&!existing)throw new Error('حداکثر ۱۰ تقویم را می‌توان اضافه کرد.');
        const feed={id:existing?.id||randomUUID(),name:cut(change.add.name||calendarId,150),calendarId,url,configVersion:randomUUID()};
        if(existing)settings.feeds=settings.feeds.map(f=>f.id===existing.id?feed:f);else settings.feeds.push(feed);
      }else settings.feeds=settings.feeds.filter(f=>f.id!==change.remove);
      return settings;
    });
    if(!parsed)await store.update('calendar-cache',CACHE,cache=>{for(const stored of Object.values(cache.months))delete stored[change.remove];return cache;});
    return status(activeMonth,await load());
  }
  await load();
  return {getMonth,status,configure,sync,async close(){closed=true;await Promise.allSettled([...requestedSync.values()]);}};
}
