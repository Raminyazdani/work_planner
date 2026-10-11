import {dayNumber,dayString} from './core.mjs';

/**
 * Offline calendar of recurring German public holidays, checked 2026-10-08.
 * Dates use civil calendar days, independent of the computer's time zone.
 * This applies the current recurring rules to the selected year; it is not a
 * historical legislation database and does not infer whether someone may work.
 * One-off holidays and employer-specific days off are intentionally not inferred.
 *
 * Official sources:
 * - Bundesbank, national and state holidays in 2026:
 *   https://www.bundesbank.de/de/aufgaben/unbarer-zahlungsverkehr/target/feiertagskalender-2026-749314
 * - Bavaria FTG Art. 1, including municipality-specific Assumption / Augsburg:
 *   https://www.gesetze-bayern.de/Content/Document/BayFTG/true
 * - Bavaria statistics, Pöcking = "ja" for Assumption, effective from 2025:
 *   https://www.statistik.bayern.de/statistik/gebiet_bevoelkerung/zensus/himmelfahrt/index.php?Suchfeld=gemeindename&feiertag=ja&sort=gemeindename
 * - Municipality confirms Seewiesen is a district of Pöcking:
 *   https://www.poecking.de/unsere-gemeinde/lernen-sie-uns-kennen/ortsteile
 * - Brandenburg FTG § 2 additionally lists Easter / Pentecost Sundays:
 *   https://bravors.brandenburg.de/gesetze/ftg_2015
 */

export const DEFAULT_REGION='BOTH';
export const REGIONS=Object.freeze([
  {code:'BOTH',name:'Jena + Seewiesen (TH + BY / Pöcking)'},
  {code:'DE',name:'Deutschland — bundesweit'},
  {code:'BW',name:'Baden-Württemberg'},{code:'BY',name:'Bayern'},
  {code:'BE',name:'Berlin'},{code:'BB',name:'Brandenburg'},
  {code:'HB',name:'Bremen'},{code:'HH',name:'Hamburg'},
  {code:'HE',name:'Hessen'},{code:'MV',name:'Mecklenburg-Vorpommern'},
  {code:'NI',name:'Niedersachsen'},{code:'NW',name:'Nordrhein-Westfalen'},
  {code:'RP',name:'Rheinland-Pfalz'},{code:'SL',name:'Saarland'},
  {code:'SN',name:'Sachsen'},{code:'ST',name:'Sachsen-Anhalt'},
  {code:'SH',name:'Schleswig-Holstein'},{code:'TH',name:'Thüringen'}
].map(Object.freeze));

export const HOLIDAY_SOURCES=Object.freeze([
  {name:'Deutsche Bundesbank: Feiertage 2026',url:'https://www.bundesbank.de/de/aufgaben/unbarer-zahlungsverkehr/target/feiertagskalender-2026-749314'},
  {name:'Bayern: Feiertagsgesetz Art. 1',url:'https://www.gesetze-bayern.de/Content/Document/BayFTG/true'},
  {name:'Bayerisches Landesamt für Statistik: Mariä Himmelfahrt (Pöcking)',url:'https://www.statistik.bayern.de/statistik/gebiet_bevoelkerung/zensus/himmelfahrt/index.php?Suchfeld=gemeindename&feiertag=ja&sort=gemeindename'},
  {name:'Pöcking: Ortsteil Seewiesen',url:'https://www.poecking.de/unsere-gemeinde/lernen-sie-uns-kennen/ortsteile'},
  {name:'Brandenburg: Feiertagsgesetz § 2',url:'https://bravors.brandenburg.de/gesetze/ftg_2015'}
].map(Object.freeze));

function validYear(year){
  if(!Number.isInteger(year)||year<1583||year>9999)throw new RangeError('Expected a Gregorian calendar year from 1583 to 9999');
}

/** Gregorian Easter Sunday (Meeus/Jones/Butcher computation). */
export function easterSunday(year){
  validYear(year);
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4;
  const f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3);
  const h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4;
  const l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);
  const n=h+l-7*m+114;
  return `${year}-${String(Math.floor(n/31)).padStart(2,'0')}-${String(n%31+1).padStart(2,'0')}`;
}

/**
 * Return sorted {date, name, regions, local} holiday records.
 * region: DE (national), one of the 16 state codes, or BOTH (TH + BY/Pöcking).
 * options.assumptionDay: include Bavaria's local Aug 15 holiday; defaults to
 * true for BOTH because Seewiesen belongs to Pöcking, otherwise false.
 * options.augsburgPeaceFestival: include Aug 8 in Augsburg only (default false).
 * options.corpusChristiLocal: include local Corpus Christi in TH/SN (false).
 * A union record's regions tells the UI which selected state(s) observe it;
 * DE indicates a holiday shared by all states.
 */
export function holidaysForYear(year,region=DEFAULT_REGION,options={}){
  validYear(year);
  region=String(region).toUpperCase();
  if(!REGIONS.some(r=>r.code===region))throw new RangeError('Unknown German holiday region');
  const selected=region==='BOTH'?['TH','BY']:[region];
  const assumptionDay=options.assumptionDay??(region==='BOTH');
  const easter=dayNumber(easterSunday(year));
  const result=[];
  const add=(date,name,regions=['DE'],local=false)=>{
    const matched=regions[0]==='DE'?regions:regions.filter(r=>selected.includes(r));
    if(matched.length)result.push({date,name,regions:matched,local});
  };
  const fixed=(md,name,regions,local)=>add(`${year}-${md}`,name,regions,local);
  const relative=(offset,name,regions,local)=>add(dayString(easter+offset),name,regions,local);
  fixed('01-01','Neujahr');
  relative(-2,'Karfreitag');
  relative(1,'Ostermontag');
  fixed('05-01','Tag der Arbeit');
  relative(39,'Christi Himmelfahrt');
  relative(50,'Pfingstmontag');
  fixed('10-03','Tag der Deutschen Einheit');
  fixed('12-25','1. Weihnachtsfeiertag');
  fixed('12-26','2. Weihnachtsfeiertag');
  fixed('01-06','Heilige Drei Könige',['BW','BY','ST']);
  fixed('03-08','Internationaler Frauentag',['BE','MV']);
  relative(0,'Ostersonntag',['BB']);
  relative(49,'Pfingstsonntag',['BB']);
  relative(60,'Fronleichnam',['BW','BY','HE','NW','RP','SL']);
  if(options.corpusChristiLocal)relative(60,'Fronleichnam',['SN','TH'],true);
  fixed('08-15','Mariä Himmelfahrt',['SL']);
  if(assumptionDay)fixed('08-15','Mariä Himmelfahrt',['BY'],true);
  if(options.augsburgPeaceFestival)fixed('08-08','Augsburger Friedensfest',['BY'],true);
  fixed('09-20','Weltkindertag',['TH']);
  fixed('10-31','Reformationstag',['BB','HB','HH','MV','NI','SN','ST','SH','TH']);
  fixed('11-01','Allerheiligen',['BW','BY','NW','RP','SL']);
  // Wednesday strictly before Nov 23, so the date is always Nov 16..22.
  let repentance=dayNumber(`${year}-11-22`);
  while(new Date(repentance*86400000).getUTCDay()!==3)repentance--;
  add(dayString(repentance),'Buß- und Bettag',['SN']);
  const merged=new Map();
  for(const item of result){
    const key=`${item.date}|${item.name}`,existing=merged.get(key);
    if(existing){existing.regions=[...new Set([...existing.regions,...item.regions])];existing.local&&=item.local;}
    else merged.set(key,item);
  }
  return [...merged.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.name.localeCompare(b.name));
}

/** Full-row styling can use red; title/legend can use names and regions. */
export function dayFlags(date,region=DEFAULT_REGION,options={}){
  const day=dayNumber(date);
  if(!Number.isFinite(day))throw new RangeError('Expected a valid ISO calendar date');
  const weekday=new Date(day*86400000).getUTCDay();
  const holidays=holidaysForYear(Number(date.slice(0,4)),region,options).filter(h=>h.date===date);
  const weekend=weekday===0||weekday===6,isHoliday=holidays.length>0;
  return {date,weekend,isHoliday,red:weekend||isHoliday,names:holidays.map(h=>h.name),holidays};
}
