import {createApp} from '../lib/app.mjs';
let app;
export default async function handler(req,res){
  try{app||=createApp();await (await app)(req,res);}
  catch{app=undefined;res.statusCode=503;res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'Private deployment is not configured. Check server environment settings.'}));}
}
