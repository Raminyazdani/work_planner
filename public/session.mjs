// Session cookies are HttpOnly; credentials never enter browser storage.
export async function responseError(response,fallback){
  let value;try{value=await response.json();}catch{}
  const storageUnavailable=response.status===503&&value?.code==='STORAGE_UNAVAILABLE';
  const header=response.headers?.get('Retry-After'),seconds=Number(header);
  const delay=header?(Number.isFinite(seconds)?seconds*1000:Date.parse(header)-Date.now()):0;
  return Object.assign(new Error(storageUnavailable?(value.error||'فضای ذخیره‌سازی موقتاً در دسترس نیست. تغییرات این صفحه محفوظ است.'):fallback),{
    code:storageUnavailable?'STORAGE_UNAVAILABLE':undefined,
    retryable:response.status>=500||response.status===429,
    retryAfterMs:Math.max(storageUnavailable?300000:0,Number.isFinite(delay)?delay:0)
  });
}
export async function sessionInfo(){
  const response=await fetch('/api/session',{cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw await responseError(response,'وضعیت ورود دریافت نشد. دوباره تلاش کن.');
  const value=await response.json();
  if(!value||typeof value.authenticated!=='boolean'||typeof value.authRequired!=='boolean'||!['local','cloud'].includes(value.mode))throw new Error('پاسخ برنامه معتبر نیست.');
  return value;
}
export async function login(accessKey){
  const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessKey}),cache:'no-store',credentials:'same-origin'});
  if(!response.ok){
    if(response.status===429)throw new Error('تلاش‌های ورود زیاد بوده؛ کمی بعد دوباره امتحان کن.');
    if(response.status===401||response.status===403)throw new Error('کلید دسترسی درست نیست.');
    throw await responseError(response,'ورود انجام نشد. اتصال و تنظیمات برنامه را بررسی کن.');
  }
  return sessionInfo();
}
