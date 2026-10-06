#!/usr/bin/env node
// Generate documentation figures from the production geometry and SVG renderer.
import { mkdir, writeFile } from 'node:fs/promises';
import { clonePreset } from '../assets/core/presets.js';
import { bucketLocalShape } from '../assets/core/geometry.js';
import { computeMetrics } from '../assets/core/metrics.js';
import { computeEnvelope, computeMinSwingRadius } from '../assets/core/envelope.js';
import { renderChart } from '../assets/ui/draw.js';

const dir=new URL('../docs/images/',import.meta.url);
await mkdir(dir,{recursive:true});
const p=clonePreset('E215HC4488A06A0');
const {values,poses}=computeMetrics(p);
const env=computeEnvelope(p);
const minSwingRadius=computeMinSwingRadius(p);
values.minSwingRadius=minSwingRadius;
const view={showEnvelope:true,showDims:true,showBody:true,showTailCircle:true,poseMode:'custom',customPose:{},
  dimKeys:['maxDigRadius','groundMaxRadius','maxDigHeight','dumpHeight','maxDigDepth','minSwingRadius']};
for(const style of ['outline','schematic']) {
  const svg=renderChart({W:1100,H:900,p,values,poses,env,view:{...view,style},minSwingRadius});
  await writeFile(new URL(`chart-${style}.svg`,dir),svg+'\n');
}

const n=v=>Number(v.toFixed(2));
const font='Microsoft YaHei, Segoe UI, sans-serif';
const svg=(w,h,body,title)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${title}"><title>${title}</title><rect width="${w}" height="${h}" fill="white"/><g font-family="${font}" fill="#172033">${body}</g></svg>\n`;
const text=(x,y,t,size=18,attrs='')=>`<text x="${n(x)}" y="${n(y)}" font-size="${size}" ${attrs}>${t}</text>`;
const line=(a,b,color='#94a3b8',width=1,attrs='')=>`<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke="${color}" stroke-width="${width}" ${attrs}/>`;
const dot=(q,color,r=6)=>`<circle cx="${n(q.x)}" cy="${n(q.y)}" r="${r}" fill="${color}" stroke="white" stroke-width="2"/>`;

// Bucket outline: all vertices come from bucketLocalShape; labelled coordinates are mm.
const shape=bucketLocalShape(p).map(([x,y])=>({x:x*p.bucketRadius,y:y*p.bucketRadius}));
const minX=Math.min(...shape.map(q=>q.x)),maxX=Math.max(...shape.map(q=>q.x));
const minY=Math.min(...shape.map(q=>q.y)),maxY=Math.max(...shape.map(q=>q.y));
const scale=Math.min(790/(maxX-minX),390/(maxY-minY));
const X=x=>110+(x-minX)*scale, Y=y=>140+(maxY-y)*scale;
const bucketPoints=shape.map(q=>({x:X(q.x),y:Y(q.y)}));
const C={x:X(0),y:Y(0)},T={x:X(p.bucketRadius),y:Y(0)},E={x:X(p.bktEAlong),y:Y(p.bktEPerp)};
let body=text(40,42,'E215 铲斗轮廓与三个特征点',25,'font-weight="700"')+
  text(40,77,'由 C、T、E 的局部坐标生成切半圆轮廓；长度单位为 mm',16,'fill="#64748b"');
body+=`<polygon points="${bucketPoints.map(q=>`${n(q.x)},${n(q.y)}`).join(' ')}" fill="#e2e8f0" stroke="#334155" stroke-width="3"/>`;
body+=line(C,T,'#2563eb',4)+line(C,E,'#0891b2',4)+dot(C,'#dc2626')+dot(T,'#2563eb')+dot(E,'#0891b2');
body+=text(C.x+12,C.y+31,'C (0, 0)',18,'fill="#dc2626"')+text(T.x-138,T.y+31,'T (1504, 0)',18,'fill="#2563eb"')+
  text(E.x-40,E.y-18,'E (−112, 453)',18,'fill="#0891b2"');
body+=text(40,592,'C：铲斗铰点　　T：斗齿尖　　E：连杆–铲斗铰点',18)+
  text(40,627,'C–T 是保留的直边；C–E 是切除线；E 位于圆弧与切除线的交点。',16,'fill="#64748b"');
await writeFile(new URL('bucket-shape.svg',dir),svg(1020,660,body,'E215 铲斗切半圆轮廓'));

// Plot the exact sampled nine-arc sequence; no visual smoothing or curve fitting.
const raw=computeEnvelope(p,{stepDeg:.25,tol:0});
const bounds=raw.bounds;
const extent={minX:Math.min(-1000,bounds.minX)-500,maxX:bounds.maxX+500,minY:bounds.minY-500,maxY:bounds.maxY+500};
const s=Math.min(800/(extent.maxX-extent.minX),850/(extent.maxY-extent.minY));
const ox=65+(800-(extent.maxX-extent.minX)*s)/2-extent.minX*s;
const oy=125+(850-(extent.maxY-extent.minY)*s)/2+extent.maxY*s;
const P=q=>({x:ox+q.x*s,y:oy-q.y*s});
const colors=['#2563eb','#0284c7','#f97316','#0d9488','#7c3aed','#db2777','#d97706','#65a30d','#475569'];
const labels=['①','②','③','④','⑤','⑥','⑦','⑧','⑨'];
const actions=['顺时针转铲斗 · 伸缸','顺时针转动臂 · 缩缸','顺时针转铲斗 · 伸缸','顺时针转斗杆 · 伸缸','顺时针转铲斗 · 伸缸',
  '逆时针转动臂 · 伸缸','顺时针转铲斗 · 伸缸','逆时针转斗杆 · 缩缸','逆时针转铲斗 · 缩缸'];
const ends=['A–C–T 共线','动臂缸全缩','B–C–T 共线（T 在 C 外侧）','斗杆缸全伸','A–T–C 共线','动臂缸全伸','铲斗缸全伸','斗杆缸全缩','铲斗缸全缩，回到起点'];
body=text(42,48,'E215：九段圆弧作图顺序',28,'font-weight="700"')+
  text(42,87,'起始位置：动臂缸全伸，斗杆缸与铲斗缸全缩；每段只动一根油缸',18,'fill="#64748b"');
for(let y=-6000;y<=10000;y+=2000) {
  body+=line(P({x:extent.minX,y}),P({x:extent.maxX,y}),'#edf1f6')+
    text(51,P({x:0,y}).y+5,String(y/1000),14,'text-anchor="end" fill="#94a3b8"');
}
for(let x=0;x<=10000;x+=2000) {
  body+=line(P({x,y:extent.minY}),P({x,y:extent.maxY}),'#edf1f6')+
    text(P({x,y:0}).x,1008,String(x/1000),14,'text-anchor="middle" fill="#94a3b8"');
}
body+=line(P({x:extent.minX,y:0}),P({x:extent.maxX,y:0}),'#94a3b8',1.5)+
  text(58,1048,'坐标单位：m；圆弧编号按运动顺序排列',16,'fill="#64748b"');
const offsets=[[54,-24],[42,0],[60,30],[-48,28],[-58,18],[-55,-12],[-60,-8],[-42,-30],[55,-10]];
raw.segments.forEach((seg,i)=>{
  const start=seg.ptFrom===0?0:seg.ptFrom-1;
  const pts=raw.outer.slice(start,seg.ptTo+1).map(P);
  body+=`<polyline points="${pts.map(q=>`${n(q.x)},${n(q.y)}`).join(' ')}" fill="none" stroke="${colors[i]}" stroke-width="4" stroke-linejoin="round"/>`;
  const mid=pts[Math.floor(pts.length/2)],end=pts[Math.min(pts.length-1,Math.floor(pts.length/2)+1)];
  const direction=Math.atan2(end.y-mid.y,end.x-mid.x), tip={x:mid.x+9*Math.cos(direction),y:mid.y+9*Math.sin(direction)};
  const left={x:mid.x-5*Math.cos(direction)+4*Math.sin(direction),y:mid.y-5*Math.sin(direction)-4*Math.cos(direction)};
  const right={x:mid.x-5*Math.cos(direction)-4*Math.sin(direction),y:mid.y-5*Math.sin(direction)+4*Math.cos(direction)};
  body+=`<polygon points="${[tip,left,right].map(q=>`${n(q.x)},${n(q.y)}`).join(' ')}" fill="${colors[i]}"/>`;
  const badge={x:mid.x+offsets[i][0],y:mid.y+offsets[i][1]};
  body+=line(mid,badge,colors[i],1)+dot(badge,colors[i],18)+text(badge.x,badge.y+7,labels[i],23,'text-anchor="middle" fill="white"');
  const y=152+i*75;
  body+=text(937,y,labels[i],25,`fill="${colors[i]}" font-weight="700"`)+text(982,y,actions[i],19)+
    text(982,y+29,'终止：'+ends[i],17,'fill="#64748b"');
});
const first=P(raw.outer[0]);
body+=dot(first,'#0f172a',5)+text(first.x-16,first.y-14,'起点 / 终点',15,'text-anchor="end"');
body+=`<rect x="929" y="841" width="426" height="152" rx="12" fill="#f8fafc" stroke="#e2e8f0"/>`+
  text(949,875,'③：先转铲斗至 B–C–T 共线',20,'font-weight="700"')+
  text(949,910,'④：以③末姿态绕 B 转动斗杆。',18)+
  text(949,942,'斗杆圆弧半径：2900 + 1504 = 4404 mm',17)+text(949,974,'圆弧直接取自当前计算模型。',16,'fill="#64748b"');
await writeFile(new URL('envelope-nine-arcs.svg',dir),svg(1400,1100,body,'E215 九段圆弧作图顺序'));
console.log('已生成 4 张模型示例：实体外形、机构简图、铲斗轮廓、九段圆弧。');
