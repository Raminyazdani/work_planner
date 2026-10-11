import {normalizeState} from './core.mjs';
import {mergeEntries} from './merge.mjs';

const copy=value=>structuredClone(value);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function readState(value){
  if(!Number.isSafeInteger(value?.revision)||value.revision<0)throw Error('نسخهٔ اطلاعات معتبر نیست.');
  return {...normalizeState(value),revision:value.revision};
}
class RequestError extends Error{
  constructor(message,retryable=false){super(message);this.retryable=retryable;}
}

// Only one request chain may run at a time. The acknowledged base is the exact
// sent snapshot, never a newer editor value typed while the request was pending.
export class PlannerSync{
  constructor({request,getEntries,setEntries,onStatus=()=>{},onRebase=()=>{}}){
    Object.assign(this,{request,getEntries,setEntries,onStatus,onRebase});
    this.base=[];this.revision=0;this.conflicts=[];this.active=null;this.uncertain=null;
  }
  initialize(value){const state=readState(value);this.base=copy(state.entries);this.revision=state.revision;this.conflicts=[];}
  get dirty(){return !equal(this.base,this.getEntries())||!!this.uncertain||!!this.conflicts.length;}
  async response(route,options){
    let response;
    try{response=await this.request(route,options);}catch(error){if(error.authRequired)throw error;throw new RequestError('ارتباط برقرار نشد؛ تغییرات این صفحه محفوظ است و دوباره تلاش می‌کنیم.',true);}
    if(!response.ok&&response.status!==409)throw new RequestError(response.status===401?'برای ادامه دوباره وارد شو.':'ذخیره انجام نشد؛ تغییرات این صفحه محفوظ است.',response.status>=500||response.status===429);
    return response;
  }
  async pull(){
    const response=await this.response('/api/state');
    if(!response.ok)throw new RequestError('دریافت آخرین اطلاعات ممکن نشد.',true);
    const remote=readState(await response.json());
    // A successful write can outlive a lost response. Recognize our exact
    // snapshot before merging edits that were made after that request started.
    const previous=this.uncertain&&equal(remote.entries,this.uncertain.entries)?this.uncertain.entries:this.base;
    const result=mergeEntries(previous,this.getEntries(),remote.entries);
    if(!equal(previous,remote.entries))this.onRebase(copy(previous),copy(remote.entries));
    this.base=copy(remote.entries);this.revision=remote.revision;this.uncertain=null;
    this.conflicts=result.conflicts;
    if(!equal(result.entries,this.getEntries()))this.setEntries(result.entries);
    return !this.conflicts.length;
  }
  run(refresh){
    if(this.active)return this.active;
    if(this.conflicts.length){this.onStatus({state:'conflict',conflicts:this.conflicts});return Promise.resolve(false);}
    // Defer execution so active is set even when there is no pending work.
    this.active=Promise.resolve().then(async()=>{
      this.onStatus({state:'working'});
      try{
        if(refresh||this.uncertain)await this.pull();
        for(let attempt=0;attempt<8;attempt++){
          if(this.conflicts.length){this.onStatus({state:'conflict',conflicts:this.conflicts});return false;}
          if(!this.dirty){this.onStatus({state:'saved'});return true;}
          const snapshot=copy(this.getEntries()),revision=this.revision;
          let response;
          try{
            response=await this.response('/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1,entries:snapshot,revision})});
          }catch(error){if(error.retryable)this.uncertain={entries:snapshot};throw error;}
          if(response.status===409){await this.pull();continue;}
          let ack;
          try{ack=await response.json();if(ack.revision!==revision+1)throw Error();}
          catch{this.uncertain={entries:snapshot};throw new RequestError('تأیید ذخیره دریافت نشد؛ وضعیت سرور را دوباره بررسی می‌کنیم.',true);}
          this.base=snapshot;this.revision=ack.revision;this.uncertain=null;
          // Read the editor again; a later edit or deletion must follow this ack.
        }
        throw new RequestError('تغییرات در حال هماهنگ‌شدن است؛ دوباره تلاش می‌کنیم.',true);
      }catch(error){this.onStatus({state:error.retryable?'retry':'error',message:error.message});return false;}
      finally{this.active=null;}
    });
    return this.active;
  }
  save(){return this.run(false);}
  refresh(){return this.run(true);}
  resolve(id,choice){
    if(!['local','remote'].includes(choice))throw Error('Invalid conflict choice');
    const conflict=this.conflicts.find(c=>c.id===id);if(!conflict)return;
    if(choice==='remote'){
      const entries=copy(this.getEntries()),index=entries.findIndex(e=>e.id===id);
      if(index>=0)entries.splice(index,1,...(conflict.remote?[copy(conflict.remote)]:[]));
      else if(conflict.remote)entries.push(copy(conflict.remote));
      this.setEntries(entries);
    }
    this.conflicts=this.conflicts.filter(c=>c.id!==id);
    this.onStatus({state:this.conflicts.length?'conflict':'resolved',conflicts:this.conflicts});
  }
}
