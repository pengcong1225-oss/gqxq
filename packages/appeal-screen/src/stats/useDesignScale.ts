/** 大屏自适应：1920×1080 设计稿 + transform: scale(min(w/1920, h/1080)) */
import { onBeforeUnmount, onMounted, ref } from 'vue';

export function useDesignScale() {
  const scale = ref(1);

  const update = () => {
    if (typeof window === 'undefined') return;
    scale.value = Math.min(window.innerWidth / 1920, window.innerHeight / 1080) || 1;
  };

  onMounted(() => {
    update();
    window.addEventListener('resize', update);
  });
  onBeforeUnmount(() => window.removeEventListener('resize', update));

  return { scale, update };
}

/** 读取 hash 路由上的查询参数（用于截图/演示直达某个状态） */
export function hashQuery(): URLSearchParams {
  if (typeof location === 'undefined') return new URLSearchParams();
  const hash = location.hash || '';
  const idx = hash.indexOf('?');
  return new URLSearchParams(idx >= 0 ? hash.slice(idx + 1) : '');
}
