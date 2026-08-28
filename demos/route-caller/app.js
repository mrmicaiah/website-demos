/* Route Caller — mobile-first call list.
   All call data lives in D1 behind the Worker; only view preferences are local. */

(() => {
  'use strict';

  const API_BASE = (window.ROUTE_CALLER_CONFIG?.apiBase || '').replace(/\/+$/, '');
  const PREFS_KEY = 'route-caller:prefs';
  const QUEUE_KEY = 'route-caller:pending';

  const STATUS_LABELS = {
    not_called: 'Not called',
    no_answer: 'No answer',
    voicemail: 'Voicemail',
    interested: 'Interested',
    not_interested: 'Not interested',
  };

  const prefs = loadPrefs();
  const state = {
    routes: [],
    route: null,
    facilities: [],
    preview: false,
    map: null,
    layer: null,
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    banner: $('banner'),
    views: {
      landing: $('view-landing'),
      new: $('view-new'),
      list: $('view-list'),
    },
    routeList: $('route-list'),
    formNew: $('form-new-route'),
    newError: $('new-route-error'),
    newLoading: $('new-route-loading'),
    badge: $('route-badge'),
    title: $('route-title'),
    subtitle: $('route-subtitle'),
    search: $('search'),
    filterStatus: $('filter-status'),
    counters: $('counters'),
    toggleSort: $('toggle-sort'),
    toggleFranchise: $('toggle-franchise'),
    toggleHome: $('toggle-home'),
    toggleMap: $('toggle-map'),
    mapPanel: $('map-panel'),
    cards: $('cards'),
    empty: $('empty-state'),
  };

  /* ---------------- preferences ---------------- */

  function loadPrefs() {
    const defaults = {
      routeId: null,
      sort: 'drive',
      hideFranchises: true,
      hideHomeDaycares: true,
      search: '',
      status: 'all',
      mapOpen: false,
    };
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
    } catch {
      return defaults;
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* private browsing — preferences just won't persist */
    }
  }

  /* ---------------- api ---------------- */

  class ApiUnavailable extends Error {}

  async function api(path, options = {}) {
    if (!API_BASE) throw new ApiUnavailable('API base URL is not configured');
    let res;
    try {
      res = await fetch(API_BASE + path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      });
    } catch {
      throw new ApiUnavailable('Could not reach the API');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
    return data;
  }

  /* Failed PATCHes are queued and replayed — a caller in a basement still
     keeps their notes. */
  function queuePatch(id, patch) {
    const queue = readQueue();
    queue.push({ id, patch, at: Date.now() });
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    } catch {
      /* nothing we can do; the in-memory row is still correct */
    }
    showBanner('Offline — changes saved on this device and will sync when you reconnect.');
  }

  function readQueue() {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    } catch {
      return [];
    }
  }

  async function flushQueue() {
    const queue = readQueue();
    if (!queue.length || !API_BASE) return;
    const remaining = [];
    for (const item of queue) {
      try {
        await api(`/api/facilities/${item.id}`, {
          method: 'PATCH',
          body: JSON.stringify(item.patch),
        });
      } catch (err) {
        if (err instanceof ApiUnavailable) remaining.push(item);
      }
    }
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
    } catch { /* ignore */ }
    if (!remaining.length) hideBanner();
  }

  async function patchFacility(id, patch) {
    const facility = state.facilities.find((f) => f.id === id);
    if (facility) Object.assign(facility, patch);
    render();
    if (state.preview) return;
    try {
      await api(`/api/facilities/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      hideBanner();
    } catch (err) {
      if (err instanceof ApiUnavailable) queuePatch(id, patch);
      else showBanner(err.message, true);
    }
  }

  /* ---------------- views ---------------- */

  function show(view) {
    Object.entries(el.views).forEach(([name, node]) => {
      node.hidden = name !== view;
    });
    window.scrollTo(0, 0);
  }

  function showBanner(message, isError = false) {
    el.banner.textContent = message;
    el.banner.className = isError ? 'banner error' : 'banner';
    el.banner.hidden = false;
  }

  const hideBanner = () => { el.banner.hidden = true; };

  /* ---------------- landing ---------------- */

  async function loadRoutes() {
    try {
      const data = await api('/api/routes');
      state.routes = data.routes || [];
      state.preview = false;
      hideBanner();
    } catch (err) {
      state.routes = [SAMPLE.route];
      state.preview = true;
      showBanner(
        API_BASE
          ? 'Preview mode — the API is unreachable, showing sample data.'
          : 'Preview mode — no API configured, showing sample data. Deploy the Worker in api/ and set apiBase in config.js.'
      );
      if (!(err instanceof ApiUnavailable)) console.warn(err);
    }
    renderRoutes();
  }

  function renderRoutes() {
    el.routeList.innerHTML = '';
    if (!state.routes.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-routes';
      empty.textContent = 'No routes yet. Start one and we’ll build the call list.';
      el.routeList.append(empty);
      return;
    }
    for (const route of state.routes) {
      const total = Number(route.facility_count || 0);
      const called = Number(route.called_count || 0);
      const item = document.createElement('button');
      item.className = 'route-item';
      item.type = 'button';
      item.innerHTML = `
        <h3></h3>
        <div class="route-meta"></div>
        <div class="progress-track"><div class="progress-fill"></div></div>`;
      item.querySelector('h3').textContent = route.name;
      item.querySelector('.route-meta').textContent = total
        ? `${called} of ${total} called`
        : 'No facilities found on this route';
      item.querySelector('.progress-fill').style.width =
        total ? `${Math.round((called / total) * 100)}%` : '0%';
      item.addEventListener('click', () => openRoute(route.id));
      el.routeList.append(item);
    }
  }

  /* ---------------- call list ---------------- */

  async function openRoute(id) {
    if (state.preview) {
      state.route = SAMPLE.route;
      state.facilities = SAMPLE.facilities.map((f) => ({ ...f }));
    } else {
      try {
        const data = await api(`/api/routes/${id}`);
        state.route = data.route;
        state.facilities = data.facilities || [];
      } catch (err) {
        showBanner(err.message, true);
        return;
      }
      if (state.route.osm_status && state.route.osm_status !== 'ok') {
        showBanner('OpenStreetMap was unavailable for this route — results are Google-only.');
      }
    }
    prefs.routeId = id;
    savePrefs();
    show('list');
    render();
  }

  /** Short label for the navy badge — a highway number if the name has one. */
  function routeBadge(name) {
    const highway = (name || '').match(/\b(I-?\d+|US-?\d+|SR-?\d+|Rt\.?\s?\d+|Hwy\.?\s?\d+)\b/i);
    if (highway) return highway[1].toUpperCase().replace(/^I(\d)/, 'I-$1');
    return (name || 'Route').trim().split(/\s+/)[0].slice(0, 8).toUpperCase();
  }

  function visibleFacilities() {
    const term = prefs.search.trim().toLowerCase();
    let list = state.facilities.filter((f) => {
      if (prefs.hideFranchises && f.is_franchise) return false;
      if (prefs.hideHomeDaycares && f.is_home_daycare) return false;
      if (prefs.status === 'not_called' && f.status !== 'not_called') return false;
      if (prefs.status === 'called' && f.status === 'not_called') return false;
      if (prefs.status === 'flagged' && !f.flagged) return false;
      if (prefs.status === 'interested' && f.status !== 'interested') return false;
      if (term) {
        const hay = [f.name, f.city, f.zip, f.address].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });

    list = list.slice().sort((a, b) =>
      prefs.sort === 'capacity'
        ? (b.capacity ?? -1) - (a.capacity ?? -1) || byDriveOrder(a, b)
        : byDriveOrder(a, b)
    );
    return list;
  }

  /* Mirrors the API's ORDER BY: position, then distance off route so the
     facilities clamped to a route endpoint come back closest-first, then name. */
  function byDriveOrder(a, b) {
    return (
      (a.position_along_route_m || 0) - (b.position_along_route_m || 0) ||
      (a.distance_from_route_m || 0) - (b.distance_from_route_m || 0) ||
      String(a.name || '').localeCompare(String(b.name || ''))
    );
  }

  function render() {
    if (!state.route) return;
    const list = visibleFacilities();

    el.badge.textContent = routeBadge(state.route.name);
    el.title.textContent = `${state.route.name} — Call List`;

    const hidden = [];
    if (prefs.hideFranchises) hidden.push('franchises');
    if (prefs.hideHomeDaycares) hidden.push('home daycares');
    el.subtitle.textContent =
      `Sorted by ${prefs.sort === 'capacity' ? 'capacity' : 'drive order'}` +
      (hidden.length ? ` · ${hidden.join(' and ')} hidden` : ' · showing everything');

    const called = state.facilities.filter((f) => f.status !== 'not_called').length;
    const flagged = state.facilities.filter((f) => f.flagged).length;
    el.counters.innerHTML =
      `<b>${called}</b> called · <b>${state.facilities.length - called}</b> left · <b>${flagged}</b> flagged`;

    el.search.value = prefs.search;
    el.filterStatus.value = prefs.status;
    el.toggleSort.textContent = prefs.sort === 'capacity' ? 'Biggest first' : 'Drive order';
    el.toggleFranchise.setAttribute('aria-pressed', String(prefs.hideFranchises));
    el.toggleHome.setAttribute('aria-pressed', String(prefs.hideHomeDaycares));

    el.cards.innerHTML = '';
    list.forEach((f) => el.cards.append(facilityCard(f)));

    el.empty.hidden = list.length > 0;
    if (!list.length) {
      el.empty.textContent = state.facilities.length
        ? 'Nothing matches these filters. Tap Clear to see the whole list.'
        : 'No facilities were found within 10 miles of this route.';
    }
    if (prefs.mapOpen) drawMap(list);
  }

  function facilityCard(f) {
    const card = document.createElement('article');
    card.className = 'fac-card' + (f.status !== 'not_called' ? ' is-called' : '');
    card.id = `fac-${f.id}`;

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'fac-check';
    check.checked = f.status !== 'not_called';
    check.setAttribute('aria-label', `Mark ${f.name} as called`);
    check.addEventListener('change', () =>
      patchFacility(f.id, { status: check.checked ? 'no_answer' : 'not_called' })
    );

    const head = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'fac-title';
    const name = document.createElement('span');
    name.className = 'fac-name';
    name.textContent = f.name;
    title.append(name);
    if (f.capacity != null) {
      const pill = document.createElement('span');
      pill.className = 'capacity-pill';
      pill.textContent = `${f.capacity} kids`;
      title.append(pill);
    }

    const sub = document.createElement('div');
    sub.className = 'fac-sub';
    const where = [[f.city, f.zip].filter(Boolean).join(' '), f.license_no].filter(Boolean).join(' · ');
    if (where) sub.append(document.createTextNode(where));
    const src = document.createElement('span');
    src.className = 'src-badge';
    src.textContent = f.source === 'both' ? 'BOTH' : f.source === 'osm' ? 'OSM' : 'G';
    src.title = f.source === 'both' ? 'Found in Google and OpenStreetMap' : f.source === 'osm' ? 'OpenStreetMap' : 'Google';
    sub.append(src);
    head.append(title, sub);

    const body = document.createElement('div');
    body.className = 'fac-body';

    const callRow = document.createElement('div');
    callRow.className = 'call-row';
    const call = document.createElement('a');
    if (f.phone) {
      call.className = 'call-btn';
      call.href = `tel:${String(f.phone).replace(/[^\d+]/g, '')}`;
      call.textContent = f.phone;
    } else {
      call.className = 'call-btn no-phone';
      call.textContent = 'No phone number on file';
    }
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'star-btn';
    star.setAttribute('aria-pressed', String(Boolean(f.flagged)));
    star.setAttribute('aria-label', `Flag ${f.name}`);
    star.textContent = f.flagged ? '★' : '☆';
    star.addEventListener('click', () => patchFacility(f.id, { flagged: f.flagged ? 0 : 1 }));
    callRow.append(call, star);

    const notes = document.createElement('textarea');
    notes.className = 'fac-notes';
    notes.placeholder = 'Decision maker, callback, current equipment age';
    notes.value = f.notes || '';
    const saveNotes = debounce(() => {
      if (notes.value !== (f.notes || '')) patchFacility(f.id, { notes: notes.value });
    }, 800);
    notes.addEventListener('input', saveNotes);
    notes.addEventListener('blur', () => {
      if (notes.value !== (f.notes || '')) patchFacility(f.id, { notes: notes.value });
    });

    const statusRow = document.createElement('div');
    statusRow.className = 'status-row';
    const select = document.createElement('select');
    select.setAttribute('aria-label', `Call status for ${f.name}`);
    Object.entries(STATUS_LABELS).forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    });
    select.value = f.status || 'not_called';
    select.addEventListener('change', () => patchFacility(f.id, { status: select.value }));
    const dist = document.createElement('span');
    dist.className = 'dist-note';
    if (f.distance_from_route_m != null) {
      dist.textContent = `${(f.distance_from_route_m / 1609.34).toFixed(1)} mi off route`;
    }
    statusRow.append(select, dist);

    body.append(callRow, notes, statusRow);
    card.append(check, head, body);
    return card;
  }

  /* ---------------- map ---------------- */

  function drawMap(list) {
    if (typeof L === 'undefined' || !state.route?.polyline) return;
    if (!state.map) {
      state.map = L.map('map', { scrollWheelZoom: false });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(state.map);
    }
    if (state.layer) state.layer.remove();
    state.layer = L.layerGroup().addTo(state.map);

    const points = decodePolyline(state.route.polyline).map((p) => [p.lat, p.lng]);
    const line = L.polyline(points, { color: '#2E5B41', weight: 4 }).addTo(state.layer);

    list.forEach((f) => {
      if (f.lat == null || f.lng == null) return;
      L.circleMarker([f.lat, f.lng], {
        radius: 6,
        color: '#fff',
        weight: 2,
        fillColor: f.status !== 'not_called' ? '#9AA39E' : '#2F7D4F',
        fillOpacity: 1,
      })
        .bindTooltip(f.name)
        .on('click', () => {
          const card = document.getElementById(`fac-${f.id}`);
          if (!card) return;
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.add('is-target');
          setTimeout(() => card.classList.remove('is-target'), 1600);
        })
        .addTo(state.layer);
    });

    if (points.length) state.map.fitBounds(line.getBounds(), { padding: [24, 24] });
    setTimeout(() => state.map.invalidateSize(), 60);
  }

  /** Same algorithm as the Worker's geo.js — the map needs it client-side too. */
  function decodePolyline(encoded) {
    const points = [];
    let index = 0;
    let lat = 0;
    let lng = 0;
    while (index < encoded.length) {
      let result = 1;
      let shift = 0;
      let b;
      do {
        b = encoded.charCodeAt(index++) - 63 - 1;
        result += b << shift;
        shift += 5;
      } while (b >= 0x1f);
      lat += result & 1 ? ~(result >> 1) : result >> 1;
      result = 1;
      shift = 0;
      do {
        b = encoded.charCodeAt(index++) - 63 - 1;
        result += b << shift;
        shift += 5;
      } while (b >= 0x1f);
      lng += result & 1 ? ~(result >> 1) : result >> 1;
      points.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return points;
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  /* ---------------- events ---------------- */

  document.querySelectorAll('[data-nav="landing"]').forEach((node) =>
    node.addEventListener('click', () => {
      show('landing');
      loadRoutes();
    })
  );

  $('btn-new-route').addEventListener('click', () => {
    el.newError.hidden = true;
    el.formNew.hidden = false;
    el.newLoading.hidden = true;
    show('new');
  });

  el.formNew.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(el.formNew).entries());
    el.newError.hidden = true;
    el.formNew.hidden = true;
    el.newLoading.hidden = false;
    try {
      const data = await api('/api/routes', { method: 'POST', body: JSON.stringify(body) });
      state.preview = false;
      state.route = data.route;
      state.facilities = data.facilities || [];
      prefs.routeId = data.route.id;
      savePrefs();
      show('list');
      render();
      if (!state.facilities.length) {
        showBanner('No child care facilities were found within 10 miles of that route.');
      } else if (data.route.osm_status && data.route.osm_status !== 'ok') {
        showBanner('OpenStreetMap was unavailable — results are Google-only.');
      } else {
        hideBanner();
      }
    } catch (err) {
      el.newError.textContent =
        err instanceof ApiUnavailable
          ? 'Could not reach the API. Check apiBase in config.js and that the Worker is deployed.'
          : err.message;
      el.newError.hidden = false;
      el.formNew.hidden = false;
    } finally {
      el.newLoading.hidden = true;
    }
  });

  el.search.addEventListener(
    'input',
    debounce(() => {
      prefs.search = el.search.value;
      savePrefs();
      render();
    }, 180)
  );

  el.filterStatus.addEventListener('change', () => {
    prefs.status = el.filterStatus.value;
    savePrefs();
    render();
  });

  el.toggleSort.addEventListener('click', () => {
    prefs.sort = prefs.sort === 'capacity' ? 'drive' : 'capacity';
    savePrefs();
    render();
  });

  el.toggleFranchise.addEventListener('click', () => {
    prefs.hideFranchises = !prefs.hideFranchises;
    savePrefs();
    render();
  });

  el.toggleHome.addEventListener('click', () => {
    prefs.hideHomeDaycares = !prefs.hideHomeDaycares;
    savePrefs();
    render();
  });

  el.toggleMap.addEventListener('click', () => {
    prefs.mapOpen = !prefs.mapOpen;
    savePrefs();
    el.mapPanel.hidden = !prefs.mapOpen;
    el.toggleMap.setAttribute('aria-expanded', String(prefs.mapOpen));
    if (prefs.mapOpen) drawMap(visibleFacilities());
  });

  $('btn-clear').addEventListener('click', () => {
    prefs.search = '';
    prefs.status = 'all';
    prefs.hideFranchises = false;
    prefs.hideHomeDaycares = false;
    savePrefs();
    render();
  });

  window.addEventListener('online', flushQueue);

  /* ---------------- preview data ----------------
     Only ever shown when the API is unreachable, and always behind the
     "Preview mode" banner. Nothing here is written anywhere. */
  const SAMPLE = {
    route: {
      id: 'sample',
      name: 'I-95 North — Sample',
      start_address: 'Richmond, VA',
      end_address: 'Fredericksburg, VA',
      polyline: 'kdcdF~eswMcmP_cB_mV~xFoh\\n}@okXo}@_mVozDo|\\r}D',
      osm_status: 'ok',
      facility_count: 5,
      called_count: 1,
    },
    facilities: [
      { id: 's1', name: 'Sunny Days Learning Center', city: 'Ashland', zip: '23005', phone: '(804) 555-0142', lat: 37.7595, lng: -77.4805, source: 'both', capacity: 114, license_no: 'CC-14882', distance_from_route_m: 1600, position_along_route_m: 26000, is_franchise: 0, is_home_daycare: 0, status: 'not_called', flagged: 0, notes: '' },
      { id: 's2', name: 'Little Acorns Preschool', city: 'Doswell', zip: '23047', phone: '(804) 555-0198', lat: 37.9012, lng: -77.5102, source: 'google', capacity: null, license_no: null, distance_from_route_m: 4300, position_along_route_m: 42000, is_franchise: 0, is_home_daycare: 0, status: 'voicemail', flagged: 1, notes: 'Ask for Denise, back Thursday.' },
      { id: 's3', name: 'Bright Beginnings Academy', city: 'Ladysmith', zip: '22546', phone: '(540) 555-0117', lat: 38.0289, lng: -77.4501, source: 'osm', capacity: 68, license_no: 'CC-20551', distance_from_route_m: 900, position_along_route_m: 57000, is_franchise: 0, is_home_daycare: 0, status: 'not_called', flagged: 0, notes: '' },
      { id: 's4', name: 'KinderCare Learning Center', city: 'Thornburg', zip: '22565', phone: '(540) 555-0163', lat: 38.1602, lng: -77.4189, source: 'google', capacity: 132, license_no: null, distance_from_route_m: 2400, position_along_route_m: 71000, is_franchise: 1, is_home_daycare: 0, status: 'not_called', flagged: 0, notes: '' },
      { id: 's5', name: "Miller's Family Child Care", city: 'Fredericksburg', zip: '22401', phone: '(540) 555-0121', lat: 38.2905, lng: -77.4712, source: 'osm', capacity: 12, license_no: null, distance_from_route_m: 3100, position_along_route_m: 86000, is_franchise: 0, is_home_daycare: 1, status: 'not_called', flagged: 0, notes: '' },
    ],
  };

  /* ---------------- boot ---------------- */

  el.mapPanel.hidden = !prefs.mapOpen;
  el.toggleMap.setAttribute('aria-expanded', String(prefs.mapOpen));
  show('landing');
  flushQueue();
  loadRoutes().then(() => {
    if (prefs.routeId && state.routes.some((r) => r.id === prefs.routeId)) {
      openRoute(prefs.routeId);
    }
  });
})();
