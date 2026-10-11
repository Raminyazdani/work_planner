export const JOBS=[{id:'jena',name:'Jena',color:'#2667dc'},{id:'seewiesen',name:'Seewiesen',color:'#b66119'}];
export const DAY=1440;
export function dayNumber(date){
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))return NaN;
  const [y,m,d]=date.split('-').map(Number),n=Date.UTC(y,m-1,d)/86400000;
  return new Date(n*86400000).toISOString().slice(0,10)===date?n:NaN;
}
export function dayString(n){return new Date(n*86400000).toISOString().slice(0,10);}
export function parseTime(value){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value||''))return NaN;const [h,m]=value.split(':').map(Number);return h*60+m;}
export function timeString(n){n=((n%DAY)+DAY)%DAY;return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;}
export function durationText(n){return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;}
export function interval(row){
  const day=dayNumber(row.date),s=parseTime(row.start),e=parseTime(row.end);
  if(!Number.isFinite(day))return {error:'تاریخ را وارد کن'};
  if(!Number.isFinite(s)||!Number.isFinite(e))return {error:'ساعت شروع و پایان را وارد کن'};
  const duration=e-s+(row.endNextDay?DAY:0);
  if(duration<=0)return {error:row.endNextDay?'پایان باید بعد از شروع باشد':'پایان زودتر است؛ «روز بعد» را انتخاب کن'};
  if(duration>DAY)return {error:'هر بازه باید حداکثر ۲۴ ساعت باشد'};
  return {start:day*DAY+s,end:day*DAY+s+duration,duration};
}
export function monthBounds(month){
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw new Error('Invalid month');
  const [y,m]=month.split('-').map(Number);
  return {start:Date.UTC(y,m-1,1)/60000,end:Date.UTC(y,m,1)/60000};
}
export function daysInMonth(month){const b=monthBounds(month);return Array.from({length:(b.end-b.start)/DAY},(_,i)=>dayString(b.start/DAY+i));}
export function splitEntry(row,month){
  const v=interval(row);if(v.error)return [];
  const bounds=month?monthBounds(month):{start:v.start,end:v.end};
  let start=Math.max(v.start,bounds.start),end=Math.min(v.end,bounds.end),result=[];
  while(start<end){const day=Math.floor(start/DAY),stop=Math.min(end,(day+1)*DAY);result.push({id:row.id,jobId:row.jobId,date:dayString(day),start:start-day*DAY,end:stop-day*DAY,duration:stop-start,tasks:row.tasks||'',original:row});start=stop;}
  return result;
}
export function visibleEntries(entries,month){const b=monthBounds(month);return entries.filter(row=>{const v=interval(row);return v.error?(!row.date||row.date.startsWith(month)):v.start<b.end&&v.end>b.start;});}
export function analyze(entries,month){
  const b=monthBounds(month),valid=entries.map(row=>({row,...interval(row)})).filter(v=>!v.error&&v.start<b.end&&v.end>b.start);
  const pairs=[],byId=new Map(),spans=[];
  for(let i=0;i<valid.length;i++)for(let j=i+1;j<valid.length;j++){
    const a=valid[i],c=valid[j],start=Math.max(a.start,c.start,b.start),end=Math.min(a.end,c.end,b.end);
    if(start<end){const pair={a:a.row.id,b:c.row.id,start,end,minutes:end-start};pairs.push(pair);spans.push([start,end]);for(const id of [pair.a,pair.b])byId.set(id,[...(byId.get(id)||[]),pair]);}
  }
  spans.sort((a,c)=>a[0]-c[0]);let conflictMinutes=0,last=null;
  for(const span of spans){if(last&&span[0]<=last[1])last[1]=Math.max(last[1],span[1]);else{if(last)conflictMinutes+=last[1]-last[0];last=[...span];}}if(last)conflictMinutes+=last[1]-last[0];
  const totals=Object.fromEntries(JOBS.map(j=>[j.id,0]));for(const v of valid)totals[v.row.jobId]+=Math.min(v.end,b.end)-Math.max(v.start,b.start);
  return {pairs,byId,conflictMinutes,totals,invalid:visibleEntries(entries,month).filter(r=>interval(r).error)};
}
export function normalizeState(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||!Array.isArray(input.entries)||input.entries.length>5000)throw new Error('Invalid data');
  const ids=new Set();const entries=input.entries.map(r=>{
    if(!r||typeof r!=='object'||Array.isArray(r)||typeof r.id!=='string'||!/^[-_A-Za-z0-9]{1,80}$/.test(r.id)||ids.has(r.id)||!JOBS.some(j=>j.id===r.jobId))throw new Error('Invalid entry');ids.add(r.id);
    for(const key of ['date','start','end','tasks'])if(r[key]!==undefined&&typeof r[key]!=='string')throw new Error('Invalid entry format');
    if(r.endNextDay!==undefined&&typeof r.endNextDay!=='boolean')throw new Error('Invalid next-day flag');
    const row={id:r.id,jobId:r.jobId,date:r.date??'',start:r.start??'',end:r.end??'',endNextDay:r.endNextDay??false,tasks:r.tasks??''};
    // Incomplete time inputs are saved as drafts; interval() validates calculations and export.
    if((row.date&&!Number.isFinite(dayNumber(row.date)))||!/^\d{0,2}:?\d{0,2}$/.test(row.start)||!/^\d{0,2}:?\d{0,2}$/.test(row.end)||row.start.length>5||row.end.length>5||row.tasks.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.tasks))throw new Error('Invalid entry format');return row;
  });
  return {version:1,entries};
}
