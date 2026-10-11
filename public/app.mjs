import {dayFlags} from './holidays.mjs';
import {analyzeCalendar} from './calendar-core.mjs';
import {mountCalendar} from './calendar-ui.mjs';
import {sessionInfo,login} from './session.mjs';
import {JOBS,DAY,dayNumber,dayString,parseTime,timeString,durationText,interval,monthBounds,daysInMonth,splitEntry,visibleEntries,analyze,normalizeState} from './core.mjs';
const $=id=>document.getElementById(id),job=id=>JOBS.find(j=>j.id===id),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
let state={version:1,entries:[]},revision=0,selected=null,history=[],saving=false,dirty=false,saveTimer,toastTimer,conflictsOpen=false;
let session={authenticated:false,mode:'local',authRequired:false},loaded=false,saveBlocked=false;
function preference(key,fallback){try{return localStorage.getItem(key)??fallback;}catch{return fallback;}}
function storePreference(key,value){try{localStorage.setItem(key,value);}catch{}}
let month=preference('work-planner-month',today().slice(0,7));try{monthBounds(month);}catch{month=today().slice(0,7);}$('month').value=month;
let analysis=analyze([],month),calendarData={events:[],status:{},coverage:{}},calendarReview=analyzeCalendar([],[],month);
const calendarUI=mountCalendar({month:()=>month,request:apiFetch,isReady:()=>loaded&&session.authenticated,onData:data=>{calendarData=data;render(true);},onViewChange:()=>render()});
function savedMessage(){return session.mode==='cloud'?'ذخیره شد در فضای خصوصی آنلاین':'ذخیره شد روی این کامپیوتر';}
function showSession(){
  $('storage-mode').textContent=session.mode==='cloud'?'فضای خصوصی آنلاین':'ذخیرهٔ محلی';
  $('logout-btn').hidden=!session.authRequired;
}
async function apiFetch(url,options={}){
  const response=await fetch(url,{...options,cache:'no-store',credentials:'same-origin'});
  if(response.status===401){
    session.authenticated=false;
    if(dirty||saving){$('session-message').textContent='نشست ورود پایان یافته. تغییرات ذخیره‌نشده در همین صفحه محفوظ است؛ دوباره وارد شو.';if(!$('session-dialog').open)$('session-dialog').showModal();}
    else window.location.replace('/login');
    throw Error('برای ادامه دوباره وارد شو.');
  }
  return response;
}
function offday(date){try{return dayFlags(date,calendarUI.region(),{assumptionDay:['BY','BOTH'].includes(calendarUI.region())});}catch{return {red:false,weekend:false,names:[],holidays:[]};}}
function holidayLabel(date){const f=offday(date);return [...(f.weekend?['آخر هفته']:[]),...f.holidays.map(h=>`${h.name} (${h.regions.join(' / ')})`)].join(' · ');}
function hasConflict(id){return analysis.byId.has(id)||calendarReview.byEntryId.has(id);}
function conflictBadges(id){return `${analysis.byId.has(id)?'<small>تداخل کار</small>':''}${calendarReview.byEntryId.has(id)?'<small>تقویم</small>':''}`;}
function conflictTitle(id){return [analysis.byId.has(id)?'تداخل با بازهٔ کاری':'',...(calendarReview.byEntryId.get(id)||[]).map(p=>'تقویم: '+p.title)].filter(Boolean).join(' · ');}

function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,3800);}
function checkpoint(){history.push(JSON.stringify(state.entries));if(history.length>40)history.shift();$('undo-btn').disabled=false;}
function changed(keepEditor=false){dirty=true;$('save-status').textContent=saveBlocked?'تغییرات این صفحه ذخیره نشده':'ذخیره نشده…';clearTimeout(saveTimer);if(!saveBlocked)saveTimer=setTimeout(save,350);render(keepEditor);}
async function save(){
 if(saving||!dirty||!loaded||saveBlocked)return;
 saving=true;dirty=false;const snapshot=JSON.stringify({...state,revision});
 try{
  const r=await apiFetch('/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:snapshot});
  if(r.status===409){saveBlocked=true;$('conflict-actions').hidden=false;throw Error('اطلاعات در دستگاه یا زبانهٔ دیگری تغییر کرده است. برای جلوگیری از بازنویسی، ذخیره متوقف شد. ابتدا نسخهٔ این صفحه را پشتیبان بگیر و سپس آخرین اطلاعات را بارگذاری کن.');}
  const value=await r.json();if(!r.ok)throw Error(value.error||'ذخیره انجام نشد.');revision=value.revision;$('save-status').textContent=dirty?'در حال ذخیره…':savedMessage();$('save-status').className='';
 }catch(e){dirty=true;$('save-status').textContent=saveBlocked?'تداخل نسخه‌ها — ذخیره متوقف شد':'ذخیره نشد — دوباره تلاش کن';$('save-status').className='error';$('notice').textContent=e.message;$('notice').hidden=false;}
 finally{saving=false;if(dirty&&$('save-status').className!=='error')save();}
}
$('save-status').onclick=()=>save();
function changeMonth(value){try{monthBounds(value);}catch{return;}month=value;$('month').value=value;storePreference('work-planner-month',value);selected=null;render();calendarUI.load();}
function add(jobId=$('draw-job').value,date=month===today().slice(0,7)?today():month+'-01',start='',end='',endNextDay=false){checkpoint();const row={id:crypto.randomUUID(),jobId,date,start,end,endNextDay,tasks:''};state.entries.push(row);selected=row.id;changed();return row;}
function update(id,key,value){const row=state.entries.find(r=>r.id===id);if(!row||row[key]===value)return;checkpoint();row[key]=value;selected=id;changed();}
const editing=new WeakSet();
function editInput(element,id,key){const row=state.entries.find(r=>r.id===id);if(!row||row[key]===element.value)return;if(!editing.has(element)){checkpoint();editing.add(element);}row[key]=element.value;selected=id;changed(true);}
document.addEventListener('focusout',e=>editing.delete(e.target));
function select(id){selected=id;renderTable();renderInspector();for(const b of document.querySelectorAll('.block'))b.classList.toggle('selected',b.dataset.id===id);}
function render(keepEditor=false){analysis=analyze(state.entries,month);calendarReview=analyzeCalendar(state.entries,calendarData.events,month);for(const j of JOBS){$('total-'+j.id).textContent=durationText(analysis.totals[j.id]);$('export-'+j.id).disabled=!visibleEntries(state.entries,month).some(r=>r.jobId===j.id)||analysis.invalid.some(r=>r.jobId===j.id);}$('conflict-count').textContent=String(analysis.pairs.length);$('conflict-detail').textContent=analysis.pairs.length?`${durationText(analysis.conflictMinutes)} زمان هم‌پوشان · برای دیدن کلیک کن`:'هیچ تداخلی نیست';$('conflicts-toggle').classList.toggle('has-conflicts',!!analysis.pairs.length);if(!$('save-status').classList.contains('error')){$('notice').hidden=!analysis.invalid.length;$('notice').textContent=analysis.invalid.length?`${analysis.invalid.length} بازه ناقص یا نامعتبر است؛ ساعت‌های آن را کامل کن تا خروجی اکسل فعال شود.`:'';}$('calendar-conflict-count').textContent=calendarUI.hasCoverage()?String(calendarReview.pairs.length):'—';$('calendar-conflict-detail').textContent=calendarUI.hasCoverage()?(calendarReview.pairs.length?durationText(calendarReview.conflictMinutes)+' زمان هم‌پوشان':'هیچ تداخلی در دادهٔ دریافت‌شده نیست'):'دادهٔ این ماه دریافت نشده';$('calendar-conflicts-toggle').classList.toggle('has-conflicts',!!calendarReview.pairs.length);if(keepEditor)renderLiveRows();else{renderTable();renderInspector();}renderTimeline();renderConflicts();}
function renderTable(){const container=$('entries-table'),scroll=container.scrollTop,rows=visibleEntries(state.entries,month);let html='<table><thead><tr><th>Name</th><th>Date</th><th>Time start</th><th>Time end</th><th>Duration</th><th></th></tr></thead><tbody>';
 for(const j of JOBS){const group=rows.filter(r=>r.jobId===j.id).sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));html+=`<tr class="group-row ${j.id}"><td colspan="6"><div class="group-label"><span>${j.name} <small>· ${group.length}</small></span><button data-add="${j.id}" aria-label="افزودن بازه برای ${j.name}">+</button></div></td></tr>`;for(const r of group){const v=interval(r),conflict=hasConflict(r.id);html+=`<tr class="entry-row ${selected===r.id?'selected':''} ${conflict?'overlap':''} ${v.error?'invalid':''} ${offday(r.date).red?'offday':''}" data-id="${esc(r.id)}" title="${esc(v.error||[conflictTitle(r.id),holidayLabel(r.date)].filter(Boolean).join(' · '))}"><td><select data-key="jobId" aria-label="محل کار">${JOBS.map(j=>`<option value="${j.id}" ${j.id===r.jobId?'selected':''}>${j.name}</option>`).join('')}</select></td><td><input data-key="date" type="date" value="${esc(r.date)}" aria-label="تاریخ"></td><td><input data-key="start" type="time" value="${esc(r.start)}" aria-label="شروع"></td><td><input data-key="end" type="time" value="${esc(r.end)}" aria-label="پایان">${r.endNextDay?'<small style="font-size:10px;color:#62758f">+1 day</small>':''}</td><td class="duration-cell">${v.error?'—':durationText(v.duration)}${conflictBadges(r.id)}</td><td><button class="delete-btn" data-delete="${esc(r.id)}" aria-label="حذف بازه">×</button></td></tr>`;}if(!group.length)html+='<tr><td colspan="6" class="row-empty">هنوز بازه‌ای ثبت نشده.<br>از + استفاده کن یا روی نمای روزانه بکش.</td></tr>';}
 html+='</tbody></table>';container.innerHTML=html.replaceAll('type="time"','type="text" inputmode="numeric" placeholder="HH:MM" maxlength="5"');container.scrollTop=scroll;$('entry-count').textContent=`${rows.length} بازه در این ماه`;
}
function renderInspector(){const r=state.entries.find(r=>r.id===selected),el=$('inspector');el.hidden=!r;if(!r)return;const v=interval(r);el.innerHTML=`<label><input type="checkbox" id="next-day" ${r.endNextDay?'checked':''}> پایان در روز بعد است <span dir="ltr">· ${job(r.jobId).name} / ${esc(r.date)}</span></label><textarea id="tasks" maxlength="2000" placeholder="شرح فعالیت (اختیاری؛ برای فرم Jena مفید است)" aria-label="شرح فعالیت">${esc(r.tasks)}</textarea>${v.error?`<div class="entry-error">${esc(v.error)}</div>`:''}`;$('next-day').onchange=e=>update(r.id,'endNextDay',e.target.checked);$('tasks').oninput=e=>editInput(e.target,r.id,'tasks');}
function renderTimeline(){
 if(gesture){timelinePending=true;return;}timelinePending=false;
 const el=$('timeline'),top=el.scrollTop,left=el.scrollLeft;
 let html='<div class="timeline-inner"><div class="axis-row"><div class="axis-label">DATE / TIME</div><div class="axis-hours">';
 for(const h of [0,3,6,9,12,15,18,21,24])html+=`<span style="left:${h/24*100}%">${h===24?'23:59':String(h).padStart(2,'0')+':00'}</span>`;
 html+='</div></div>';
 const segments=state.entries.flatMap(r=>splitEntry(r,month)).map(s=>({...s,kind:'work'}));
 if(calendarUI.show())segments.push(...calendarReview.segments.map(s=>({...s,kind:'calendar'})));
 for(const date of daysInMonth(month)){
   const weekday=new Date(dayNumber(date)*86400000).getUTCDay(),flags=offday(date),dayNote=holidayLabel(date);
   const ds=segments.filter(s=>s.date===date).sort((a,b)=>a.start-b.start||b.end-a.end),laneEnds=[],positions=[];
   for(const s of ds){let lane=laneEnds.findIndex(e=>e<=s.start);if(lane<0)lane=laneEnds.length;laneEnds[lane]=s.end;positions.push({...s,lane});}
   const height=Math.max(70,laneEnds.length*29+15);
   html+=`<div class="day-row ${flags.weekend?'weekend':''} ${flags.red?'offday':''} ${date===today()?'today':''}" title="${esc(dayNote)}"><div class="day-label"><strong>${date.slice(8)} / ${date.slice(5,7)}</strong><small>${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][weekday]}</small>${flags.isHoliday?'<small class="holiday-mark">تعطیل رسمی</small>':''}</div><div class="day-track" data-date="${esc(date)}" style="height:${height}px">`;
   for(const s of positions){
     const range=s.allDay?'تمام روز':`${timeString(s.start)}–${s.end===1440?'24:00':timeString(s.end)}`;
     if(s.kind==='calendar'){
       const title=`${s.title} · ${range} · ${s.busy?'مشغول':'آزاد'}${s.dstNote?' · '+s.dstNote:''}`,clash=calendarReview.eventKeys.has(s.eventKey);
       html+=`<button class="calendar-block ${s.free?'free':''} ${clash?'overlap':''}" type="button" data-calendar-key="${esc(s.segmentKey)}" style="left:${s.start/DAY*100}%;width:${s.duration/DAY*100}%;top:${9+s.lane*29}px" aria-label="${esc('تقویم: '+title)}" title="${esc(title)}"><span>${esc(s.allDay?'تمام روز · '+s.title:s.duration>=180?timeString(s.start)+' · '+s.title:s.duration>=60?timeString(s.start):'◷')}</span></button>`;
     }else{
       const title=`${job(s.jobId).name} · ${range} · ${durationText(s.duration)}${hasConflict(s.id)?' · '+conflictTitle(s.id):''}`;
       html+=`<div class="block ${s.jobId} ${selected===s.id?'selected':''} ${hasConflict(s.id)?'overlap':''}" data-id="${esc(s.id)}" data-date="${esc(date)}" style="left:${s.start/DAY*100}%;width:${s.duration/DAY*100}%;top:${9+s.lane*29}px" role="button" tabindex="0" aria-label="${esc(title)}" title="${esc(title)}"><i class="handle start" data-edge="start"></i><span>${s.duration>=240?`${job(s.jobId).name} · `:''}${s.duration>=45?timeString(s.start):''}</span><i class="handle end" data-edge="end"></i></div>`;
     }
   }
   html+='</div></div>';
 }
 el.innerHTML=html+'</div>';el.scrollTop=top;el.scrollLeft=left;
}
function renderConflicts(){
 $('conflict-panel').hidden=!conflictsOpen;
 const work=analysis.pairs.map(p=>{const a=state.entries.find(r=>r.id===p.a),b=state.entries.find(r=>r.id===p.b);return `<div class="conflict-item"><span>${dayString(Math.floor(p.start/DAY))} · ${job(a.jobId).name} / ${job(b.jobId).name} · ${timeString(p.start)}–${timeString(p.end)}</span><strong>${durationText(p.minutes)}</strong><button data-show="${esc(a.id)}">دیدن بازه</button></div>`;}).join('');
 const calendar=calendarReview.pairs.map(p=>{const r=state.entries.find(r=>r.id===p.entryId);return `<div class="conflict-item calendar-conflict"><span><b>${esc(p.title)}</b><small>${esc(p.date)} · ${job(r.jobId).name} · ${timeString(p.start)}–${p.endMinute===1440?'24:00':timeString(p.end)}${p.dstNote?' · '+esc(p.dstNote):''}</small></span><strong>${durationText(p.minutes)}</strong><button data-show="${esc(r.id)}">دیدن بازه</button></div>`;}).join('');
 $('conflict-list').innerHTML=`${calendar?'<h3>کار و Google Calendar</h3>'+calendar:''}${work?'<h3>بازه‌های کاری</h3>'+work:''}${!calendar&&!work?'<div class="row-empty">در داده‌های موجود هم‌پوشانی پیدا نشد.</div>':''}`;
}
function renderLiveRows(){for(const tr of document.querySelectorAll('.entry-row')){const row=state.entries.find(r=>r.id===tr.dataset.id);if(!row)continue;const v=interval(row),conflict=hasConflict(row.id);tr.classList.toggle('overlap',conflict);tr.classList.toggle('offday',offday(row.date).red);tr.classList.toggle('invalid',!!v.error);tr.classList.toggle('selected',row.id===selected);tr.title=v.error||[conflictTitle(row.id),holidayLabel(row.date)].filter(Boolean).join(' · ');tr.querySelector('.duration-cell').innerHTML=(v.error?'—':durationText(v.duration))+conflictBadges(row.id);}const error=document.querySelector('#inspector .entry-error');if(error){const row=state.entries.find(r=>r.id===selected);error.textContent=row?(interval(row).error||''):'';}}
$('entries-table').addEventListener('input',e=>{const row=e.target.closest('.entry-row');if(row&&e.target.matches('input[data-key]'))editInput(e.target,row.dataset.id,e.target.dataset.key);});
$('entries-table').addEventListener('change',e=>{const row=e.target.closest('[data-id]');if(row&&e.target.dataset.key)update(row.dataset.id,e.target.dataset.key,e.target.value);});
$('entries-table').addEventListener('click',e=>{if(e.target.dataset.add)return add(e.target.dataset.add);if(e.target.dataset.delete){checkpoint();state.entries=state.entries.filter(r=>r.id!==e.target.dataset.delete);selected=null;changed();return;}const row=e.target.closest('.entry-row');if(row&&!e.target.matches('input,select'))select(row.dataset.id);else if(row){selected=row.dataset.id;renderInspector();}});
let suppressClick=false;
$('timeline').addEventListener('click',e=>{const cal=e.target.closest('[data-calendar-key]');if(cal){const event=calendarReview.segments.find(s=>s.segmentKey===cal.dataset.calendarKey);if(event)calendarUI.showEvent(event);return;}if(suppressClick){suppressClick=false;return;}const b=e.target.closest('.block');if(b)select(b.dataset.id);});
$('timeline').addEventListener('keydown',e=>{const b=e.target.closest('.block');if(b&&['Enter',' '].includes(e.key)){e.preventDefault();select(b.dataset.id);}});
$('month').onchange=e=>{if(e.target.value)changeMonth(e.target.value);};
for(const [id,delta] of [['prev-month',-1],['next-month',1]])$(id).onclick=()=>{const [y,m]=month.split('-').map(Number);changeMonth(new Date(Date.UTC(y,m-1+delta,1)).toISOString().slice(0,7));};
$('today-month').onclick=()=>changeMonth(today().slice(0,7));$('add-btn').onclick=()=>add();
$('undo-btn').onclick=()=>{if(!history.length)return;state.entries=JSON.parse(history.pop());selected=null;changed();$('undo-btn').disabled=!history.length;};
$('calendar-conflicts-toggle').onclick=()=>{conflictsOpen=!conflictsOpen;renderConflicts();if(conflictsOpen)$('conflict-panel').scrollIntoView({behavior:'smooth',block:'nearest'});};
$('conflicts-toggle').onclick=()=>{conflictsOpen=!conflictsOpen;renderConflicts();};$('close-conflicts').onclick=()=>{conflictsOpen=false;renderConflicts();};
$('conflict-list').onclick=e=>{if(e.target.dataset.show){select(e.target.dataset.show);document.querySelector(`.entry-row[data-id="${e.target.dataset.show}"]`)?.scrollIntoView({block:'nearest',behavior:'smooth'});}};
$('demo-btn').onclick=()=>{if(state.entries.length&&!confirm('چند بازهٔ آزمایشی به این ماه اضافه شود؟'))return;checkpoint();const date=month+'-08';for(const [jobId,start,end] of [['jena','09:00','12:00'],['seewiesen','11:00','13:30'],['jena','14:00','16:00']])state.entries.push({id:crypto.randomUUID(),jobId,date,start,end,endNextDay:false,tasks:'DEMO — دادهٔ آزمایشی'});changed();$('timeline').scrollTop=7*71;toast('نمونهٔ آزمایشی اضافه شد؛ با «برگردان» حذفش کن.');};
function download(data,name,type){const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
$('backup-btn').onclick=()=>download(JSON.stringify(state,null,2),'work-planner-backup.json','application/json');
$('import-btn').onclick=()=>$('import-file').click();$('import-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>2*1024*1024)throw Error('Backup too large');const incoming=normalizeState(JSON.parse(await file.text()));if(state.entries.length&&!confirm('پشتیبان جایگزین تمام بازه‌های فعلی شود؟'))return;checkpoint();state=incoming;selected=null;changed();toast('پشتیبان بازیابی شد.');}catch(e){toast('فایل پشتیبان معتبر نیست.');}finally{$('import-file').value='';}};
for(const j of JOBS)$('export-'+j.id).onclick=async()=>{const btn=$('export-'+j.id),old=btn.textContent;btn.disabled=true;btn.textContent='در حال ساخت…';try{const r=await apiFetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...state,jobId:j.id,month})});if(!r.ok)throw Error((await r.json()).error);download(await r.arrayBuffer(),`${j.name}_${month}.xlsx`,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');toast(`خروجی ${j.name} آماده شد.`);}catch(e){toast(e.message);}finally{btn.textContent=old;render();}};
window.addEventListener('beforeunload',e=>{if(dirty||saving){e.preventDefault();e.returnValue='';}});
// All timeline gestures use the same interval representation as the table.
let gesture=null,timelinePending=false;
const snap=n=>Math.max(0,Math.min(1440,Math.round(n/15)*15));
function pointerTime(event,track){const rect=track.getBoundingClientRect();return dayNumber(track.dataset.date)*DAY+snap((event.clientX-rect.left)/rect.width*DAY);}
function fromAbsolute(start,end){const day=Math.floor(start/DAY);return {date:dayString(day),start:timeString(start),end:timeString(end),endNextDay:Math.floor(end/DAY)>day};}
function clearGhost(){document.querySelectorAll('.draw-preview').forEach(e=>e.remove());}
function paintGhost(start,end){clearGhost();for(const track of document.querySelectorAll('.day-track')){const day=dayNumber(track.dataset.date)*DAY,s=Math.max(start,day),e=Math.min(end,day+DAY);if(s>=e)continue;const ghost=document.createElement('div');ghost.className='draw-preview';ghost.style.left=(s-day)/DAY*100+'%';ghost.style.width=(e-s)/DAY*100+'%';ghost.textContent=durationText(end-start);track.append(ghost);}}
$('timeline').addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('.calendar-block'))return;const track=e.target.closest('.day-track');if(!track)return;const block=e.target.closest('.block'),row=block&&state.entries.find(r=>r.id===block.dataset.id),v=row&&interval(row);const abs=pointerTime(e,track);gesture={id:e.pointerId,row,mode:row?(e.target.dataset.edge||'move'):'draw',anchor:abs,start:v?.start,end:v?.end,offset:v?abs-v.start:0,moved:false,x:e.clientX,y:e.clientY,lastTrack:track};$('timeline').setPointerCapture(e.pointerId);e.preventDefault();});
$('timeline').addEventListener('pointermove',e=>{if(!gesture||e.pointerId!==gesture.id)return;const under=document.elementFromPoint(e.clientX,e.clientY),track=under?.closest('.day-track')||gesture.lastTrack;if(!track)return;gesture.lastTrack=track;if(Math.abs(e.clientX-gesture.x)+Math.abs(e.clientY-gesture.y)<4&&!gesture.moved)return;gesture.moved=true;const abs=pointerTime(e,track);let start=gesture.start,end=gesture.end;if(gesture.mode==='draw'){start=Math.min(gesture.anchor,abs);end=Math.max(gesture.anchor,abs);if(end-start>DAY)end=start+DAY;}else if(gesture.mode==='move'){start=abs-gesture.offset;end=start+(gesture.end-gesture.start);}else if(gesture.mode==='start')start=Math.max(gesture.end-DAY,Math.min(abs,gesture.end-15));else end=Math.min(gesture.start+DAY,Math.max(abs,gesture.start+15));gesture.result={start,end};paintGhost(start,end);});
$('timeline').addEventListener('pointerup',e=>{if(!gesture||e.pointerId!==gesture.id)return;const g=gesture;gesture=null;clearGhost();if($('timeline').hasPointerCapture(e.pointerId))$('timeline').releasePointerCapture(e.pointerId);if(!g.moved){if(g.row)select(g.row.id);if(timelinePending)renderTimeline();return;}suppressClick=true;const r=g.result;if(!r||r.end-r.start<15){if(timelinePending)renderTimeline();return;}const fields=fromAbsolute(r.start,r.end);if(g.row){checkpoint();Object.assign(g.row,fields);selected=g.row.id;changed();}else add($('draw-job').value,fields.date,fields.start,fields.end,fields.endNextDay);});
$('timeline').addEventListener('pointercancel',()=>{gesture=null;clearGhost();if(timelinePending)renderTimeline();});
$('session-form').onsubmit=async event=>{
 event.preventDefault();const button=$('session-submit');button.disabled=true;
 try{session=await login($('session-key').value);$('session-key').value='';if(!session.authenticated)throw Error('ورود تأیید نشد.');showSession();$('session-dialog').close();await save();calendarUI.load();}
 catch(error){$('session-message').textContent=error.message;$('session-key').value='';}
 finally{button.disabled=false;}
};
$('session-dialog').addEventListener('cancel',event=>event.preventDefault());
$('session-backup').onclick=()=>download(JSON.stringify(state,null,2),'work-planner-unsaved-backup.json','application/json');
$('conflict-reload').onclick=()=>{download(JSON.stringify(state,null,2),'work-planner-conflict-backup.json','application/json');dirty=false;window.location.reload();};
$('logout-btn').onclick=async()=>{
 if(saving){toast('صبر کن تا ذخیره تمام شود.');return;}
 if(dirty){await save();if(dirty){toast('تغییرات هنوز ذخیره نشده. ابتدا پشتیبان بگیر و مشکل ذخیره را برطرف کن.');return;}}
 try{const response=await apiFetch('/api/logout',{method:'POST'});if(!response.ok)throw Error('خروج انجام نشد.');state={version:1,entries:[]};history=[];calendarData={events:[],status:{},coverage:{}};window.location.replace('/login');}catch(error){toast(error.message);}
};
try{
 session=await sessionInfo();showSession();
 if(!session.authenticated){window.location.replace('/login');}
 else{
  const response=await apiFetch('/api/state');if(!response.ok)throw Error('بارگذاری اطلاعات ممکن نشد. برای تلاش دوباره صفحه را تازه کن.');
  const data=await response.json();state=normalizeState(data);if(!Number.isSafeInteger(data.revision)||data.revision<0)throw Error('نسخهٔ اطلاعات معتبر نیست.');revision=data.revision;loaded=true;
  $('save-status').textContent=session.mode==='cloud'?'اطلاعات از فضای خصوصی آنلاین خوانده شد':'اطلاعات از این کامپیوتر خوانده شد';
  $('planner-main').inert=false;$('backup-btn').disabled=false;$('import-btn').disabled=false;render();calendarUI.load();
 }
}catch(error){$('notice').textContent=error.message;$('notice').hidden=false;$('save-status').textContent='بارگذاری انجام نشد — صفحه را تازه کن';$('save-status').className='error';}
