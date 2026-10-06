#!/usr/bin/env node
// Independently validate the prescribed nine single-cylinder arcs for every preset.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { PRESETS } from '../assets/core/presets.js';
import { solvePose } from '../assets/core/geometry.js';
import { boomAngleFromLength, armDeltaFromLength, bucketPsiFromLength,
  boomCylLength, armCylLength, bucketCylLength, cylinderPose } from '../assets/core/cylinders.js';
import { computeEnvelope } from '../assets/core/envelope.js';

const sub = (a,b) => ({x:a.x-b.x,y:a.y-b.y});
const dot = (a,b) => a.x*b.x+a.y*b.y;
const cross = (a,b) => a.x*b.y-a.y*b.x;
const norm = a => Math.hypot(a.x,a.y);
const deg = a => a*180/Math.PI;
const near = (a,b,t=1e-6) => assert.ok(Math.abs(a-b)<=t, `${a} != ${b}; tolerance ${t}`);
const lengths = (p,q) => {
  const pose=solvePose(p,...q), pins=cylinderPose(p,pose);
  const out=[pins.boom,pins.arm,pins.bucket].map(c=>norm(sub(c.rod,c.body)));
  [boomCylLength(p,q[0]),armCylLength(p,q[1]),bucketCylLength(p,q[2])].forEach((l,i)=>near(l,out[i]));
  return out;
};
const which=['bucket','boom','bucket','arm','bucket','boom','bucket','arm','bucket'];
const moving=[2,0,2,1,2,0,2,1,2];
const rotationSigns=[-1,-1,-1,-1,-1,1,-1,1,1];
const lengthSigns=[1,-1,1,1,1,1,1,-1,-1];
const results=[];

for(const p of PRESETS) {
  const lo=[p.boomCylClosed,p.armCylClosed,p.bktCylClosed];
  const hi=[lo[0]+p.boomCylStroke,lo[1]+p.armCylStroke,lo[2]+p.bktCylStroke];
  const a0=boomAngleFromLength(p,lo[0]), a1=boomAngleFromLength(p,hi[0]);
  const d0=armDeltaFromLength(p,lo[1]), d1=armDeltaFromLength(p,hi[1]);
  const s0=bucketPsiFromLength(p,lo[2]), s1=bucketPsiFromLength(p,hi[2]);
  // Derive the requested alignment directly from the A→C ray, independent of envelope.alignPsi.
  const align=(a,d,inward)=>{
    const pose=solvePose(p,a,d,0), v=sub(pose.C,pose.A);
    let psi=deg(Math.atan2(v.y,v.x))+(inward?180:0)-a-d;
    const center=(s0+s1)/2;
    while(psi-center>180) psi-=360;
    while(psi-center< -180) psi+=360;
    assert.ok(psi>=Math.min(s0,s1) && psi<=Math.max(s0,s1), `${p.id}: requested alignment is outside stroke`);
    return psi;
  };
  const u=align(a1,d0,false), v=align(a0,d1,true);
  // B→C and C→T share their direction exactly when psi = 0 (B–C–T).
  assert.ok(s1 <= 0 && s0 >= 0, `${p.id}: B–C–T must be reachable within bucket stroke`);
  const q=[[a1,d0,s0],[a1,d0,u],[a0,d0,u],[a0,d0,0],[a0,d1,0],[a0,d1,v],
    [a1,d1,v],[a1,d1,s1],[a1,d0,s1],[a1,d0,s0]];
  const env=computeEnvelope(p,{stepDeg:.1,tol:0});
  assert.equal(env.segments.length,9);
  near(norm(sub(env.outer[0],solvePose(p,...q[0]).T)),0);
  const startLengths=lengths(p,q[0]);
  [hi[0],lo[1],lo[2]].forEach((l,j)=>near(l,startLengths[j]));
  const segments=[];
  for(let i=0;i<which.length;i++) {
    const seg=env.segments[i], k=moving[i], from=q[i][k], to=q[i+1][k];
    assert.equal(seg.which,which[i]);
    assert.equal(seg.index,i+1);
    if(i>0) assert.equal(seg.ptFrom,env.segments[i-1].ptTo+1, `${p.id} segment ${i+1}: discontinuous point indices`);
    near(seg.from,from,.000501); near(seg.to,to,.000501);
    assert.equal(Math.sign(to-from),rotationSigns[i]);
    const start=solvePose(p,...q[i]), pivot=start[k===0?'A':k===1?'B':'C'];
    const zero=q[i].slice(); zero[k]=0;
    const ref=sub(solvePose(p,...zero).T,pivot), radius=norm(ref);
    const first=seg.ptFrom===0?0:seg.ptFrom-1;
    const initialLengths=lengths(p,q[i]);
    let maxCircleError=0,maxFixedLengthDrift=0,previousAngle=from,previousLength=initialLengths[k];
    for(let j=first;j<=seg.ptTo;j++) {
      const point=env.outer[j], radial=sub(point,pivot);
      maxCircleError=Math.max(maxCircleError,Math.abs(norm(radial)-radius));
      let theta=deg(Math.atan2(cross(ref,radial),dot(ref,radial)));
      const mid=(from+to)/2;
      while(theta-mid>180) theta-=360;
      while(theta-mid< -180) theta+=360;
      assert.ok(theta>=Math.min(from,to)-1e-8 && theta<=Math.max(from,to)+1e-8);
      assert.ok((theta-previousAngle)*rotationSigns[i]>=-1e-8);
      previousAngle=theta;
      const sample=q[i].slice(); sample[k]=theta;
      near(norm(sub(solvePose(p,...sample).T,point)),0);
      const L=lengths(p,sample);
      for(let m=0;m<3;m++) {
        assert.ok(L[m]>=lo[m]-1e-6 && L[m]<=hi[m]+1e-6, `${p.id} segment ${i+1}: cylinder ${m} outside stroke`);
        if(m!==k) maxFixedLengthDrift=Math.max(maxFixedLengthDrift,Math.abs(L[m]-initialLengths[m]));
      }
      assert.ok((L[k]-previousLength)*lengthSigns[i]>=-1e-6);
      previousLength=L[k];
    }
    near(maxCircleError,0); near(maxFixedLengthDrift,0);
    near(previousAngle,to); near(norm(sub(env.outer[seg.ptTo],solvePose(p,...q[i+1]).T)),0);
    const endLengths=lengths(p,q[i+1]);
    const target=[null,lo[0],null,hi[1],null,hi[0],hi[2],lo[1],lo[2]][i];
    if(target!==null) near(endLengths[k],target);
    segments.push({segment:i+1,action:which[i],rotation:rotationSigns[i]<0?'顺时针':'逆时针',
      cylinderDirection:lengthSigns[i]>0?'伸出':'缩回',angleFromDeg:from,angleToDeg:to,
      endCylinderLengthsMm:endLengths,radiusMm:radius,samples:seg.ptTo-first+1,
      maxCircleErrorMm:maxCircleError,maxFixedLengthDriftMm:maxFixedLengthDrift,passed:true});
  }
  const collinear=[];
  for(const [i,anchor,inward] of [[1,'A',false],[3,'B',false],[5,'A',true]]) {
    const pose=solvePose(p,...q[i]), ac=sub(pose.C,pose[anchor]), at=sub(pose.T,pose[anchor]);
    const error=Math.abs(cross(ac,at))/norm(ac), projection=dot(ac,at)/dot(ac,ac);
    near(error,0);
    assert.ok(inward?projection>0&&projection<1:projection>1);
    collinear.push({segment:i,distanceFromLineMm:error,order:inward?'A–T–C':`${anchor}–C–T`,projection});
  }
  const maximumArmReach=p.armLength+p.bucketRadius;
  near(segments[3].radiusMm,maximumArmReach);
  const legacyArmReach=norm(sub(solvePose(p,a0,d0,u).T,solvePose(p,a0,d0,u).B));
  assert.ok(maximumArmReach>legacyArmReach, `${p.id}: maximum arm reach must exceed legacy arc`);
  const closureError=norm(sub(env.outer[0],env.outer.at(-1)));
  near(closureError,0); assert.equal(env.closed,true);
  results.push({id:p.id,startCylinderLengthsMm:startLengths,collinear,closureErrorMm:closureError,
    maximumArmReachMm:maximumArmReach,legacyArmReachMm:legacyArmReach,
    rawSamplePoints:env.outer.length,segments,passed:true});
}
await writeFile(new URL('../.verify/envelope-sequence-results.json',import.meta.url),JSON.stringify(results,null,2)+'\n');
if (process.argv.includes('--json')) console.log(JSON.stringify(results,null,2));
else for (const result of results) console.log('PASS ' + result.id + ': 9 段，' + result.rawSamplePoints + ' 个轨迹点，缸长/方向/共线/闭合/斗杆最大外伸全部通过');
