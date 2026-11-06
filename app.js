(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    splash: $('splash'), app: $('app'), pill: $('status-pill'),
    address: $('address'), coords: $('coords'), locate: $('locate'),
    track: $('track'), error: $('error'), details: $('details'),
    lat: $('lat'), lon: $('lon'), acc: $('acc'), alt: $('alt'),
    spd: $('spd'), hdg: $('hdg'), time: $('time'),
    actions: $('actions'), copy: $('copy'), maplink: $('maplink'),
    share: $('share'), install: $('install'), offline: $('offline'),
  };

  let watchId = null;
  let last = null;
  let lastGeocode = { lat: null, lon: null, at: 0 };
  let geocodeSeq = 0;

  // ---------- Splash ----------
  const SPLASH_MS = 2200;
  window.addEventListener('load', () => {
    el.app.hidden = false;
    setTimeout(() => {
      el.splash.classList.add('hide');
      setTimeout(() => el.splash.remove(), 600);
    }, SPLASH_MS);
  });

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) =>
        console.warn('Service worker registration failed:', e));
    });
  }

  // ---------- Install prompt ----------
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    el.install.hidden = false;
  });
  el.install.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    el.install.hidden = true;
  });
  window.addEventListener('appinstalled', () => { el.install.hidden = true; });

  // ---------- Online / offline ----------
  function updateOnline() { el.offline.hidden = navigator.onLine; }
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();

  // ---------- Helpers ----------
  function setStatus(text, cls) {
    el.pill.textContent = text;
    el.pill.className = 'pill' + (cls ? ' ' + cls : '');
  }
  function showError(msg) {
    el.error.textContent = msg;
    el.error.hidden = !msg;
  }
  function fmt(n, digits = 0, unit = '') {
    return n == null || Number.isNaN(n) ? '–' : n.toFixed(digits) + unit;
  }
  function compass(deg) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(deg / 45) % 8];
  }
  function distanceM(lat1, lon1, lat2, lon2) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // ---------- Geolocation ----------
  const GEO_OPTS = { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 };

  function onPosition(pos) {
    const c = pos.coords;
    last = { lat: c.latitude, lon: c.longitude };
    showError('');
    setStatus(watchId !== null ? 'Tracking' : 'Located', 'live');
    el.locate.disabled = false;
    el.locate.textContent = '📍 Locate me again';

    el.coords.textContent = `${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}`;
    el.lat.textContent = c.latitude.toFixed(6) + '°';
    el.lon.textContent = c.longitude.toFixed(6) + '°';
    el.acc.textContent = c.accuracy != null ? '±' + Math.round(c.accuracy) + ' m' : '–';
    el.alt.textContent = fmt(c.altitude, 0, ' m');
    el.spd.textContent = c.speed != null ? fmt(c.speed * 3.6, 1, ' km/h') : '–';
    el.hdg.textContent = c.heading != null && !Number.isNaN(c.heading)
      ? `${Math.round(c.heading)}° ${compass(c.heading)}` : '–';
    el.time.textContent = new Date(pos.timestamp).toLocaleTimeString();
    el.details.hidden = false;
    el.actions.hidden = false;

    el.maplink.href = `https://www.openstreetmap.org/?mlat=${c.latitude}&mlon=${c.longitude}#map=17/${c.latitude}/${c.longitude}`;
    if (navigator.share) el.share.hidden = false;

    if (!el.address.dataset.resolved) el.address.textContent = 'Looking up address…';
    reverseGeocode(c.latitude, c.longitude);
  }

  function onError(err) {
    el.locate.disabled = false;
    setStatus('Error', 'err');
    const messages = {
      1: 'Location permission was denied. Allow location access for this site in your browser or device settings, then try again.',
      2: "Your position couldn't be determined. Try moving to a spot with a clearer view of the sky.",
      3: 'Finding your location timed out. Please try again.',
    };
    showError(messages[err.code] || 'Something went wrong getting your location.');
    if (err.code === 1) stopTracking();
  }

  function locateOnce() {
    if (!('geolocation' in navigator)) {
      showError("This browser doesn't support geolocation.");
      setStatus('Unsupported', 'err');
      return;
    }
    if (!window.isSecureContext) {
      showError('Geolocation requires a secure (HTTPS or localhost) connection.');
      setStatus('Insecure', 'err');
      return;
    }
    el.locate.disabled = true;
    el.locate.textContent = 'Locating…';
    setStatus('Locating…', 'busy');
    showError('');
    if (watchId !== null) return; // watch will deliver positions
    navigator.geolocation.getCurrentPosition(onPosition, onError, GEO_OPTS);
  }

  function startTracking() {
    if (!('geolocation' in navigator)) return;
    watchId = navigator.geolocation.watchPosition(onPosition, onError, GEO_OPTS);
    setStatus('Tracking', 'live');
  }
  function stopTracking() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    el.track.checked = false;
    if (last) setStatus('Located', 'live');
  }

  // ---------- Reverse geocoding (OpenStreetMap Nominatim) ----------
  async function reverseGeocode(lat, lon) {
    if (!navigator.onLine) {
      el.address.textContent = 'Address unavailable offline';
      el.address.dataset.resolved = '';
      return;
    }
    // Throttle: skip if moved <25 m and checked within 30 s (Nominatim usage policy)
    const now = Date.now();
    if (lastGeocode.lat !== null &&
        distanceM(lat, lon, lastGeocode.lat, lastGeocode.lon) < 25 &&
        now - lastGeocode.at < 30000) return;
    lastGeocode = { lat, lon, at: now };

    const seq = ++geocodeSeq;
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lon}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (seq !== geocodeSeq) return; // stale response
      const a = data.address || {};
      const street = [a.house_number, a.road].filter(Boolean).join(' ');
      const place = a.city || a.town || a.village || a.hamlet || a.suburb || a.county;
      const line = [street, place, a.state, a.country].filter(Boolean).join(', ');
      el.address.textContent = line || data.display_name || 'Unknown place';
      el.address.dataset.resolved = '1';
    } catch (e) {
      if (seq !== geocodeSeq) return;
      el.address.textContent = 'Address lookup failed — coordinates shown below';
      el.address.dataset.resolved = '';
    }
  }

  // ---------- Actions ----------
  el.locate.addEventListener('click', locateOnce);

  el.track.addEventListener('change', () => {
    if (el.track.checked) {
      if (!window.isSecureContext || !('geolocation' in navigator)) {
        el.track.checked = false;
        return locateOnce();
      }
      setStatus('Locating…', 'busy');
      startTracking();
    } else {
      stopTracking();
    }
  });

  el.copy.addEventListener('click', async () => {
    if (!last) return;
    const text = `${last.lat.toFixed(6)}, ${last.lon.toFixed(6)}`;
    try {
      await navigator.clipboard.writeText(text);
      el.copy.textContent = 'Copied ✓';
    } catch {
      el.copy.textContent = text;
    }
    setTimeout(() => (el.copy.textContent = 'Copy coordinates'), 1800);
  });

  el.share.addEventListener('click', async () => {
    if (!last) return;
    try {
      await navigator.share({
        title: 'My location',
        text: `${el.address.textContent}\n${last.lat.toFixed(6)}, ${last.lon.toFixed(6)}`,
        url: el.maplink.href,
      });
    } catch { /* user cancelled */ }
  });

  document.addEventListener('visibilitychange', () => {
    // Save battery: pause tracking while the app is hidden
    if (document.hidden && watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      el.track.dataset.resume = '1';
    } else if (!document.hidden && el.track.dataset.resume) {
      delete el.track.dataset.resume;
      if (el.track.checked) startTracking();
    }
  });
})();
