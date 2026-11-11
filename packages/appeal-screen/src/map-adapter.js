import {heatColor} from './screen-contract.js'
export class MapAdapter {
  constructor(el, onSelect, status, onHover=()=>{}) { this.el=el; this.onSelect=onSelect; this.status=status; this.onHover=onHover; this.layers={}; }
  initialize() {
    const C=window.Cesium; if(!C){this.status('地图引擎未加载');return}
    try { this.viewer=new C.Viewer(this.el,{animation:false,timeline:false,baseLayerPicker:false,geocoder:false,homeButton:false,sceneModePicker:false,navigationHelpButton:false,fullscreenButton:false,imageryProvider:false,terrainProvider:new C.EllipsoidTerrainProvider()});
      this.viewer.scene.globe.baseColor=C.Color.fromCssColorString('#092b2b'); this.viewer.scene.backgroundColor=C.Color.fromCssColorString('#061c1e'); this.viewer.camera.setView({destination:C.Cartesian3.fromDegrees(111.33,30.68,60000)});
      this.handler=new C.ScreenSpaceEventHandler(this.viewer.scene.canvas); this.handler.setInputAction(m=>{const p=this.viewer.scene.pick(m.position); if(p?.id?.screenData)this.onSelect(p.id.screenData)},C.ScreenSpaceEventType.LEFT_CLICK);
      this.handler.setInputAction(m=>{const p=this.viewer.scene.pick(m.endPosition);this.onHover(p?.id?.screenData||null)},C.ScreenSpaceEventType.MOUSE_MOVE);
      this.onMouseLeave=()=>this.onHover(null);this.viewer.scene.canvas.addEventListener('mouseleave',this.onMouseLeave);
      this.status('CIM 未配置：当前仅显示椭球和业务几何'); this.loadCim();
    } catch(e){this.status('地图加载失败：'+e.message)}
  }
  async loadCim() {
    try {
      const response=await fetch(new URL('config/cim.json', document.baseURI));
      if(!response.ok) throw new Error('配置不可读取');
      const config=await response.json(); if(!this.viewer)return;
      if(!config.wmts&&!config.s3m){this.status('CIM 未配置：当前仅显示椭球和业务几何');return}
      const sameOrigin=url=>{const u=new URL(url,document.baseURI);if(u.origin!==location.origin||u.username||u.password||u.search||u.hash)throw Error('CIM 资源必须使用同源固定代理路径且不含查询参数');return u.href.replace(/%7B(TileMatrix|TileRow|TileCol|s)%7D/gi,'{$1}')};
      if(config.wmts){const w=config.wmts,C=window.Cesium; if(!['EPSG:4490','EPSG:4326'].includes(w.crs))throw Error('WMTS 坐标系不受支持或未声明');if(!w.layer||!w.tileMatrixSetID||!Array.isArray(w.tileMatrixLabels)||!Array.isArray(w.rectangle)||w.rectangle.length!==4||!Number.isInteger(w.levelZeroTilesX)||!Number.isInteger(w.levelZeroTilesY))throw Error('WMTS 矩阵集、矩阵标签、范围或零级矩阵配置不完整'); const tilingScheme=new C.GeographicTilingScheme({numberOfLevelZeroTilesX:w.levelZeroTilesX,numberOfLevelZeroTilesY:w.levelZeroTilesY,rectangle:C.Rectangle.fromDegrees(...w.rectangle)});const provider=new C.WebMapTileServiceImageryProvider({url:sameOrigin(w.url),layer:w.layer,style:w.style||'default',format:w.format||'image/png',tileMatrixSetID:w.tileMatrixSetID,tileMatrixLabels:w.tileMatrixLabels,minimumLevel:w.minimumLevel||0,maximumLevel:w.maximumLevel,tilingScheme});provider.errorEvent.addEventListener(()=>this.status('WMTS 加载失败，请核验授权、矩阵集及代理'));this.viewer.imageryLayers.addImageryProvider(provider)}
      if(config.s3m){const add=this.viewer.scene.addS3MTilesLayerByScp;if(typeof add!=='function')throw Error('当前引擎不支持 S3M');await add.call(this.viewer.scene,sameOrigin(config.s3m.url),{name:'CIM S3M'})}
      if(this.viewer)this.status('CIM 加载请求已发出；瓦片、纹理和空间精度待正式验收');
    } catch(e){this.status('CIM 配置或加载失败：'+e.message)}
  }
  loadLayer(name, items, factory) { if(!this.viewer)return; (this.layers[name]||[]).forEach(e=>this.viewer.entities.remove(e)); this.layers[name]=items.map(factory).filter(Boolean).map(spec=>{const entity=this.viewer.entities.add(spec); entity.screenData=spec.screenData; return entity}); }
  setLayerVisible(name,visible){if(!visible)this.onHover(null);(this.layers[name]||[]).forEach(e=>e.show=visible)}
  applyHeat(heat){const C=window.Cesium;for(const e of this.layers.grids||[]){const color=heatColor(heat,e.screenData.id);e.polygon.material=C.Color.fromCssColorString(color||'#17877c').withAlpha(.45)}}
  focusObjects(type,id){ const e=(this.layers[type]||[]).find(e=>e.screenData?.id===id); if(e)this.viewer.flyTo(e,{duration:.5}); }
  focusGrids(){const e=this.layers.grids||[];if(e.length)this.viewer.flyTo(e,{duration:.5})}
  highlightObjects(ids){for(const e of this.layers.grids||[]) if(e.polygon)e.polygon.outlineColor=ids.includes(e.screenData.id)?window.Cesium.Color.YELLOW:window.Cesium.Color.fromCssColorString('#4fe4cc')}
  clearSelection(){this.highlightObjects([])}
  clearLayers(){this.onHover(null);if(!this.viewer)return;for(const key of Object.keys(this.layers)){for(const entity of this.layers[key])this.viewer.entities.remove(entity);this.layers[key]=[]}}
  resetView(){this.viewer?.camera.setView({destination:window.Cesium.Cartesian3.fromDegrees(111.33,30.68,60000)})}
  resize(){this.viewer?.resize()}
  destroy(){this.onHover(null);if(this.viewer&&this.onMouseLeave)this.viewer.scene.canvas.removeEventListener('mouseleave',this.onMouseLeave);this.handler?.destroy();this.viewer?.destroy();this.viewer=null}
  update(data, visible) { this.onHover(null);if(!this.viewer)return; const C=window.Cesium, s=data?.spatial?.data||{}; const coords=a=>C.Cartesian3.fromDegreesArray((a||[]).flatMap(p=>Array.isArray(p)?p.map(Number):String(p).split(' ').map(Number)));
    const count=(items,id)=>items?.find(x=>x.code===id)?.count??0;const source=data.mode==='simulation'?'模拟网格/模拟坐标，非正式边界':'正式空间待核验';
    this.loadLayer('grids',s.grids||[],g=>({screenData:{type:'grid',id:g.id,name:g.name,count:data.heat?.data?.grids?.find(x=>x.code===g.id)?.count??null,source},name:g.name,polygon:{hierarchy:coords(g.ring),material:C.Color.fromCssColorString('#17877c').withAlpha(.25),outline:true,outlineColor:C.Color.fromCssColorString('#4fe4cc')}}));
    this.applyHeat(data.heat);
    this.loadLayer('communities',s.communities||[],c=>({screenData:{type:'community',id:c.id,name:c.name,count:count(data.charts?.community,c.id),source},name:c.name,position:C.Cartesian3.fromDegrees(c.longitude,c.latitude),point:{pixelSize:7,color:C.Color.fromCssColorString('#73f7d2'),outlineColor:C.Color.BLACK,outlineWidth:1}}));
    for(const type of ['water','gas'])this.loadLayer('pipe-'+type,(s.pipelines||[]).filter(p=>p.businessType===type),p=>({screenData:{type:'pipeline',id:p.id},name:p.name,polyline:{positions:coords(p.path),width:3,material:p.businessType==='gas'?C.Color.ORANGE:C.Color.CYAN}}));
    const grids=s.grids||[];for(const kind of ['planned-water','planned-gas','emergency-water','emergency-gas','construction'])this.loadLayer(kind,(s.events||[]).filter(e=>kind==='construction'?e.kind==='pipeline':e.kind==='shutdown'&&e.eventType===kind),e=>{const g=grids.find(g=>e.gridIds.includes(g.id));return g?{screenData:{type:'event',id:e.id},name:e.title,position:C.Cartesian3.fromDegrees(g.longitude,g.latitude,100),point:{pixelSize:11,color:C.Color.fromCssColorString({'planned-water':'#4bcbea','planned-gas':'#ffa54e','emergency-water':'#ff5555','emergency-gas':'#f266c7','construction':'#f3de56'}[kind]),outlineColor:C.Color.WHITE,outlineWidth:1}}:null});
    Object.keys(visible).forEach(k=>this.setLayerVisible(k,visible[k]));
  }
}
