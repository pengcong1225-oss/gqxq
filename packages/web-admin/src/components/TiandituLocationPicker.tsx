import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Space, Spin, Typography } from 'antd';
import { EnvironmentOutlined } from '@ant-design/icons';

type LngLat = { getLng(): number; getLat(): number };
type MapClickEvent = { lnglat?: LngLat };
type TiandituMap = {
  centerAndZoom(point: unknown, zoom: number): void;
  panTo(point: unknown): void;
  addEventListener(name: 'click', listener: (event: MapClickEvent) => void): void;
  addOverLay(overlay: unknown): void;
  removeOverLay(overlay: unknown): void;
};
type TiandituSdk = {
  Map: new (container: HTMLElement) => TiandituMap;
  LngLat: new (lng: number, lat: number) => unknown;
  Marker: new (point: unknown) => unknown;
};
type ReverseGeocodeResponse = {
  result?: { formatted_address?: string; addressComponent?: Record<string, string> };
  status?: { infocode?: number | string };
};
type PlaceSearchResponse = {
  pois?: Array<{ name?: string; address?: string; lonlat?: string }>;
  status?: { infocode?: number | string; cndesc?: string };
};

export interface PlaceCandidate {
  name: string;
  address: string;
  lng: string;
  lat: string;
  coordinateSystem:'unknown';
  coordinateSource:string;
}

declare global {
  interface ImportMetaEnv {
    readonly VITE_TIANDITU_TK?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
  interface Window {
    T?: TiandituSdk;
  }
}

let sdkPromise: Promise<TiandituSdk> | null = null;

function loadSdk(key: string): Promise<TiandituSdk> {
  if (window.T) return Promise.resolve(window.T);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<TiandituSdk>((resolve, reject) => {
    const existing = document.getElementById('tianditu-js-sdk') as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');
    script.id = 'tianditu-js-sdk';
    script.src = 'https://api.tianditu.gov.cn/api?v=4.0&tk=' + encodeURIComponent(key);
    script.async = true;
    script.onload = () => window.T ? resolve(window.T) : reject(new Error('天地图 JS API 未能初始化'));
    script.onerror = () => reject(new Error('地图暂时不可用，可继续人工录入地址和坐标'));
    if (!existing) document.head.appendChild(script);
  }).catch((error: unknown) => {
    sdkPromise = null;
    throw error;
  });
  return sdkPromise;
}

function validCoordinate(value: string | null | undefined, min: number, max: number): number | null {
  if (value == null || value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

async function reverseGeocode(key: string, lng: number, lat: number): Promise<string | null> {
  const query = new URLSearchParams({
    postStr: JSON.stringify({ lon: lng, lat, ver: 1 }),
    type: 'geocode',
    tk: key,
  });
  const response = await fetch('https://api.tianditu.gov.cn/geocoder?' + query.toString());
  if (!response.ok) throw new Error('逆地理解析请求失败');
  const data = await response.json() as ReverseGeocodeResponse;
  const address = data.result?.formatted_address?.trim();
  return address || null;
}

/** 地名搜索服务 V2：只把有效经纬度候选交给人工选择，不直接写入纠偏数据。 */
export async function searchTiandituPlaces(
  keyword: string,
  key: string,
  request: typeof fetch = fetch
): Promise<PlaceCandidate[]> {
  const term = keyword.trim();
  if (!term) return [];
  const query = new URLSearchParams({
    postStr: JSON.stringify({
      keyWord: term,
      level: 12,
      mapBound: '109.5,29.5,113,32',
      queryType: 1,
      start: 0,
      count: 10,
    }),
    type: 'query',
    tk: key,
  });
  const response = await request('https://api.tianditu.gov.cn/v2/search?' + query.toString());
  if (!response.ok) throw new Error('地址搜索请求失败');
  const data = await response.json() as PlaceSearchResponse;
  const code = String(data.status?.infocode ?? '1000');
  if (code === '3001') return [];
  if (code !== '1000') throw new Error(data.status?.cndesc || '地址搜索服务异常');
  return (data.pois ?? []).flatMap((poi) => {
    const [lng = '', lat = ''] = (poi.lonlat ?? '').split(',').map((part) => part.trim());
    if (validCoordinate(lng, -180, 180) === null || validCoordinate(lat, -90, 90) === null) return [];
    return [{ name: poi.name?.trim() || poi.address?.trim() || term, address: poi.address?.trim() || poi.name?.trim() || term, lng, lat,coordinateSystem:'unknown' as const,coordinateSource:'天地图地址搜索候选，坐标系未核实' }];
  });
}

export interface TiandituLocationPickerProps {
  address?: string | null;
  lng?: string | null;
  lat?: string | null;
  onPick: (point: { lng: string; lat: string; addressSuggestion: string | null;coordinateSystem:'unknown';coordinateSource:string }) => void;
  onUseAddressSuggestion?: (address: string) => void;
}

/** 地图点选只返回坐标和可选地址建议，不会直接改写地址字段。 */
const TiandituLocationPicker: React.FC<TiandituLocationPickerProps> = ({ address, lng, lat, onPick, onUseAddressSuggestion }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<TiandituMap | null>(null);
  const markerRef = useRef<unknown>(null);
  const requestIdRef = useRef(0);
  const searchIdRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [geocoding, setGeocoding] = useState(false);
  const [picked, setPicked] = useState<{ lng: string; lat: string; addressSuggestion: string | null } | null>(null);
  const [searchText, setSearchText] = useState(address ?? '');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [places, setPlaces] = useState<PlaceCandidate[]>([]);
  const key = import.meta.env.VITE_TIANDITU_TK?.trim() ?? '';

  useEffect(() => { setSearchText(address ?? ''); }, [address]);

  const searchAddress = async (value: string) => {
    const term = value.trim();
    const searchId = ++searchIdRef.current;
    setSearchError(null);
    setPlaces([]);
    if (!term) {
      setSearchError('请先输入地址或地点名称');
      return;
    }
    if (!key) {
      setSearchError('地址搜索暂时不可用，可继续人工录入地址和坐标');
      return;
    }
    setSearching(true);
    try {
      const next = await searchTiandituPlaces(term, key);
      if (searchId !== searchIdRef.current) return;
      setPlaces(next);
      if (next.length === 0) setSearchError('没有找到匹配地点，请补充区县、街道或门牌号后重试');
    } catch (cause) {
      if (searchId === searchIdRef.current) setSearchError(cause instanceof Error ? cause.message : '地址搜索失败');
    } finally {
      if (searchId === searchIdRef.current) setSearching(false);
    }
  };

  const selectPlace = (place: PlaceCandidate) => {
    const sdk = window.T;
    const map = mapRef.current;
    ++requestIdRef.current; // 废弃更早的地图点选反查，避免旧地址覆盖搜索结果。
    if(sdk&&map){
      const location = new sdk.LngLat(Number(place.lng), Number(place.lat));
      if (markerRef.current) map.removeOverLay(markerRef.current);
      const marker = new sdk.Marker(location);map.addOverLay(marker);markerRef.current = marker;map.centerAndZoom(location, 16);
    }
    const point = { lng: place.lng, lat: place.lat, addressSuggestion: place.address,coordinateSystem:place.coordinateSystem,coordinateSource:place.coordinateSource };
    setPicked(point);
    onPick(point);
    onUseAddressSuggestion?.(place.address);
    setPlaces([]);
    setSearchError(null);
  };

  useEffect(() => {
    let active = true;
    if (!key) {
      setLoading(false);
      setError('地图暂时不可用，可继续人工录入地址和坐标');
      return () => { active = false; };
    }
    void loadSdk(key).then((sdk) => {
      if (!active || !containerRef.current) return;
      const map = new sdk.Map(containerRef.current);
      const selectedLng = validCoordinate(lng, -180, 180);
      const selectedLat = validCoordinate(lat, -90, 90);
      const hasSelectedPoint = selectedLng !== null && selectedLat !== null;
      const centerLng = hasSelectedPoint ? selectedLng : 111.2860;
      const centerLat = hasSelectedPoint ? selectedLat : 30.6910;
      map.centerAndZoom(new sdk.LngLat(centerLng, centerLat), hasSelectedPoint ? 16 : 12);
      if (hasSelectedPoint) {
        const marker = new sdk.Marker(new sdk.LngLat(centerLng, centerLat));
        map.addOverLay(marker);
        markerRef.current = marker;
      }
      map.addEventListener('click', (event) => {
        if (!active || !event.lnglat) return;
        const requestId = ++requestIdRef.current;
        const pickedLng = event.lnglat.getLng();
        const pickedLat = event.lnglat.getLat();
        if (!Number.isFinite(pickedLng) || !Number.isFinite(pickedLat)) return;
        const point = { lng: pickedLng.toFixed(6), lat: pickedLat.toFixed(6), addressSuggestion: null as string | null,coordinateSystem:'unknown' as const,coordinateSource:'天地图人工选点，坐标系未核实' };
        if (markerRef.current) map.removeOverLay(markerRef.current);
        const marker = new sdk.Marker(new sdk.LngLat(pickedLng, pickedLat));
        map.addOverLay(marker);
        markerRef.current = marker;
        map.panTo(new sdk.LngLat(pickedLng, pickedLat));
        setPicked(point);
        onPick(point);
        setGeocoding(true);
        void reverseGeocode(key, pickedLng, pickedLat).then((address) => {
          if (!active || requestId !== requestIdRef.current) return;
          const nextPoint = { ...point, addressSuggestion: address };
          setPicked(nextPoint);
          onPick(nextPoint);
        }).catch(() => {
          if (!active || requestId !== requestIdRef.current) return;
          setPicked(point);
          onPick(point);
        }).finally(() => {
          if (active && requestId === requestIdRef.current) setGeocoding(false);
        });
      });
      mapRef.current = map;
      setLoading(false);
      setError(null);
    }).catch((cause: unknown) => {
      if (active) {
        setLoading(false);
        setError('地图暂时不可用，可继续人工录入地址和坐标');
      }
    });
    return () => { active = false; mapRef.current = null; markerRef.current = null; };
    // Map is initialized once for this picker instance; prop coordinates only set initial center.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div>
      <Input.Search
        aria-label="搜索地址并定位"
        value={searchText}
        onChange={(event) => setSearchText(event.target.value)}
        onSearch={(value) => void searchAddress(value)}
        enterButton="搜索定位"
        loading={searching}
        placeholder="输入宜昌市内地址、道路或地标，搜索后选择定位结果"
        style={{ marginBottom: 8 }}
      />
      {searchError ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={searchError} /> : null}
      {places.length > 0 ? (
        <div style={{ maxHeight: 160, overflowY: 'auto', marginBottom: 8, border: '1px solid #d9d9d9', padding: 8 }}>
          <Typography.Text type="secondary">请选择正确地点；选择后仅回填本窗体，仍需点击“保存位置组”</Typography.Text>
          {places.map((place, index) => (
            <div key={place.lng + ',' + place.lat + ':' + index}>
              <Button type="link" onClick={() => selectPlace(place)}>{place.name} · {place.address}</Button>
            </div>
          ))}
        </div>
      ) : null}
      {error ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={error} /> : null}
      {loading ? <div style={{ height: 380, display: 'grid', placeItems: 'center' }}><Spin tip="加载天地图…" /></div> : null}
      <div ref={containerRef} style={{ height: 380, border: '1px solid #d9d9d9', visibility: loading || error ? 'hidden' : 'visible' }} />
      {picked ? (
        <Space direction="vertical" size={4} style={{ marginTop: 8 }}>
          <Typography.Text><EnvironmentOutlined /> 已选坐标：{picked.lng}, {picked.lat}</Typography.Text>
          {geocoding ? <Typography.Text type="secondary">正在查询地址建议…</Typography.Text> : null}
          {picked.addressSuggestion ? (
            <Space wrap>
              <Typography.Text type="secondary">地址建议（请人工核对）：{picked.addressSuggestion}</Typography.Text>
              {onUseAddressSuggestion ? <Button size="small" onClick={() => onUseAddressSuggestion(picked.addressSuggestion as string)}>填入地址字段</Button> : null}
            </Space>
          ) : null}
        </Space>
      ) : null}
    </div>
  );
};

export default TiandituLocationPicker;
