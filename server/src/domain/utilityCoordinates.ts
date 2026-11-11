/** Same GCJ02 equations and five inverse refinement steps as PU's
 * WaterStationLocationDialog.stationLocationToMap. Only explicitly declared
 * native GCJ02 geometry is eligible; legacy/unknown CRS is never guessed. */
export function utilityWgs84ToGcj02(lng:number,lat:number):[number,number]{
 if(lng<72.004||lng>137.8347||lat<.8293||lat>55.8271)return [lng,lat];
 const x=lng-105,y=lat-35,pi=Math.PI;
 let a=-100+2*x+3*y+.2*y*y+.1*x*y+.2*Math.sqrt(Math.abs(x));
 let b=300+x+2*y+.1*x*x+.1*x*y+.1*Math.sqrt(Math.abs(x));
 const common=(20*Math.sin(6*x*pi)+20*Math.sin(2*x*pi))*2/3;
 a+=common+(20*Math.sin(y*pi)+40*Math.sin(y/3*pi))*2/3+(160*Math.sin(y/12*pi)+320*Math.sin(y*pi/30))*2/3;
 b+=common+(20*Math.sin(x*pi)+40*Math.sin(x/3*pi))*2/3+(150*Math.sin(x/12*pi)+300*Math.sin(x/30*pi))*2/3;
 const rad=lat*pi/180,magic=1-.00669342162296594323*Math.sin(rad)**2,sqrt=Math.sqrt(magic);
 return [lng+b*180/(6378245/sqrt*Math.cos(rad)*pi),lat+a*180/((6378245*(1-.00669342162296594323))/(magic*sqrt)*pi)];
}
export function utilityGcj02ToWgs84(lng:number,lat:number):[number,number]{
 const first=utilityWgs84ToGcj02(lng,lat);let x=lng*2-first[0],y=lat*2-first[1];
 for(let i=0;i<5;i++){const forward=utilityWgs84ToGcj02(x,y);x-=forward[0]-lng;y-=forward[1]-lat;}
 return [x,y];
}
