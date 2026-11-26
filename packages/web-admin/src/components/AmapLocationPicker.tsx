import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Space, Spin, Typography } from 'antd';
import { EnvironmentOutlined } from '@ant-design/icons';

/**
 * 高德地图人工选点（标书 1.2.12 指定地图服务商 = 高德）。
 *
 * 保持与 LocationReviewPanel 既有的 props 契约，无需改动调用方式。
 * 关键口径：
 *   - 高德 JS API 返回 GCJ-02；平台位置字段统一 WGS84，因此 onPick 一律回传 WGS84；
 *   - 未配置 VITE_AMAP_KEY 时明确报错并保留手动输入经纬度兜底，不静默降级其他地图；
 *   - 只回传坐标与地址建议，不直接改写诉求地址/区划字段。
 */
export interface PlaceCandidate {
  name: string;
  address: string;
  lng: string;
  lat: string;
  coordinateSystem: 'WGS84';
  coordinateSource: string;
}

type AMapLngLat = { getLng(): number; getLat(): number };
type AMapMap = {
  setCenter(center: [number, number]): void;
  setZoom(zoom: number): void;
  on(event: 'click', handler: (event: { lnglat: AMapLngLat }) => void): void;
  add(marker: unknown): void;
  remove(marker: unknown): void;
  destroy(): void;
};
type AMapMarker = { setPosition(position: [number, number]): void; on(event: 'dragend', handler: () => void): void; getPosition(): AMapLngLat };
type AMapGeocoder = {
  getAddress(position: [number, number], callback: (status: string, result: { regeocode?: { formattedAddress?: string } }) => void): void;
  getLocation(address: string, callback: (status: string, result: { geocodes?: Array<{ location?: { getLng(): number; getLat(): number }; formattedAddress?: string; level?: string }> }) => void): void;
};
type AMapNamespace = {
  Map: new (container: HTMLElement, options?: { zoom?: number; center?: [number, number]; viewMode?: string }) => AMapMap;
  Marker: new (options: { position: [number, number]; draggable?: boolean }) => AMapMarker;
  Geocoder: new (options?: { city?: string }) => AMapGeocoder;
};

declare global {
  interface ImportMetaEnv {
    readonly VITE_AMAP_KEY?: string;
    readonly VITE_AMAP_SECURITY_CODE?: string;
  }
  interface Window {
    AMap?: AMapNamespace;
    _AMapSecurityConfig?: { securityJsCode?: string };
  }
}

let amapPromise: Promise<AMapNamespace> | null = null;

/** 加载高德 JS API 2.0；安全密钥必须在脚本加载前写入 window._AMapSecurityConfig。 */
export function loadAmapSdk(): Promise<AMapNamespace> {
  const key = (import.meta.env.VITE_AMAP_KEY ?? '').trim();
  if (!key) return Promise.reject(new Error('未配置 VITE_AMAP_KEY，无法加载高德地图'));
  if (window.AMap) return Promise.resolve(window.AMap);
  if (amapPromise) return amapPromise;
  const securityCode = (import.meta.env.VITE_AMAP_SECURITY_CODE ?? '').trim();
  if (securityCode) window._AMapSecurityConfig = { securityJsCode: securityCode };
  amapPromise = new Promise<AMapNamespace>((resolve, reject) => {
    const existing = document.getElementById('amap-js-sdk') as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');
    script.id = 'amap-js-sdk';
    script.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(key);
    script.async = true;
    script.onload = () => (window.AMap ? resolve(window.AMap) : reject(new Error('高德地图 JS API 未能初始化')));
    script.onerror = () => reject(new Error('高德地图加载失败，可继续人工录入地址和坐标'));
    if (!existing) document.head.appendChild(script);
  }).catch((error: unknown) => {
    amapPromise = null;
    throw error;
  });
  return amapPromise;
}

/** 高德 JS 坐标为 GCJ-02，提交前转 WGS84；公式与后端 domain/utilityCoordinates 一致。 */
export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  const outOfChina = lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  if (outOfChina) return [lng, lat];
  const wgs84ToGcj02 = (x0: number, y0: number): [number, number] => {
    const x = x0 - 105;
    const y = y0 - 35;
    const pi = Math.PI;
    let a = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    let b = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    const common = ((20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2) / 3;
    a += common + ((20 * Math.sin(y * pi) + 40 * Math.sin((y / 3) * pi)) * 2) / 3 + ((160 * Math.sin((y / 12) * pi) + 320 * Math.sin((y * pi) / 30)) * 2) / 3;
    b += common + ((20 * Math.sin(x * pi) + 40 * Math.sin((x / 3) * pi)) * 2) / 3 + ((150 * Math.sin((x / 12) * pi) + 300 * Math.sin((x / 30) * pi)) * 2) / 3;
    const rad = (y0 * pi) / 180;
    const magic = 1 - 0.00669342162296594323 * Math.sin(rad) ** 2;
    const sqrt = Math.sqrt(magic);
    return [
      x0 + (b * 180) / ((6378245 / sqrt) * Math.cos(rad) * pi),
      y0 + (a * 180) / (((6378245 * (1 - 0.00669342162296594323)) / (magic * sqrt)) * pi),
    ];
  };
  let x = lng;
  let y = lat;
  for (let i = 0; i < 5; i += 1) {
    const forward = wgs84ToGcj02(x, y);
    x -= forward[0] - lng;
    y -= forward[1] - lat;
  }
  return [x, y];
}

const valid = (value: number, min: number, max: number): boolean => Number.isFinite(value) && value >= min && value <= max;

export interface AmapLocationPickerProps {
  onSelectPlace?: (place: PlaceCandidate) => void;
  contextKey?: string;
  autoSearch?: string | null;
  disabled?: boolean;
  address?: string | null;
  lng?: string | null;
  lat?: string | null;
  onPick: (point: { lng: string; lat: string; addressSuggestion: string | null; coordinateSystem: 'unknown'; coordinateSource: string }) => void;
  onUseAddressSuggestion?: (address: string) => void;
}

/**
 * 人工选点：地图点选/拖拽 → GCJ-02 转 WGS84 → 回传 lng/lat + 逆地理地址建议。
 * 地图只是辅助，最终以人工确认为准；不自动写库。
 */
const AmapLocationPicker: React.FC<AmapLocationPickerProps> = ({
  address,
  lng,
  lat,
  onPick,
  onUseAddressSuggestion,
  autoSearch,
  disabled = false,
  onSelectPlace,
  contextKey,
}) => {
  const callbacks = useRef({ onPick, onUseAddressSuggestion, onSelectPlace, disabled });
  callbacks.current = { onPick, onUseAddressSuggestion, onSelectPlace, disabled };
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<AMapMap | null>(null);
  const markerRef = useRef<AMapMarker | null>(null);
  const geocoderRef = useRef<AMapGeocoder | null>(null);
  const lastPoint = useRef<{ lng: number; lat: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manualLng, setManualLng] = useState(lng ?? '');
  const [manualLat, setManualLat] = useState(lat ?? '');
  const [suggestion, setSuggestion] = useState<string | null>(null);

  useEffect(() => {
    setManualLng(lng ?? '');
    setManualLat(lat ?? '');
  }, [lng, lat]);

  const emit = (gcjLng: number, gcjLat: number) => {
    const [wgsLng, wgsLat] = gcj02ToWgs84(gcjLng, gcjLat);
    if (!valid(wgsLng, 110, 112.3) || !valid(wgsLat, 29.5, 31.8)) {
      setError('选点不在宜昌市域范围内，请重新选择');
      return;
    }
    lastPoint.current = { lng: wgsLng, lat: wgsLat };
    setManualLng(wgsLng.toFixed(6));
    setManualLat(wgsLat.toFixed(6));
    setError(null);
    const text = '高德地图人工选点；坐标系GCJ02已转WGS84；非自动定位结果';
    callbacks.current.onPick({ lng: wgsLng.toFixed(6), lat: wgsLat.toFixed(6), addressSuggestion: suggestion, coordinateSystem: 'unknown', coordinateSource: text });
    onSelectPlaceRef.current?.({ name: suggestion ?? '高德选点', address: suggestion ?? '', lng: wgsLng.toFixed(6), lat: wgsLat.toFixed(6), coordinateSystem: 'WGS84', coordinateSource: text });
  };
  const onSelectPlaceRef = useRef(onSelectPlace);

  useEffect(() => {
    onSelectPlaceRef.current = onSelectPlace;
  }, [onSelectPlace]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadAmapSdk()
      .then((AMap) => {
        if (cancelled || !containerRef.current) return;
        const initial = valid(Number(lng), 110, 112.3) && valid(Number(lat), 29.5, 31.8)
          ? ([Number(lng), Number(lat)] as [number, number])
          : ([111.286, 30.702] as [number, number]);
        const map = new AMap.Map(containerRef.current, { zoom: 14, center: initial, viewMode: '2D' });
        const marker = new AMap.Marker({ position: initial, draggable: !callbacks.current.disabled });
        map.add(marker);
        const geocoder = new AMap.Geocoder({ city: '宜昌' });
        mapRef.current = map;
        markerRef.current = marker;
        geocoderRef.current = geocoder;
        map.on('click', (event) => {
          if (callbacks.current.disabled) return;
          const position: [number, number] = [event.lnglat.getLng(), event.lnglat.getLat()];
          marker.setPosition(position);
          geocoder.getAddress(position, (status, result) => {
            const text = status === 'complete' ? (result.regeocode?.formattedAddress ?? null) : null;
            setSuggestion(text);
          });
          emit(position[0], position[1]);
        });
        marker.on('dragend', () => {
          if (callbacks.current.disabled) return;
          const position = marker.getPosition();
          const pair: [number, number] = [position.getLng(), position.getLat()];
          geocoder.getAddress(pair, (status, result) => {
            setSuggestion(status === 'complete' ? (result.regeocode?.formattedAddress ?? null) : null);
          });
          emit(pair[0], pair[1]);
        });
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : '高德地图加载失败');
        setLoading(false);
      });
    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.destroy();
        mapRef.current = null;
        markerRef.current = null;
      }
    };
    // 只在挂载时初始化地图；外部 lng/lat 变化不重建实例，避免打断人工操作
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey]);

  /** 用当前地址文本在高德做一次地理编码，落点后仍由人工确认。 */
  const locateByAddress = async () => {
    const term = (autoSearch ?? address ?? '').trim();
    if (!term) {
      setError('没有可用于定位的地址文本');
      return;
    }
    setError(null);
    try {
      const AMap = await loadAmapSdk();
      const geocoder = geocoderRef.current ?? new AMap.Geocoder({ city: '宜昌' });
      geocoderRef.current = geocoder;
      geocoder.getLocation(term, (status, result) => {
        const first = result.geocodes?.[0];
        if (status !== 'complete' || !first?.location) {
          setError('高德未匹配到该地址，请在地图上人工选点');
          return;
        }
        const gcjLng = first.location.getLng();
        const gcjLat = first.location.getLat();
        const position: [number, number] = [gcjLng, gcjLat];
        mapRef.current?.setCenter(position);
        markerRef.current?.setPosition(position);
        setSuggestion(first.formattedAddress ?? null);
        emit(gcjLng, gcjLat);
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '地址定位失败');
    }
  };

  /** 手动输入 WGS84 经纬度兜底（不依赖地图）。 */
  const applyManual = () => {
    const nextLng = Number(manualLng);
    const nextLat = Number(manualLat);
    if (!valid(nextLng, 110, 112.3) || !valid(nextLat, 29.5, 31.8)) {
      setError('经纬度需在宜昌市域内（经度 110~112.3，纬度 29.5~31.8）');
      return;
    }
    setError(null);
    callbacks.current.onPick({ lng: nextLng.toFixed(6), lat: nextLat.toFixed(6), addressSuggestion: suggestion, coordinateSystem: 'unknown', coordinateSource: '人工录入 WGS84 坐标；高德地图辅助核位' });
  };

  return (
    <div data-testid="amap-location-picker">
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <Space wrap>
          <Button icon={<EnvironmentOutlined />} onClick={() => void locateByAddress()} disabled={disabled || loading}>
            按地址定位
          </Button>
          {suggestion && onUseAddressSuggestion && (
            <Button onClick={() => onUseAddressSuggestion(suggestion)} disabled={disabled}>
              使用高德建议地址
            </Button>
          )}
          <Typography.Text type="secondary">高德地图（GCJ-02 → WGS84，市域范围校验）</Typography.Text>
        </Space>
        {error && <Alert type="warning" showIcon message={error} />}
        <div style={{ position: 'relative', width: '100%', height: 320, border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden' }}>
          {loading && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2, background: 'rgba(255,255,255,0.7)' }}>
              <Spin tip="高德地图加载中…" />
            </div>
          )}
          <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        </div>
        {suggestion && <Typography.Text type="secondary">高德识别：{suggestion}</Typography.Text>}
        <Space wrap>
          <Input aria-label="手动经度" addonBefore="经度" value={manualLng} disabled={disabled} onChange={(e) => setManualLng(e.target.value)} style={{ width: 220 }} />
          <Input aria-label="手动纬度" addonBefore="纬度" value={manualLat} disabled={disabled} onChange={(e) => setManualLat(e.target.value)} style={{ width: 220 }} />
          <Button onClick={applyManual} disabled={disabled}>使用手动坐标</Button>
        </Space>
        <Typography.Text type="secondary">
          点选或拖拽地图上的标记即回传 WGS84 坐标；最终以人工确认为准，系统不会自动改写诉求地址或区划。
        </Typography.Text>
      </Space>
    </div>
  );
};

export default AmapLocationPicker;
