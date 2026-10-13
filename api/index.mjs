import {createApp} from '../lib/app.mjs';
let app;
export default async function handler(req,res){
  try{app||=createApp();await (await app)(req,res);}
  catch{app=undefined;if(res.headersSent)return res.end();res.statusCode=503;res.setHeader('Cache-Control','no-store');res.setHeader('Retry-After','30');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:'APP_UNAVAILABLE',error:'برنامه فعلاً راه‌اندازی نشد. تنظیمات و سرویس‌های سمت سرور باید بررسی شوند.'}));}
}
