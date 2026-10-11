import {DAY,dayNumber,dayString,interval,monthBounds} from './core.mjs';

const MINUTE=60000;
const berlinClock=new Intl.DateTimeFormat('en-GB',{
  timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',hourCycle:'h23'
});
const DST_NOTE='تغییر ساعت آلمان: نمایش بر اساس ساعت محلی است. ساعت تکراری قابل تفکیک نیست و یک بار شمرده می‌شود؛ تداخل در آن ساعت احتمالی است.';

function offsetAt(utcMinute){
  const parts=Object.fromEntries(berlinClock.formatToParts(new Date(utcMinute*MINUTE)).map(p=>[p.type,p.value]));
  const localMinute=Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute)/MINUTE;
  return localMinute-utcMinute;
}

function isoMinute(value,end=false){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)||!Number.isFinite(dayNumber(value.slice(0,10))))return NaN;
  const valueMs=Date.parse(value);
  // The planner has one-minute precision; retain any partly occupied minute.
  return end?Math.ceil(valueMs/MINUTE):Math.floor(valueMs/MINUTE);
}

function union(spans){
  const result=[];
  for(const [start,end] of spans.sort((a,b)=>a[0]-b[0]||a[1]-b[1])){
    if(!(start<end))continue;
    const last=result.at(-1);
    if(last&&start<=last[1])last[1]=Math.max(last[1],end);
    else result.push([start,end]);
  }
  return result;
}

function wallSpans(start,end,bounds){
  // Clip before scanning so even a multi-year event costs only one month.
  let cursor=Math.max(start,bounds.start-14*60),stop=Math.min(end,bounds.end+14*60);
  if(cursor>=stop)return {spans:[],dstAdjusted:false};
  let segmentStart=cursor,offset=offsetAt(cursor),dstAdjusted=false;
  const spans=[];
  while(cursor<stop){
    // Berlin offset transitions cannot occur twice in a six-hour window.
    const probe=Math.min(cursor+360,stop-1);
    if(probe<=cursor)break;
    if(offsetAt(probe)===offset){cursor=probe;continue;}
    let low=cursor+1,high=probe;
    while(low<high){const mid=Math.floor((low+high)/2);if(offsetAt(mid)===offset)low=mid+1;else high=mid;}
    spans.push([segmentStart+offset,low+offset]);
    dstAdjusted=true;cursor=low;segmentStart=low;offset=offsetAt(low);
  }
  spans.push([segmentStart+offset,stop+offset]);
  // A repeated autumn hour occupies the same wall-clock cells. Merge them;
  // a spring gap stays empty because those local clock times never occurred.
  return {spans:union(spans),dstAdjusted};
}

function isBusy(event){
  const statuses=[event.status,event.responseStatus,event.selfResponseStatus].map(v=>String(v||'').toLowerCase());
  return event.busy!==false&&event.transparency!=='transparent'&&!event.declined&&!statuses.some(s=>['cancelled','canceled','declined','transparent','free'].includes(s));
}

function prepare(events,month){
  const bounds=monthBounds(month),segments=[],invalid=[];
  if(!Array.isArray(events))return {segments,invalid:[{eventId:null,error:'Calendar events must be an array'}]};
  for(const event of events){
    let error=null,spans=[],dstAdjusted=false;
    if(!event||typeof event.id!=='string'||!event.id)error='Calendar event needs an ID';
    else if(event.allDay){
      const start=dayNumber(event.start)*DAY,end=dayNumber(event.end)*DAY;
      if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end)error='Invalid all-day date range';
      else spans=[[start,end]];
    }else{
      const start=isoMinute(event.start),end=isoMinute(event.end,true);
      if(!Number.isFinite(start)||!Number.isFinite(end)||Date.parse(event.start)>=Date.parse(event.end))error='Invalid timed event range or missing UTC offset';
      else ({spans,dstAdjusted}=wallSpans(start,end,bounds));
    }
    if(error){invalid.push({eventId:event?.id||null,title:event?.title||'',error,original:event});continue;}
    const eventKey=`${event.calendarId||''}:${event.id}`,busy=isBusy(event);
    for(const [from,to] of spans){
      let start=Math.max(from,bounds.start),end=Math.min(to,bounds.end);
      while(start<end){
        const day=Math.floor(start/DAY),stop=Math.min(end,(day+1)*DAY),date=dayString(day);
        segments.push({
          id:event.id,eventId:event.id,eventKey,segmentKey:`${eventKey}:${date}:${start}:${stop}`,
          calendarId:event.calendarId||'',calendarName:event.calendarName||'',title:event.title||'(بدون عنوان)',
          date,start:start-day*DAY,end:stop-day*DAY,duration:stop-start,
          busy,free:!busy,allDay:!!event.allDay,status:event.status||'',url:event.url||'',
          dstAdjusted,dstNote:dstAdjusted?DST_NOTE:'',original:event
        });
        start=stop;
      }
    }
  }
  segments.sort((a,b)=>a.date.localeCompare(b.date)||a.start-b.start||a.end-b.end||a.eventKey.localeCompare(b.eventKey));
  return {segments,invalid};
}

/** Day segments use Berlin clock minutes, including 1440 for midnight end. */
export function calendarSegments(events,month){return prepare(events,month).segments;}

/** Pair boundaries are absolute wall-clock minutes, as in core.interval(). */
export function analyzeCalendar(entries,events,month){
  const {segments,invalid}=prepare(events,month),bounds=monthBounds(month);
  const pairs=[],byEntryId=new Map(),eventIds=new Set(),eventKeys=new Set(),spans=[];
  const work=entries.map(entry=>({entry,...interval(entry)})).filter(v=>!v.error&&v.start<bounds.end&&v.end>bounds.start);
  for(const segment of segments){
    if(!segment.busy)continue;
    const day=dayNumber(segment.date)*DAY,eventStart=day+segment.start,eventEnd=day+segment.end;
    for(const item of work){
      const start=Math.max(item.start,eventStart,bounds.start),end=Math.min(item.end,eventEnd,bounds.end);
      if(start>=end)continue;
      const pair={entryId:item.entry.id,eventId:segment.eventId,eventKey:segment.eventKey,title:segment.title,date:segment.date,
        start,end,startMinute:start-day,endMinute:end-day,minutes:end-start,
        calendarId:segment.calendarId,calendarName:segment.calendarName,url:segment.url,allDay:segment.allDay,
        dstAdjusted:segment.dstAdjusted,dstNote:segment.dstNote};
      pairs.push(pair);spans.push([start,end]);
      byEntryId.set(pair.entryId,[...(byEntryId.get(pair.entryId)||[]),pair]);eventIds.add(pair.eventId);eventKeys.add(pair.eventKey);
    }
  }
  pairs.sort((a,b)=>a.start-b.start||a.end-b.end||a.entryId.localeCompare(b.entryId));
  const conflictMinutes=union(spans).reduce((total,[start,end])=>total+end-start,0);
  return {pairs,byEntryId,eventIds,eventKeys,conflictMinutes,segments,invalid};
}
