/* Area Caller — mobile-first call list for local service trades.
   The shell is route-caller's, on purpose: the caller is already fluent in it.
   All call data lives in D1 behind the same Worker; only view preferences are
   local. */

(() => {
  'use strict';

  const API_BASE = (window.AREA_CALLER_CONFIG?.apiBase || '').replace(/\/+$/, '');
  const PREFS_KEY = 'area-caller:prefs';
  const QUEUE_KEY = 'area-caller:pending';

  /* The pipeline, from the shared module the Worker's tests also load. Two
     gates: are they shopping for a website person, and will they book the
     brainstorm right now. If they don't book, they're out — there is nothing
     between `meeting_set` and `out`, and adding something would be wrong for
     this product. */
  const A = window.AreaAgenda;
  const STATUS_LABELS = Object.fromEntries(A.STATUSES.map((s) => [s.key, s.label]));
  const CLOSED_STATUSES = ['out', 'lost'];

  /* THE LEAD SCORE. Mirrors src/areas/leadScore.js on the server, which is
     where the formula is documented — no website first, then review count
     descending (the "established business" proxy), then distance, then name.
     A NULL review count is not zero: it means the field mask failed, so it
     sorts to the bottom of its group rather than pretending to be a business
     with no reviews. */
  const hasWebsite = (f) => (f.website && String(f.website).trim() ? 1 : 0);
  const reviews = (f) => (f.review_count == null ? -1 : Number(f.review_count));
  const distance = (f) => Number(f.distance_from_center_m ?? 0);
  const cmpName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));

  const SORTS = {
    lead: {
      label: 'Lead score',
      compare: (a, b) =>
        hasWebsite(a) - hasWebsite(b) ||
        reviews(b) - reviews(a) ||
        distance(a) - distance(b) ||
        cmpName(a, b),
    },
    distance: { label: 'Distance', compare: (a, b) => distance(a) - distance(b) || cmpName(a, b) },
    reviews: { label: 'Most reviewed', compare: (a, b) => reviews(b) - reviews(a) || cmpName(a, b) },
    name: { label: 'A–Z', compare: cmpName },
  };

  const prefs = loadPrefs();
  const state = {
    areas: [],
    area: null,
    facilities: [],
    agenda: [],
    industries: [],
    radiusPresets: [16093, 32187, 48280],
    preview: false,
    map: null,
    layer: null,
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    banner: $('banner'),
    views: { landing: $('view-landing'), new: $('view-new'), list: $('view-list') },
    areaList: $('area-list'),
    todayLanding: $('today-landing'),
    todayArea: $('today-area'),
    formNew: $('form-new-area'),
    newError: $('new-area-error'),
    newLoading: $('new-area-loading'),
    radiusRow: $('radius-row'),
    industryGrid: $('industry-grid'),
    badge: $('area-badge'),
    title: $('area-title'),
    subtitle: $('area-subtitle'),
    search: $('search'),
    filterStatus: $('filter-status'),
    industryChips: $('industry-chips'),
    counters: $('counters'),
    sortSelect: $('sort-select'),
    hiddenBar: $('hidden-bar'),
    hiddenSummary: $('hidden-summary'),
    toggleHidden: $('toggle-hidden'),
    btnEnrich: $('btn-enrich'),
    enrichStatus: $('enrich-status'),
    toggleMap: $('toggle-map'),
    mapPanel: $('map-panel'),
    cards: $('cards'),
    empty: $('empty-state'),
  };

  /* ---------------- preferences ---------------- */

  function loadPrefs() {
    const defaults = {
      areaId: null,
      sort: 'lead',
      // Junk is hidden by default and she never has to press anything.
      // `restored` holds the categories she has explicitly brought back.
      restored: [],
      showHidden: false,
      industry: 'all',
      search: '',
      status: 'all',
      mapOpen: false,
      showUpcoming: false,
      radiusM: 48280,
      newIndustries: null, // null = use the server's defaults
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
    } catch { /* the in-memory row is still correct */ }
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
        await api(`/api/area-facilities/${item.id}`, {
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

  const PIPELINE_FIELDS = ['status', 'meeting_at', 'follow_up_date'];

  async function patchFacility(id, patch) {
    const facility = state.facilities.find((f) => f.id === id);
    const before = facility ? { ...facility } : null;
    if (facility) Object.assign(facility, patch);
    render();
    if (state.preview) return;
    try {
      const data = await api(`/api/area-facilities/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      // Trust the row the server returns: it is the one that passed the
      // meeting_set-needs-a-time rule.
      if (facility && data.facility) Object.assign(facility, data.facility);
      hideBanner();
      if (PIPELINE_FIELDS.some((k) => k in patch)) {
        await loadAgenda();
        render();
      }
    } catch (err) {
      if (err instanceof ApiUnavailable) {
        queuePatch(id, patch);
      } else {
        // A rejected pipeline change must not leave the card lying about its
        // state — put the row back the way the server still has it.
        if (facility && before) Object.assign(facility, before);
        showBanner(err.message, true);
        render();
      }
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

  function showEnrichStatus(message, isError = false) {
    el.enrichStatus.textContent = message;
    el.enrichStatus.hidden = false;
    if (isError) showBanner(message, true);
  }

  const milesLabel = (metres) => `${Math.round(metres / 1609.34)} mi`;
  const miles = (metres) => (Number(metres || 0) / 1609.34).toFixed(1);

  /* ---------------- the new-area form ---------------- */

  async function loadIndustries() {
    try {
      const data = await api('/api/industries');
      state.industries = data.industries || [];
      state.radiusPresets = data.radius_presets_m || state.radiusPresets;
    } catch {
      // Preview mode, or the API is down. The form still renders.
      state.industries = [
        { key: 'hvac', label: 'HVAC', defaultOn: true },
        { key: 'plumbing', label: 'Plumbing', defaultOn: true },
      ];
    }
    if (!prefs.newIndustries) {
      prefs.newIndustries = state.industries.filter((i) => i.defaultOn).map((i) => i.key);
    }
    renderNewForm();
  }

  function renderNewForm() {
    el.radiusRow.innerHTML = '';
    for (const metres of state.radiusPresets) {
      const label = document.createElement('label');
      label.className = 'check-item' + (prefs.radiusM === metres ? ' is-on' : '');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'radius_m';
      input.value = String(metres);
      input.checked = prefs.radiusM === metres;
      input.addEventListener('change', () => {
        prefs.radiusM = metres;
        savePrefs();
        renderNewForm();
      });
      label.append(input, document.createTextNode(milesLabel(metres)));
      el.radiusRow.append(label);
    }

    el.industryGrid.innerHTML = '';
    for (const industry of state.industries) {
      const on = prefs.newIndustries.includes(industry.key);
      const label = document.createElement('label');
      label.className = 'check-item' + (on ? ' is-on' : '');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = on;
      input.addEventListener('change', () => {
        prefs.newIndustries = input.checked
          ? [...new Set([...prefs.newIndustries, industry.key])]
          : prefs.newIndustries.filter((k) => k !== industry.key);
        savePrefs();
        renderNewForm();
      });
      label.append(input, document.createTextNode(industry.label));
      el.industryGrid.append(label);
    }
  }

  /* ---------------- the Today panel ----------------
     One component, used at the top of the landing page and at the top of each
     area's call list (area-filtered there). It IS the reminder system: no
     notifications, no email, no digest. Opening the tool tells him the day.

     Every date decision happens HERE, in the browser, against the browser's own
     local today — the server returns wall-clock strings and never guesses a
     timezone. See agenda.js. */

  async function loadAgenda() {
    if (state.preview) {
      state.agenda = SAMPLE.agenda;
      return;
    }
    try {
      const data = await api('/api/agenda');
      state.agenda = data.rows || [];
    } catch {
      // A failed agenda must never block the list she came here to work.
      state.agenda = [];
    }
  }

  function renderToday(container, areaId = null) {
    container.innerHTML = '';
    const rows = areaId ? state.agenda.filter((r) => r.area_id === areaId) : state.agenda;
    const { meetingsToday, meetingsUpcoming, followUpsDue } = A.classifyAgenda(rows);

    if (!meetingsToday.length && !meetingsUpcoming.length && !followUpsDue.length) {
      // One quiet line, not a big empty box.
      const quiet = document.createElement('p');
      quiet.className = 'today-quiet';
      quiet.textContent = 'No meetings and no follow-ups due. Work the list.';
      container.append(quiet);
      return;
    }

    if (meetingsToday.length || meetingsUpcoming.length) {
      const block = section('is-meetings', 'Meetings today', meetingsToday.length);
      if (!meetingsToday.length) {
        block.head.querySelector('.today-title').textContent = 'Meetings';
        block.head.querySelector('.today-count').textContent = 'none today';
      }
      for (const row of meetingsToday) block.body.append(meetingRow(row, areaId));

      if (meetingsUpcoming.length) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'today-more';
        more.textContent = prefs.showUpcoming
          ? 'Hide the next 7 days'
          : `Next 7 days (${meetingsUpcoming.length})`;
        more.addEventListener('click', () => {
          prefs.showUpcoming = !prefs.showUpcoming;
          savePrefs();
          renderToday(container, areaId);
        });
        if (prefs.showUpcoming) {
          for (const row of meetingsUpcoming) block.body.append(meetingRow(row, areaId, true));
        }
        block.body.append(more);
      }
      container.append(block.node);
    }

    if (followUpsDue.length) {
      const block = section('is-followups', 'Follow-ups due', followUpsDue.length);
      for (const row of followUpsDue) block.body.append(followUpRow(row, areaId));
      container.append(block.node);
    }
  }

  function section(modifier, title, count) {
    const node = document.createElement('div');
    node.className = `today-block ${modifier}`;
    const head = document.createElement('div');
    head.className = 'today-head';
    const h = document.createElement('span');
    h.className = 'today-title';
    h.textContent = title;
    const n = document.createElement('span');
    n.className = 'today-count';
    n.textContent = String(count);
    head.append(h, n);
    const body = document.createElement('div');
    node.append(head, body);
    return { node, head, body };
  }

  function agendaRowShell(whenText, overdue, row, areaId) {
    const node = document.createElement('div');
    node.className = 'today-row';
    const when = document.createElement('span');
    when.className = 'today-when' + (overdue ? ' is-overdue' : '');
    when.textContent = whenText;
    const main = document.createElement('div');
    main.className = 'today-main';
    const name = document.createElement('span');
    name.className = 'today-name';
    name.textContent = row.name;
    const sub = document.createElement('span');
    sub.className = 'today-sub';
    // On the landing page he needs to know WHICH town; inside an area he doesn't.
    sub.textContent = [areaId ? null : row.area_name, row.phone].filter(Boolean).join(' · ');
    main.append(name, sub);
    const actions = document.createElement('div');
    actions.className = 'today-actions';
    if (row.phone) {
      const call = document.createElement('a');
      call.className = 'mini-btn is-call';
      call.href = `tel:${String(row.phone).replace(/[^\d+]/g, '')}`;
      call.textContent = 'Call';
      actions.append(call);
    }
    actions.append(jumpButton(row));
    node.append(when, main, actions);
    return { node, actions };
  }

  function meetingRow(row, areaId, upcoming = false) {
    const when = upcoming
      ? `${A.formatDate(row.meeting_at)} ${A.formatTime(row.meeting_at)}`
      : A.formatTime(row.meeting_at);
    const { node, actions } = agendaRowShell(when, false, row, areaId);
    const link = A.calendarLink(row);
    if (link) {
      const cal = document.createElement('a');
      cal.className = 'mini-btn is-cal';
      cal.href = link;
      cal.target = '_blank';
      cal.rel = 'noopener noreferrer';
      cal.textContent = '📅';
      cal.title = 'Add to Google Calendar';
      actions.append(cal);
    }
    return node;
  }

  function followUpRow(row, areaId) {
    const overdue = A.daysUntil(row.follow_up_date) < 0;
    return agendaRowShell(A.dueLabel(row.follow_up_date), overdue, row, areaId).node;
  }

  /* Jumping from the panel to the card. Inside an area it scrolls; from the
     landing page it opens the area first, then scrolls. */
  function jumpButton(row) {
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'mini-btn';
    jump.textContent = 'Open';
    jump.addEventListener('click', async () => {
      if (!state.area || state.area.id !== row.area_id) {
        await openArea(row.area_id);
      }
      // Clear any lens that would hide the row he just asked to see.
      if (prefs.status !== 'all' || prefs.industry !== 'all' || prefs.search) {
        prefs.status = 'all';
        prefs.industry = 'all';
        prefs.search = '';
        savePrefs();
        render();
      }
      highlightCard(row.id);
    });
    return jump;
  }

  function highlightCard(id) {
    const card = document.getElementById(`fac-${id}`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('is-target');
    setTimeout(() => card.classList.remove('is-target'), 1600);
  }

  /* ---------------- landing ---------------- */

  async function loadAreas() {
    try {
      const data = await api('/api/areas');
      state.areas = data.areas || [];
      state.preview = false;
      hideBanner();
    } catch (err) {
      state.areas = [SAMPLE.area];
      state.preview = true;
      showBanner(
        API_BASE
          ? 'Preview mode — the API is unreachable, showing sample data.'
          : 'Preview mode — no API configured, showing sample data. Point apiBase in config.js at the deployed Worker.'
      );
      if (!(err instanceof ApiUnavailable)) console.warn(err);
    }
    renderAreas();
  }

  function renderAreas() {
    renderToday(el.todayLanding);
    el.areaList.innerHTML = '';
    if (!state.areas.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-routes';
      empty.textContent = 'No areas yet. Pull one and the list is ready in about ten seconds.';
      el.areaList.append(empty);
      return;
    }
    for (const area of state.areas) {
      const total = Number(area.facility_count || 0);
      // Lead with the usable list, not the raw total — the same rule as
      // route-caller. visible_count comes from the server and reflects the
      // default hides, so a restored category on this device reads a little low.
      const visible = Number(area.visible_count ?? total);
      const hidden = Math.max(0, total - visible);
      const called = Number(area.called_count || 0);
      const noSite = Number(area.no_website_count || 0);

      const item = document.createElement('button');
      item.className = 'route-item';
      item.type = 'button';
      item.innerHTML = `
        <h3></h3>
        <div class="route-lead"></div>
        <div class="area-funnel"></div>
        <div class="route-meta"></div>
        <div><span class="area-lead-note"></span></div>
        <div class="progress-track"><div class="progress-fill"></div></div>`;
      item.querySelector('h3').textContent = area.name;

      const lead = item.querySelector('.route-lead');
      const funnel = item.querySelector('.area-funnel');
      const meta = item.querySelector('.route-meta');
      const note = item.querySelector('.area-lead-note');
      if (!total) {
        lead.textContent = 'No businesses found in this area';
        funnel.remove();
        meta.textContent = '';
        note.remove();
      } else {
        lead.textContent = `${visible} business${visible === 1 ? '' : 'es'} to call`;
        // The funnel, one muted line. Cumulative: every won came from a meeting,
        // every meeting from a reach. The lead count stays the headline.
        const reached = Number(area.reached_count || 0);
        const meetings = Number(area.meeting_count || 0);
        const won = Number(area.won_count || 0);
        funnel.innerHTML =
          `<b>${visible}</b> leads · <b>${reached}</b> reached · ` +
          `<b>${meetings}</b> meeting${meetings === 1 ? '' : 's'} · ` +
          `<b class="is-won">${won}</b> won`;
        meta.textContent =
          `${milesLabel(area.radius_m)} around ${area.center_address}` +
          (hidden ? ` · ${total} found, ${hidden} hidden` : '');
        // The headline. This is the number Vertizin is actually buying.
        note.textContent = `${noSite} with no website`;
      }
      item.querySelector('.progress-fill').style.width =
        visible ? `${Math.round((called / visible) * 100)}%` : '0%';
      item.addEventListener('click', () => openArea(area.id));
      el.areaList.append(item);
    }
  }

  /* ---------------- call list ---------------- */

  async function openArea(id) {
    if (state.preview) {
      state.area = SAMPLE.area;
      const dates = new Map(SAMPLE.agenda.map((r) => [r.id, r]));
      state.facilities = SAMPLE.facilities.map((f) => ({
        ...f,
        meeting_at: dates.get(f.id)?.meeting_at ?? f.meeting_at ?? null,
        follow_up_date: dates.get(f.id)?.follow_up_date ?? f.follow_up_date ?? null,
      }));
    } else {
      try {
        const data = await api(`/api/areas/${id}`);
        state.area = data.area;
        state.facilities = data.facilities || [];
      } catch (err) {
        showBanner(err.message, true);
        return;
      }
    }
    prefs.areaId = id;
    savePrefs();
    cardUi.clear();
    show('list');
    render();
  }

  /** Short label for the navy badge — the town, not the whole address. */
  function areaBadge(area) {
    const town = String(area?.center_address || '').split(',')[0].trim();
    return (town || area?.name || 'AREA').slice(0, 12).toUpperCase();
  }

  /* The junk categories, hidden by default. Each is a flag on the row; the data
     is always in D1 and Restore is one tap. */
  const CATEGORIES = [
    { key: 'franchise', label: 'franchises', test: (f) => f.is_franchise },
    { key: 'supplier', label: 'suppliers and retail', test: (f) => f.is_supplier_or_retail },
  ];

  const isRestored = (key) => prefs.restored.includes(key);

  function hiddenBy(f) {
    return CATEGORIES.find((c) => c.test(f) && !isRestored(c.key)) || null;
  }

  const industriesOf = (f) =>
    String(f.industries || f.industry || '').split(',').map((s) => s.trim()).filter(Boolean);

  /* Her list: everything in the area minus the categories she has chosen to
     hide. The industry chip narrows it too — unlike search and status, the chip
     IS a scope, because "I am calling HVAC today" is a different list, not a
     lens on one. */
  function listScope() {
    return state.facilities.filter((f) => {
      if (hiddenBy(f)) return false;
      if (prefs.industry !== 'all' && !industriesOf(f).includes(prefs.industry)) return false;
      return true;
    });
  }

  /* True when this area came back under the lean Places field mask: every
     website is null, so "no website" would be a property of the pull rather
     than of the business. Don't show a lead signal we can't stand behind. */
  function areaHasWebsiteData() {
    return state.facilities.some((f) => f.website);
  }

  function visibleFacilities() {
    const term = prefs.search.trim().toLowerCase();
    const websiteData = areaHasWebsiteData();
    const list = listScope().filter((f) => {
      // `called` is really "reached": any status except not_called. A voicemail
      // is progress through the list even though nobody answered.
      if (prefs.status === 'called' && f.status === 'not_called') return false;
      if (prefs.status === 'flagged' && !f.flagged) return false;
      if (prefs.status === 'no_website' && (f.website || !websiteData)) return false;
      // Pipeline: everything that got as far as a booked brainstorm.
      if (prefs.status === 'pipeline' && !A.MEETING_STATUSES.includes(f.status)) return false;
      // Any bare status key filters to exactly that status.
      if (A.STATUS_KEYS.includes(prefs.status) && f.status !== prefs.status) return false;
      if (term) {
        const hay = [f.name, f.city, f.zip, f.address].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
    const sort = SORTS[prefs.sort] || SORTS.lead;
    return list.slice().sort(sort.compare);
  }

  function renderIndustryChips() {
    el.industryChips.innerHTML = '';
    const present = new Set();
    for (const f of state.facilities) for (const k of industriesOf(f)) present.add(k);
    if (present.size <= 1) return; // one trade — a filter with one option is noise

    const options = [
      { key: 'all', label: 'All' },
      ...state.industries.filter((i) => present.has(i.key)),
      // An area may hold a trade the menu no longer lists; still offer it.
      ...[...present]
        .filter((k) => !state.industries.some((i) => i.key === k))
        .map((k) => ({ key: k, label: k })),
    ];
    for (const option of options) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = option.label;
      chip.setAttribute('aria-pressed', String(prefs.industry === option.key));
      chip.addEventListener('click', () => {
        prefs.industry = option.key;
        savePrefs();
        render();
      });
      el.industryChips.append(chip);
    }
  }

  function renderSortSelect() {
    if (!el.sortSelect.options.length) {
      for (const [key, sort] of Object.entries(SORTS)) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = sort.label;
        el.sortSelect.append(option);
      }
      el.sortSelect.addEventListener('change', () => {
        prefs.sort = el.sortSelect.value;
        savePrefs();
        render();
      });
    }
    el.sortSelect.value = prefs.sort;
  }

  function render() {
    if (!state.area) return;
    const list = visibleFacilities();
    const websiteDataAvailable = areaHasWebsiteData();

    renderToday(el.todayArea, state.area.id);

    el.badge.textContent = areaBadge(state.area);
    el.title.textContent = `${state.area.name} — Call List`;

    const scope = listScope();
    const noSite = scope.filter((f) => !f.website).length;
    el.subtitle.textContent = [
      `${milesLabel(state.area.radius_m)} around ${String(state.area.center_address).split(',')[0]}`,
      `Sorted by ${(SORTS[prefs.sort] || SORTS.lead).label.toLowerCase()}`,
    ].join(' · ');

    const called = scope.filter((f) => f.status !== 'not_called').length;
    const flagged = scope.filter((f) => f.flagged).length;
    el.counters.innerHTML =
      `<b>${called}</b> called · <b>${scope.length - called}</b> left · ` +
      `<b>${flagged}</b> flagged` +
      (websiteDataAvailable ? ` · <b>${noSite}</b> with no website` : '');

    el.search.value = prefs.search;
    el.filterStatus.value = prefs.status;
    renderIndustryChips();
    renderSortSelect();

    el.cards.innerHTML = '';
    list.forEach((f) => el.cards.append(facilityCard(f, websiteDataAvailable)));
    renderHidden(websiteDataAvailable);

    el.empty.hidden = list.length > 0;
    if (!list.length) {
      el.empty.textContent = state.facilities.length
        ? 'Nothing matches these filters. Tap Clear to see the whole list.'
        : 'No businesses were found in this area.';
    }
    if (prefs.mapOpen) drawMap(list);
  }

  /* The hidden rows: summarised in one line, expandable, never lost. */
  function renderHidden(websiteDataAvailable) {
    const grouped = new Map();
    for (const f of state.facilities) {
      if (prefs.industry !== 'all' && !industriesOf(f).includes(prefs.industry)) continue;
      const category = hiddenBy(f);
      if (!category) continue;
      if (!grouped.has(category.key)) grouped.set(category.key, { category, rows: [] });
      grouped.get(category.key).rows.push(f);
    }

    const total = [...grouped.values()].reduce((sum, g) => sum + g.rows.length, 0);
    el.hiddenBar.hidden = total === 0;
    if (!total) return;

    const parts = [...grouped.values()].map((g) => `${g.category.label} ${g.rows.length}`);
    el.hiddenSummary.textContent =
      `Hidden: ${total} business${total === 1 ? '' : 'es'} (${parts.join(', ')})`;
    el.toggleHidden.textContent = prefs.showHidden ? 'Hide' : 'Show';
    el.toggleHidden.setAttribute('aria-expanded', String(prefs.showHidden));
    if (!prefs.showHidden) return;

    const sort = SORTS[prefs.sort] || SORTS.lead;
    for (const { category, rows } of grouped.values()) {
      rows.sort(sort.compare);
      for (const f of rows) {
        const card = facilityCard(f, websiteDataAvailable);
        card.classList.add('is-hidden-row');
        const sub = card.querySelector('.fac-sub');
        const reason = document.createElement('span');
        reason.className = 'hidden-reason';
        reason.textContent = category.label;
        sub.append(reason);
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'restore-btn';
        restore.textContent = `Restore ${category.label}`;
        restore.addEventListener('click', () => {
          prefs.restored = [...new Set([...prefs.restored, category.key])];
          savePrefs();
          render();
        });
        sub.append(restore);
        el.cards.append(card);
      }
    }
  }

  function facilityCard(f, websiteDataAvailable = true) {
    const card = document.createElement('article');
    // `is-called` mutes a worked row; the pipeline states override it, because a
    // booked meeting and a won deal are the opposite of done-with.
    card.className =
      'fac-card' +
      (f.status !== 'not_called' ? ' is-called' : '') +
      (f.status === 'meeting_set' ? ' is-meeting' : '') +
      (f.status === 'won' ? ' is-won' : '') +
      (CLOSED_STATUSES.includes(f.status) ? ' is-closed' : '');
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

    // Rating + review count: the "established business" proxy, on every card.
    const rating = document.createElement('span');
    if (f.review_count != null) {
      rating.className = 'rating';
      rating.innerHTML =
        `<span class="stars">★</span> ${f.rating ?? '–'} ` +
        `<span class="reviews">(${f.review_count})</span>`;
      rating.title = `${f.review_count} Google reviews`;
    } else {
      rating.className = 'rating unrated';
      rating.textContent = 'no rating';
      rating.title = 'Google returned no rating for this business on the last pull.';
    }
    title.append(rating);

    const sub = document.createElement('div');
    sub.className = 'fac-sub';
    const where = [[f.city, f.zip].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    if (where) sub.append(document.createTextNode(where));

    for (const key of industriesOf(f)) {
      const tag = document.createElement('span');
      tag.className = 'industry-tag';
      tag.textContent = state.industries.find((i) => i.key === key)?.label || key;
      sub.append(tag);
    }

    if (!f.website && websiteDataAvailable) {
      // The headline lead signal. Styled as a GREEN FLAG, not a gap.
      const pill = document.createElement('span');
      pill.className = 'flag-badge no-website-lead';
      pill.textContent = 'No website';
      pill.title = 'Google lists no website for this business — the whole pitch.';
      sub.append(pill);
    } else if (f.website) {
      const link = document.createElement('a');
      link.className = 'site-link';
      link.href = f.website;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = String(f.website).replace(/^https?:\/\//, '').replace(/\/$/, '');
      sub.append(link);
    }
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
    notes.placeholder = 'Owner name, current marketing spend, callback';
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
    // Pipeline order, so the dropdown reads as the funnel it is.
    for (const status of A.STATUSES) {
      const option = document.createElement('option');
      option.value = status.key;
      option.textContent = status.label;
      select.append(option);
    }
    select.value = f.status || 'not_called';
    select.addEventListener('change', () => onStatusChosen(f, select.value, select));
    const dist = document.createElement('span');
    dist.className = 'dist-note';
    if (f.distance_from_center_m != null) dist.textContent = `${miles(f.distance_from_center_m)} mi out`;
    statusRow.append(select, dist);

    body.append(callRow, notes, statusRow);
    const pipeline = pipelineBlock(f);
    if (pipeline) body.append(pipeline);
    card.append(check, head, body);
    return card;
  }

  /* ---------------- the pipeline on a card ----------------
     Two gates and no gray zone. Choosing `meeting_set` asks for the time in the
     same interaction, because a booked brainstorm with no time on it is exactly
     the soft middle this product refuses to have. Choosing a retryable status
     offers the follow-up chips — one tap, no modal ceremony, and skippable. */

  /* Transient per-card UI, keyed by facility id so it survives the re-render
     that a save triggers. */
  const cardUi = new Map();

  const closeCardUi = (id) => { cardUi.delete(id); render(); };

  /** Tomorrow at 10:00, local — the sensible default for "when shall we talk". */
  function defaultMeetingAt() {
    return `${A.addDays(1)}T10:00`;
  }

  async function onStatusChosen(f, status, select) {
    if (status === 'meeting_set') {
      if (A.isLocalDateTime(f.meeting_at)) {
        // He is putting a previously-booked row back into the pipeline; the
        // time is already stored, so nothing to ask.
        await patchFacility(f.id, { status });
        return;
      }
      cardUi.set(f.id, { mode: 'meeting', value: defaultMeetingAt(), previous: f.status });
      select.value = f.status || 'not_called'; // not committed until a time is set
      render();
      return;
    }
    cardUi.delete(f.id);
    await patchFacility(f.id, { status });
    if (A.RETRYABLE.includes(status) && !f.follow_up_date) {
      cardUi.set(f.id, { mode: 'followup' });
      render();
    }
  }

  function pipelineBlock(f) {
    const ui = cardUi.get(f.id);

    if (ui?.mode === 'meeting') return meetingPicker(f, ui);

    if (f.status === 'meeting_set' && A.isLocalDateTime(f.meeting_at)) {
      const line = document.createElement('div');
      line.className = 'meeting-line';
      const when = document.createElement('span');
      when.className = 'meeting-when';
      when.textContent = `${A.formatDate(f.meeting_at)} at ${A.formatTime(f.meeting_at)}`;
      line.append(when);

      const link = A.calendarLink(f);
      if (link) {
        const cal = document.createElement('a');
        cal.className = 'mini-btn is-cal';
        cal.href = link;
        cal.target = '_blank';
        cal.rel = 'noopener noreferrer';
        cal.textContent = 'Add to Calendar';
        line.append(cal);
      }
      const change = document.createElement('button');
      change.type = 'button';
      change.className = 'chip-quiet';
      change.textContent = 'Change';
      change.addEventListener('click', () => {
        cardUi.set(f.id, { mode: 'meeting', value: f.meeting_at, previous: f.status });
        render();
      });
      line.append(change);
      return line;
    }

    if (A.RETRYABLE.includes(f.status)) {
      if (A.isLocalDate(f.follow_up_date)) return followUpLine(f);
      if (ui?.mode === 'followup') return followUpChips(f);
      // A retry with no date set: offer the chips quietly rather than nagging.
      const line = document.createElement('div');
      line.className = 'followup-line';
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'chip-quiet';
      add.textContent = '+ Follow-up';
      add.addEventListener('click', () => {
        cardUi.set(f.id, { mode: 'followup' });
        render();
      });
      line.append(add);
      return line;
    }

    return null;
  }

  function meetingPicker(f, ui) {
    const row = document.createElement('div');
    row.className = 'when-row';

    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.className = 'when-input';
    input.value = ui.value || defaultMeetingAt();
    input.setAttribute('aria-label', `Meeting time for ${f.name}`);

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'chip-quiet';
    save.textContent = 'Set meeting';
    save.addEventListener('click', async () => {
      // datetime-local gives 'YYYY-MM-DDTHH:MM' — already the local wall-clock
      // string we store. Some browsers append seconds; trim to the minute.
      const value = String(input.value || '').slice(0, 16);
      if (!A.isLocalDateTime(value)) {
        showBanner('Pick a date and a time for the brainstorm.', true);
        return;
      }
      cardUi.delete(f.id);
      await patchFacility(f.id, { status: 'meeting_set', meeting_at: value });
    });

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'chip-quiet is-clear';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => closeCardUi(f.id));

    const hint = document.createElement('span');
    hint.className = 'when-hint';
    hint.textContent = 'A meeting needs a time — that is the whole pipeline.';

    input.addEventListener('input', () => { ui.value = input.value; });
    row.append(input, save, cancel, hint);
    return row;
  }

  function followUpChips(f) {
    const row = document.createElement('div');
    row.className = 'chip-inline';
    for (const chip of A.FOLLOW_UP_CHIPS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip-quiet';
      button.textContent = chip.label;
      button.addEventListener('click', async () => {
        cardUi.delete(f.id);
        await patchFacility(f.id, { follow_up_date: A.followUpDateFor(chip.key) });
      });
      row.append(button);
    }

    const picker = document.createElement('input');
    picker.type = 'date';
    picker.className = 'when-input';
    picker.setAttribute('aria-label', `Follow-up date for ${f.name}`);
    picker.addEventListener('change', async () => {
      const value = String(picker.value || '').slice(0, 10);
      if (!A.isLocalDate(value)) return;
      cardUi.delete(f.id);
      await patchFacility(f.id, { follow_up_date: value });
    });

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'chip-quiet is-clear';
    skip.textContent = 'Skip';
    skip.addEventListener('click', () => closeCardUi(f.id));

    row.append(picker, skip);
    return row;
  }

  function followUpLine(f) {
    const line = document.createElement('div');
    line.className = 'followup-line';
    const overdue = A.daysUntil(f.follow_up_date) < 0;
    const when = document.createElement('span');
    when.className = 'followup-when' + (overdue ? ' is-overdue' : '');
    when.textContent = `Retry ${A.formatDate(f.follow_up_date)}`;
    const label = document.createElement('span');
    label.textContent = A.dueLabel(f.follow_up_date);
    const change = document.createElement('button');
    change.type = 'button';
    change.className = 'chip-quiet';
    change.textContent = 'Change';
    change.addEventListener('click', () => {
      cardUi.set(f.id, { mode: 'followup' });
      render();
    });
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'chip-quiet is-clear';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => patchFacility(f.id, { follow_up_date: null }));
    line.append(when, label, change, clear);
    return line;
  }

  /* ---------------- map ---------------- */

  function drawMap(list) {
    if (typeof L === 'undefined' || state.area?.center_lat == null) return;
    if (!state.map) {
      state.map = L.map('map', { scrollWheelZoom: false });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(state.map);
    }
    if (state.layer) state.layer.remove();
    state.layer = L.layerGroup().addTo(state.map);

    const center = [state.area.center_lat, state.area.center_lng];
    const circle = L.circle(center, {
      radius: Number(state.area.radius_m) || 48280,
      color: '#2E5B41',
      weight: 2,
      fillOpacity: 0.05,
    }).addTo(state.layer);

    list.forEach((f) => {
      if (f.lat == null || f.lng == null) return;
      L.circleMarker([f.lat, f.lng], {
        radius: 6,
        color: '#fff',
        weight: 2,
        // No website is the lead, so it is the colour that stands out.
        fillColor: f.status !== 'not_called' ? '#9AA39E' : f.website ? '#7FA98E' : '#2F7D4F',
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

    state.map.fitBounds(circle.getBounds(), { padding: [16, 16] });
    setTimeout(() => state.map.invalidateSize(), 60);
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
    node.addEventListener('click', async () => {
      show('landing');
      await loadAgenda();
      await loadAreas();
    })
  );

  $('btn-new-area').addEventListener('click', () => {
    el.newError.hidden = true;
    el.formNew.hidden = false;
    el.newLoading.hidden = true;
    renderNewForm();
    show('new');
  });

  el.formNew.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!prefs.newIndustries.length) {
      el.newError.textContent = 'Pick at least one trade.';
      el.newError.hidden = false;
      return;
    }
    const form = new FormData(el.formNew);
    const body = {
      name: String(form.get('name') || '').trim(),
      center_address: String(form.get('center_address') || '').trim(),
      radius_m: prefs.radiusM,
      industries: prefs.newIndustries,
    };
    el.newError.hidden = true;
    el.formNew.hidden = true;
    el.newLoading.hidden = false;
    try {
      const data = await api('/api/areas', { method: 'POST', body: JSON.stringify(body) });
      state.preview = false;
      state.area = data.area;
      state.facilities = data.facilities || [];
      prefs.areaId = data.area.id;
      savePrefs();
      show('list');
      render();
      const meta = data.meta || {};
      if (!state.facilities.length) {
        showBanner('No businesses were found in that area. Try a wider radius.');
      } else if (meta.tile_failures) {
        showBanner(
          `${meta.tile_failures} of the searches failed, so this list may be short. Tell Micaiah.`,
          true
        );
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

  /* Re-check an area in place. Safe on an area she is mid-way through: the
     server never touches status, flags or notes, and verifies that after every
     run. The confirm step says so in her words. */
  el.btnEnrich.addEventListener('click', async () => {
    const ok = window.confirm(
      'Update area data?\n\n' +
        'This re-checks this town for new businesses and fresh review counts. ' +
        'It takes about ten seconds.\n\n' +
        'It never touches your calls, flags or notes.'
    );
    if (!ok) return;

    el.btnEnrich.disabled = true;
    el.btnEnrich.textContent = 'Updating…';
    showEnrichStatus('Re-checking this area…');
    try {
      const data = await api(`/api/areas/${state.area.id}/enrich`, { method: 'POST' });
      state.area = data.area;
      state.facilities = data.facilities || [];
      const e = data.enrichment || {};
      const gained = e.fields_filled || {};
      let message =
        `Updated: ${e.rows_inserted || 0} new business${e.rows_inserted === 1 ? '' : 'es'}, ` +
        `${gained.ratings || 0} refreshed review counts. Your calls and notes are unchanged.`;
      if (e.snapshot_verified === false) {
        message = 'Update finished but the safety check FAILED — tell Micaiah before calling on.';
      } else if (e.tile_failures) {
        message += ` ${e.tile_failures} searches failed, so some businesses may be missing.`;
      }
      showEnrichStatus(message);
      await loadAgenda();
      render();
      loadAreas();
    } catch (err) {
      showEnrichStatus(`Could not update: ${err.message}`, true);
    } finally {
      el.btnEnrich.disabled = false;
      el.btnEnrich.textContent = 'Update area data';
    }
  });

  el.toggleHidden.addEventListener('click', () => {
    prefs.showHidden = !prefs.showHidden;
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
    prefs.industry = 'all';
    prefs.sort = 'lead';
    // Clear returns to the assumed-clean list: junk hidden, nothing restored.
    prefs.restored = [];
    prefs.showHidden = false;
    savePrefs();
    render();
  });

  window.addEventListener('online', flushQueue);

  /* ---------------- preview data ----------------
     Only ever shown when the API is unreachable, and always behind the
     "Preview mode" banner. Nothing here is written anywhere. */
  const SAMPLE = {
    area: {
      id: 'sample',
      name: 'Huntsville — Sample',
      center_address: 'Huntsville, AL',
      center_lat: 34.7304,
      center_lng: -86.5861,
      radius_m: 48280,
      industries: '["hvac","plumbing"]',
      facility_count: 5,
      visible_count: 4,
      no_website_count: 3,
      called_count: 2,
      reached_count: 2,
      meeting_count: 1,
      won_count: 0,
    },
    facilities: [
      { id: 's1', name: 'Anything Plumbing', city: 'Huntsville', zip: '35801', phone: '(256) 555-0142', website: null, rating: 4.9, review_count: 68, lat: 34.72, lng: -86.6, industry: 'plumbing', industries: 'plumbing', distance_from_center_m: 15000, is_franchise: 0, is_supplier_or_retail: 0, status: 'not_called', flagged: 0, notes: '' },
      { id: 's2', name: 'Valley Heating & Cooling', city: 'Madison', zip: '35758', phone: '(256) 555-0198', website: null, rating: 4.8, review_count: 3220, lat: 34.7, lng: -86.75, industry: 'hvac', industries: 'hvac,plumbing', distance_from_center_m: 18000, is_franchise: 0, is_supplier_or_retail: 0, status: 'meeting_set', meeting_at: null, follow_up_date: null, flagged: 1, notes: 'Ask for the owner, back Thursday.' },
      { id: 's3', name: 'Ala-Ten Plumbing LLC', city: 'Ardmore', zip: '35739', phone: '(256) 555-0117', website: null, rating: 5, review_count: 37, lat: 34.99, lng: -86.85, industry: 'plumbing', industries: 'plumbing', distance_from_center_m: 22500, is_franchise: 0, is_supplier_or_retail: 0, status: 'no_answer', meeting_at: null, follow_up_date: null, flagged: 0, notes: '' },
      { id: 's4', name: 'Conditioned Air Solutions', city: 'Huntsville', zip: '35806', phone: '(256) 555-0163', website: 'https://example.com', rating: 4.9, review_count: 3338, lat: 34.75, lng: -86.65, industry: 'hvac', industries: 'hvac', distance_from_center_m: 8000, is_franchise: 0, is_supplier_or_retail: 0, status: 'not_called', flagged: 0, notes: '' },
      { id: 's5', name: 'Roto-Rooter Plumbing & Drain', city: 'Huntsville', zip: '35805', phone: '(256) 555-0121', website: 'https://example.com', rating: 4.4, review_count: 900, lat: 34.71, lng: -86.59, industry: 'plumbing', industries: 'plumbing', distance_from_center_m: 4000, is_franchise: 1, is_supplier_or_retail: 0, status: 'not_called', flagged: 0, notes: '' },
    ],
    // Built relative to today so the preview panel is never empty or stale.
    get agenda() {
      return [
        {
          id: 's2', area_id: 'sample', area_name: 'Huntsville — Sample',
          name: 'Valley Heating & Cooling', phone: '(256) 555-0198',
          status: 'meeting_set', meeting_at: `${A.todayISO()}T14:00`,
          follow_up_date: null, notes: 'Ask for the owner.',
        },
        {
          id: 's3', area_id: 'sample', area_name: 'Huntsville — Sample',
          name: 'Ala-Ten Plumbing LLC', phone: '(256) 555-0117',
          status: 'no_answer', meeting_at: null, follow_up_date: A.addDays(-2),
        },
      ];
    },
  };

  /* ---------------- boot ---------------- */

  el.mapPanel.hidden = !prefs.mapOpen;
  el.toggleMap.setAttribute('aria-expanded', String(prefs.mapOpen));
  show('landing');
  flushQueue();
  loadIndustries();
  loadAreas()
    .then(loadAgenda)
    .then(() => {
      renderAreas();
      if (prefs.areaId && state.areas.some((a) => a.id === prefs.areaId)) {
        return openArea(prefs.areaId);
      }
      return null;
    });
})();
