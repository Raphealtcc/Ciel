import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");
const start = source.indexOf("function analyzeCoreTrendContinuation(");
const endMarker = '__name(analyzeCoreTrendContinuation,"analyzeCoreTrendContinuation");';
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error("Existing core trend-continuation detector not found; refusing to patch.");
const after = end + endMarker.length;
const replacement = `function analyzeCoreTrendContinuation(symbol, fiveMinuteRows, now) {
  const rows=(Array.isArray(fiveMinuteRows)?fiveMinuteRows:[]).map(row=>({
    t:Number(row.close_ts_ms||row.open_ts_ms+300e3),o:Number(row.open_price),h:Number(row.high_price),
    l:Number(row.low_price),c:Number(row.close_price),v:Number(row.volume)||0
  })).filter(c=>c.t>0&&[c.o,c.h,c.l,c.c].every(v=>Number.isFinite(v)&&v>0)&&c.h>=c.l).sort((a,b)=>a.t-b.t);
  if(rows.length<40)return null;
  const last=rows[rows.length-1],breakout=rows[rows.length-2];
  if(now-last.t>7*60e3||last.t>now+15e3)return null;
  const emaSeries=(values,period)=>{
    if(values.length<period)return [];
    const k=2/(period+1),out=[values[0]];
    for(let i=1;i<values.length;i++)out.push(values[i]*k+out[i-1]*(1-k));
    return out;
  };
  const closes=rows.map(c=>c.c),fastSeries=emaSeries(closes,9),slowSeries=emaSeries(closes,21);
  if(fastSeries.length!==rows.length||slowSeries.length!==rows.length)return null;
  const fast=fastSeries.at(-1),slow=slowSeries.at(-1),priorFast=fastSeries.at(-2);
  const trueRanges=rows.slice(-15).map((c,i)=>{
    const previous=rows[Math.max(0,rows.length-15+i-1)]?.c??c.c;
    return Math.max(c.h-c.l,Math.abs(c.h-previous),Math.abs(c.l-previous));
  });
  const atr=trueRanges.reduce((a,b)=>a+b,0)/trueRanges.length;
  if(!(atr>0))return null;

  // Confirm actual swing structure, not merely a rising/falling moving average.
  const pivotsHigh=[],pivotsLow=[],structureRows=rows.slice(-32,-2);
  for(let i=2;i<structureRows.length-2;i++){
    const c=structureRows[i],left=structureRows.slice(i-2,i),right=structureRows.slice(i+1,i+3);
    if(left.every(x=>c.h>=x.h)&&right.every(x=>c.h>x.h))pivotsHigh.push(c.h);
    if(left.every(x=>c.l<=x.l)&&right.every(x=>c.l<x.l))pivotsLow.push(c.l);
  }
  if(pivotsHigh.length<2||pivotsLow.length<2)return null;
  const higherHighs=pivotsHigh.at(-1)>pivotsHigh.at(-2);
  const higherLows=pivotsLow.at(-1)>pivotsLow.at(-2);
  const lowerHighs=pivotsHigh.at(-1)<pivotsHigh.at(-2);
  const lowerLows=pivotsLow.at(-1)<pivotsLow.at(-2);

  // Wilder RSI(14), MACD(12,26,9), and closed-candle volume confirmation.
  const changes=closes.slice(1).map((v,i)=>v-closes[i]);
  let gains=0,losses=0;
  for(let i=0;i<14;i++){gains+=Math.max(0,changes[i]||0);losses+=Math.max(0,-(changes[i]||0));}
  gains/=14;losses/=14;
  for(let i=14;i<changes.length;i++){gains=(gains*13+Math.max(0,changes[i]))/14;losses=(losses*13+Math.max(0,-changes[i]))/14;}
  const rsi=losses===0?100:100-100/(1+gains/losses);
  const ema12=emaSeries(closes,12),ema26=emaSeries(closes,26);
  const macd=ema12.map((v,i)=>i>=25?v-ema26[i]:null).filter(v=>v!==null);
  const signal=emaSeries(macd,9);
  if(signal.length<2)return null;
  const histogram=macd.at(-1)-signal.at(-1),priorHistogram=macd.at(-2)-signal.at(-2);
  const base=rows.slice(-25,-5);
  const resistance=Math.max(...base.map(c=>c.h)),support=Math.min(...base.map(c=>c.l));
  const averageVolume=rows.slice(-21,-1).reduce((sum,c)=>sum+c.v,0)/20;
  const volumeOk=averageVolume<=0||breakout.v>=averageVolume*1.05&&last.v>=averageVolume*0.65;
  if(!volumeOk)return null;

  let side=null,pivot=0;
  const longTrend=fast>slow&&fast>priorFast&&higherHighs&&higherLows;
  const shortTrend=fast<slow&&fast<priorFast&&lowerHighs&&lowerLows;
  const longMomentum=rsi>=52&&rsi<=76&&histogram>0&&histogram>=priorHistogram;
  const shortMomentum=rsi>=24&&rsi<=48&&histogram<0&&histogram<=priorHistogram;
  const longBreakout=breakout.c>resistance+atr*0.05&&last.l<=resistance+atr*0.2&&last.l>=resistance-atr*0.4&&last.c>resistance&&last.c>last.o;
  const shortBreakout=breakout.c<support-atr*0.05&&last.h>=support-atr*0.2&&last.h<=support+atr*0.4&&last.c<support&&last.c<last.o;
  if(longTrend&&longMomentum&&longBreakout){side="LONG";pivot=Math.min(last.l,breakout.l);}
  else if(shortTrend&&shortMomentum&&shortBreakout){side="SHORT";pivot=Math.max(last.h,breakout.h);}
  if(!side)return null;

  const raw=side==="LONG"?(last.c-pivot+atr*0.1)/last.c*100:(pivot-last.c+atr*0.1)/last.c*100;
  const stopPct=Math.max(0.12,raw);
  if(!(stopPct<=0.45))return null;
  const targetPct=Math.max(0.3,stopPct*1.8);
  const bodyStrength=Math.min(0.04,Math.abs(last.c-last.o)/last.c*0.1);
  const confidence=Math.min(0.9,0.78+bodyStrength+0.02);
  return {
    symbol,side,entry:last.c,stopPct,targetPct,confidence,
    scoreComponents:["5M_EMA_TREND","5M_HIGHER_HIGHS_HIGHER_LOWS","5M_MACD_MOMENTUM","5M_RSI_MOMENTUM","5M_BREAKOUT_RETEST","5M_VOLUME_CONFIRMATION"],
    scoreModel:"core-5m-chart-confluence-v2",strategy:"5M_STRUCTURE+EMA+MACD+RSI+BREAKOUT_RETEST",
    regime:side==="LONG"?"TREND_UP":"TREND_DOWN",mode:"CORE_TREND_CONTINUATION",holdMinutes:60,
    rsi,bounce:null,cci:null,stochRsi:null,rangePositionPct:null,
    chartEvidence:{higherHighs,higherLows,lowerHighs,lowerLows,ema9:fast,ema21:slow,macdHistogram:histogram,priorMacdHistogram:priorHistogram,rsi,breakoutLevel:side==="LONG"?resistance:support,averageVolume,breakoutVolume:breakout.v,retestVolume:last.v},
    reason:"Closed 5m candles confirm swing structure, EMA9/EMA21 direction, MACD momentum, RSI regime, a volume-backed range break and a successful retest. Mixed evidence is rejected."
  };
}
__name(analyzeCoreTrendContinuation,"analyzeCoreTrendContinuation");`;
source = source.slice(0,start) + replacement + source.slice(after);
await writeFile(file,source);
console.log("Enhanced existing 5m continuation detector; scalp and trend-hold detectors were not changed.");
