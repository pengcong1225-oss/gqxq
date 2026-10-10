import React from 'react';
import {detailLines} from '../utils/chineseDisplay';
export default function ChineseDetail({value}:{value:unknown}){
 return <div style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'65vh',overflow:'auto'}}>{detailLines(value)}</div>;
}
