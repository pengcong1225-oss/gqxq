// An iframe opens the portal session in its own tab without replacing a direct business login.
const legacyStorage = window.parent === window ? window.localStorage : window.sessionStorage;
const OIDC_KEY = 'gqxq-oidc-marker';
export const isOidcMarker = (value: string | null): boolean => value?.startsWith('oidc-cookie:') ?? false;

export const authStorage = {
  getItem(key: string) {
    return key === 'token'
      ? window.sessionStorage.getItem(OIDC_KEY) ?? legacyStorage.getItem(key)
      : legacyStorage.getItem(key);
  },
  setItem(key: string, value: string) {
    if (key === 'token' && isOidcMarker(value)) {
      window.sessionStorage.setItem(OIDC_KEY, value);
      return;
    }
    if (key === 'token') window.sessionStorage.removeItem(OIDC_KEY);
    legacyStorage.setItem(key, value);
  },
  removeItem(key: string) {
    if (key === 'token' && window.sessionStorage.getItem(OIDC_KEY)) {
      window.sessionStorage.removeItem(OIDC_KEY);
      if (isOidcMarker(window.sessionStorage.getItem('gqxq-token'))) window.sessionStorage.removeItem('gqxq-token');
      return;
    }
    legacyStorage.removeItem(key);
  },
};
