import test from 'node:test';
import assert from 'node:assert/strict';
import {REGIONS,holidaysForYear,dayFlags,easterSunday} from '../public/holidays.mjs';

const holiday=(date,region,options)=>dayFlags(date,region,options).isHoliday;

test('2026 national dates match Bundesbank calendar',()=>{
  assert.deepEqual(holidaysForYear(2026,'DE').map(h=>h.date),[
    '2026-01-01','2026-04-03','2026-04-06','2026-05-01','2026-05-14',
    '2026-05-25','2026-10-03','2026-12-25','2026-12-26'
  ]);
  assert.equal(holiday('2026-12-24','DE'),false);
  assert.equal(holiday('2026-12-31','DE'),false);
});

test('Jena and Seewiesen union identifies state-specific holidays',()=>{
  assert.equal(holiday('2026-09-20','TH'),true);
  assert.equal(holiday('2026-09-20','BY'),false);
  assert.equal(holiday('2026-10-31','TH'),true);
  assert.equal(holiday('2026-10-31','BY'),false);
  assert.equal(holiday('2026-06-04','TH'),false);
  assert.equal(holiday('2026-06-04','BY'),true);
  assert.equal(holiday('2026-08-15','BY'),false);
  assert.equal(holiday('2026-08-15','BOTH'),true);
  assert.deepEqual(dayFlags('2026-08-15').holidays[0].regions,['BY']);
  assert.deepEqual(dayFlags('2026-09-20').holidays[0].regions,['TH']);
  assert.equal(holiday('2026-08-08','BOTH'),false);
  assert.equal(holiday('2026-08-15','BOTH',{assumptionDay:false}),false);
});

test('local exceptions are explicit and cannot spill into other states',()=>{
  assert.equal(holiday('2026-08-08','BY',{augsburgPeaceFestival:true}),true);
  assert.equal(holiday('2026-08-08','TH',{augsburgPeaceFestival:true}),false);
  assert.equal(holiday('2026-08-15','BY',{assumptionDay:true}),true);
  assert.equal(holiday('2026-08-15','SL'),true);
  assert.equal(holiday('2026-06-04','TH',{corpusChristiLocal:true}),true);
  const h=dayFlags('2026-06-04','BOTH',{corpusChristiLocal:true}).holidays;
  assert.equal(h.length,1);
  assert.deepEqual(h[0].regions,['BY','TH']);
});

test('all states, Brandenburg Sundays and Saxony repentance day',()=>{
  assert.equal(REGIONS.length,18);
  for(const {code} of REGIONS)assert.equal(holiday('2026-01-01',code),true);
  assert.equal(holiday('2026-04-05','BB'),true);
  assert.equal(holiday('2026-05-24','BB'),true);
  assert.equal(holiday('2026-04-05','TH'),false);
  assert.equal(holiday('2026-03-08','MV'),true);
  assert.equal(holiday('2026-03-08','BE'),true);
  assert.equal(holiday('2026-03-08','HH'),false);
  assert.equal(holiday('2026-11-18','SN'),true);
  assert.equal(holiday('2028-11-22','SN'),true);
});

test('weekends mark whole days without pretending they are public holidays',()=>{
  const saturday=dayFlags('2026-09-05','DE');
  assert.equal(saturday.weekend,true);assert.equal(saturday.red,true);assert.equal(saturday.isHoliday,false);
  assert.equal(dayFlags('2026-09-06','DE').weekend,true);
  assert.equal(dayFlags('2026-09-07','DE').red,false);
  assert.equal(dayFlags('2026-05-01','DE').weekend,false);
  assert.equal(dayFlags('2026-05-01','DE').red,true);
  assert.equal(dayFlags('2026-10-05','DE').isHoliday,false); // no substitute Monday
});

test('Gregorian Easter handles leap years and century correction exceptions',()=>{
  for(const [year,expected] of [[1954,'1954-04-18'],[1981,'1981-04-19'],[2000,'2000-04-23'],[2024,'2024-03-31'],[2026,'2026-04-05'],[2049,'2049-04-18'],[2076,'2076-04-19']]){
    assert.equal(easterSunday(year),expected);
  }
  assert.equal(dayFlags('2024-02-29','DE').weekend,false);
  assert.throws(()=>dayFlags('2026-02-29','DE'),RangeError);
  assert.throws(()=>holidaysForYear(2026,'unknown'),RangeError);
});
