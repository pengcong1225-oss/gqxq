import {chineseLabel} from '../utils/chineseDisplay';
import React from 'react';
import {Alert} from 'antd';
import type {GridCoverage} from '../api/grids';
export default function GridBoundaryPreview({coverage}:{coverage:GridCoverage}){
 if(!coverage.geometry)return <Alert type="info" message="无授权边界数据" description="尚未提供完整覆盖的授权几何，不能据此确定唯一网格。"/>;
 const rings=coverage.geometry.features.flatMap(f=>f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates);const points=rings.flat(2);const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);const scale=Math.min(360/(maxX-minX||1),200/(maxY-minY||1));const project=(p:number[])=>[20+(p[0]-minX)*scale,220-(p[1]-minY)*scale];
 return <div><p>网格边界 · {chineseLabel(coverage.coordinateSystem,undefined,'坐标系待核验')} · 数据来源：{coverage.geometrySources.join('、')}</p><svg role="img" aria-label="授权边界几何预览" viewBox="0 0 400 240" style={{width:'100%',maxWidth:600,background:'#f5f7fa'}}>{rings.map((polygon,i)=><path key={i} d={polygon.map(r=>r.map((p,j)=>(j?'L':'M')+project(p).join(',')).join(' ')+'Z').join(' ')} fill="#1677ff33" stroke="#1677ff" fillRule="evenodd" strokeWidth="1"/>)}</svg></div>;
}
