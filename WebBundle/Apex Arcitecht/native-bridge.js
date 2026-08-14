(() => {
    const bridgeState = window.__APEX_BRIDGE_STATE__ || {};
    const managedKeys = window.__APEX_MANAGED_KEYS__ || [];
    const cache = new Map(Object.entries(bridgeState));

    for (const key of managedKeys) {
        try {
            if (cache.has(key)) {
                window.localStorage.setItem(key, cache.get(key));
            } else {
                window.localStorage.removeItem(key);
            }
        } catch (error) {
            console.error('localStorage bootstrap failed', error);
        }
    }

    function localGet(key) {
        try {
            return window.localStorage.getItem(key);
        } catch (error) {
            console.error('localStorage read failed', error);
            return null;
        }
    }

    function localSet(key, value) {
        try {
            window.localStorage.setItem(key, value);
            return true;
        } catch (error) {
            console.error('localStorage write failed', error);
            return false;
        }
    }

    window.ApexNativeBridge = {
        getItem(key) {
            if (cache.has(key)) {
                return cache.get(key);
            }
            return localGet(key);
        },
        setItem(key, value) {
            cache.set(key, value);
            const nativeHandler = window.webkit?.messageHandlers?.projectStore;
            const localResult = localSet(key, value);
            if (nativeHandler) {
                nativeHandler.postMessage({ type: 'setItem', key, value });
                return true;
            }
            return localResult;
        },
        exportJSON(filename, payload) {
            const nativeHandler = window.webkit?.messageHandlers?.exportBridge;
            if (nativeHandler) {
                nativeHandler.postMessage({ type: 'json', filename, payload });
                return true;
            }
            return false;
        },
        exportPNG(filename, dataUrl) {
            const nativeHandler = window.webkit?.messageHandlers?.exportBridge;
            if (nativeHandler) {
                nativeHandler.postMessage({ type: 'png', filename, dataUrl });
                return true;
            }
            return false;
        },
        accountName() {
            return window.__APEX_ACCOUNT_NAME__ || '';
        },
        isNative() {
            return Boolean(window.webkit?.messageHandlers?.projectStore);
        }
    };
})();
