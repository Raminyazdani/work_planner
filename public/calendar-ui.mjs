import {REGIONS} from './holidays.mjs';
import {calendarSegments} from './calendar-core.mjs';
import {responseError} from './session.mjs';
import {RefreshBudget,watchRefresh} from './polling.mjs';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=value=>value&&Number.isFinite(new Date(value).getTime())?new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',dateStyle:'short',timeStyle:'short'}).format(new Date(value)):'';
function preference(key,fallback){try{return localStorage.getItem(key)??fallback;}catch{return fallback;}}
function storePreference(key,value){try{localStorage.setItem(key,value);}catch{}}

export function mountCalendar({month,onData,onViewChange,request=fetch,isReady=()=>true,mode=()=> 'local'}){
  let payload={events:[],status:{},coverage:{}},requestId=0,pending=false,queuedLoad=null;
  const budget=new RefreshBudget({interval:()=>mode()==='cloud'?Math.max(900,Number(payload.status?.pollSeconds)||900)*1000:15000,cloud:()=>mode()==='cloud',visible:()=>!document.hidden});
  function failed(error){if(error.retryable||error.code==='STORAGE_UNAVAILABLE')budget.defer(Math.max(60000,error.retryAfterMs||0));}
  function nextLoad(){if(queuedLoad){const {force}=queuedLoad;queuedLoad=null;setTimeout(()=>load(force),0);}}
  async function json(response,fallback){if(!response.ok)throw await responseError(response,fallback);return response.json();}
  let region=preference('work-planner-holidays','BOTH');
  if(!REGIONS.some(r=>r.code===region))region='BOTH';
  $('holiday-region').value=region;
  $('show-calendar').checked=preference('work-planner-show-calendar','true')!=='false';
  $('holiday-region').onchange=e=>{region=e.target.value;storePreference('work-planner-holidays',region);onViewChange();};
  $('show-calendar').onchange=e=>{storePreference('work-planner-show-calendar',String(e.target.checked));onViewChange();};
  function settings(open){$('calendar-settings').hidden=!open;$('calendar-settings-toggle').setAttribute('aria-expanded',String(open));}
  $('calendar-settings-toggle').onclick=()=>settings($('calendar-settings').hidden);
  function renderStatus(){
    const s=payload.status||{},has=payload.coverage?.snapshot||payload.coverage?.feeds?.length,errors=(s.feeds||[]).filter(f=>f.error);
    const count=payload.month?new Set(calendarSegments(payload.events,payload.month).map(s=>s.eventKey)).size:0;
    let label=has?`${count} رویداد · `:'';
    if(errors.length)label+='خطای همگام‌سازی؛ آخرین نسخهٔ دریافت‌شده';
    else if(s.autoSync)label+=payload.coverage?.snapshotCalendars?.length?'فید خودکار + نسخهٔ ذخیره‌شدهٔ تقویم‌های دیگر':mode()==='cloud'?'همگام‌سازی خودکار · هر ۱۵ دقیقه هنگام استفاده':'همگام‌سازی خودکار · هر ۶۰ ثانیه';
    else label+=has?'نسخهٔ ذخیره‌شده · اتصال خودکار هنوز فعال نیست':'این ماه هنوز از تقویم دریافت نشده';
    const at=s.lastSynced||s.fetchedAt||s.snapshotAt;
    $('calendar-status').textContent=label;$('calendar-status').title=at?`آخرین دریافت: ${stamp(at)} · Europe/Berlin`:'';
    $('calendar-status').classList.toggle('calendar-error',!!errors.length);
    $('calendar-feeds').innerHTML=(s.feeds||[]).map(f=>`<div class="calendar-feed"><span>${esc(f.name)} <small>${f.error?esc(f.error):f.lastSynced?'آخرین دریافت: '+stamp(f.lastSynced):'در انتظار دریافت'}</small></span><button data-disconnect="${esc(f.id)}" type="button">قطع اتصال</button></div>`).join('');
    $('calendar-settings-toggle').textContent=s.autoSync?'تنظیمات اتصال':'اتصال خودکار تقویم';
  }
  async function load(force=false,{automatic=false,reason='poll'}={}){
    if(!isReady())return;
    if(pending||budget.pending){if(!automatic)queuedLoad={force:force||queuedLoad?.force||false};return;}
    await budget.run(async()=>{
    const id=++requestId,period=month();pending=true;
    $('calendar-refresh').disabled=true;
    try{const response=await request(force?'/api/calendar/sync':`/api/calendar?month=${encodeURIComponent(period)}`,force?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({month:period})}:{});const data=await json(response,'تقویم دریافت نشد.');if(id!==requestId||period!==month())return;payload=data;renderStatus();onData(data);if(force&&!data.status?.autoSync)settings(true);}
    catch(e){failed(e);if(id===requestId){$('calendar-status').textContent=e.code==='STORAGE_UNAVAILABLE'?e.message:'ارتباط برقرار نشد؛ دادهٔ موجود نگه داشته شد.';$('calendar-status').classList.add('calendar-error');}}
    finally{if(id===requestId){pending=false;$('calendar-refresh').disabled=false;}}
    },{manual:!automatic,reason});
    nextLoad();
  }
  $('calendar-refresh').onclick=()=>load(true);
  $('calendar-connect-form').onsubmit=async e=>{
    e.preventDefault();const button=$('calendar-connect'),id=++requestId,period=month();pending=true;budget.attempted();button.disabled=true;$('calendar-connect-message').textContent='در حال اتصال…';
    try{const response=await request('/api/calendar/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({add:{name:$('calendar-feed-name').value,url:$('calendar-feed-url').value.trim()},month:period})});const data=await json(response,'اتصال انجام نشد.');$('calendar-feed-url').value='';if(id===requestId&&period===month()){payload=data;renderStatus();onData(data);}$('calendar-connect-message').textContent=data.status?.feeds?.some(f=>f.error)?'لینک ذخیره شد؛ دریافت موفق نبود. وضعیت بالا را بررسی کن.':'متصل شد؛ بررسی خودکار فعال است.';}
    catch(e){failed(e);$('calendar-connect-message').textContent=e.message;}
    finally{button.disabled=false;if(id===requestId){pending=false;$('calendar-refresh').disabled=false;nextLoad();}}
  };
  $('calendar-feeds').onclick=async e=>{
    const feedId=e.target.dataset.disconnect;if(!feedId)return;const id=++requestId,period=month();pending=true;budget.attempted();e.target.disabled=true;
    try{const response=await request('/api/calendar/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({remove:feedId,month:period})});const data=await json(response,'قطع اتصال انجام نشد.');if(id===requestId&&period===month()){payload=data;renderStatus();onData(data);}$('calendar-connect-message').textContent='اتصال این فید قطع شد.';}
    catch(e){failed(e);$('calendar-connect-message').textContent=e.message;e.target.disabled=false;}
    finally{if(id===requestId){pending=false;$('calendar-refresh').disabled=false;nextLoad();}}
  };
  watchRefresh(budget,reason=>load(false,{automatic:true,reason}));
  return {load,show:()=>$('show-calendar').checked,region:()=>region,hasCoverage:()=>payload.month===month()&&!!(payload.coverage?.snapshot||payload.coverage?.feeds?.length),
    showEvent(event){const el=$('calendar-event-detail');el.hidden=false;let link='';try{const u=new URL(event.url);if(u.protocol==='https:'&&['www.google.com','calendar.google.com'].includes(u.hostname))link=`<a target="_blank" rel="noreferrer" href="${esc(u.href)}">باز کردن در Google Calendar ↗</a>`;}catch{}
      el.innerHTML=`<div><strong>${esc(event.title)}</strong><span>${esc(event.date)} · ${event.allDay?'تمام روز':`${String(Math.floor(event.start/60)).padStart(2,'0')}:${String(event.start%60).padStart(2,'0')}–${String(Math.floor(event.end/60)).padStart(2,'0')}:${String(event.end%60).padStart(2,'0')}`} · ${event.busy?'مشغول':'آزاد؛ در تداخل حساب نمی‌شود'}</span>${event.dstAdjusted?'<small>'+esc(event.dstNote)+'</small>':''}</div>${link}<button id="close-calendar-event" class="quiet">×</button>`;$('close-calendar-event').onclick=()=>el.hidden=true;
    }
  };
}
