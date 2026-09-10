/* ================================================================
   JT ATTENDANCE PORTAL — script.js
   Jesus Tribe Abuja — v2.3
   Changes from v2.2:
   - Backend URL is now HARDCODED (see CONFIG.WEB_APP_URL).
     The Settings screen no longer allows the user to change it.
   - Legacy localStorage key 'jt_backend_url' is purged on init.
   - apiFetch error message points to source, not Settings.

   Changes from v2.1:
   - DOB field replaced with 3-select picker (day/month/year)
   - Service switch re-runs search so mark-state refreshes
   - Offline queue deduplication (memberId + service + date)
   - Undo failure handling — re-adds entry if server undo fails
   - formatDisplayDate handles full ISO timestamps safely
   - Print stylesheet injected for PDF reports
================================================================ */

'use strict';

/* ── 1. CONFIGURATION ──────────────────────────────────────── */
const CONFIG = {
  // FIXED backend endpoint — hardcoded at build time.
  // To point at a different deployment, edit this string and re-ship.
  WEB_APP_URL: 'https://script.google.com/macros/s/AKfycbzS-j3fLTZZDnaf4SU9t5tgdy_14wKUjBZBM_bo8doVyoEyZgJiPBJ44-dp-L4q8Ei00Q/exec',
  CACHE_TTL_MS: 5 * 60 * 1000,
  LOG_PAGE_SIZE: 20,
  UNDO_TIMEOUT_MS: 8000,
  DEBOUNCE_MS: 300,
  OFFLINE_SYNC_INTERVAL_MS: 30000,
};

/* ── 2. STATE ──────────────────────────────────────────────── */
const STATE = {
  pinUnlocked: false,
  members: [],
  memberCacheTime: 0,
  selectedService: 'First',
  todayLog: [],
  logFilter: 'All',
  logPage: 1,
  searchDebounceTimer: null,
  offeringService: 'First',
  todayOfferings: [],
  memberSearchQuery: '',
  memberSort: 'recent',
  memberGenderFilter: 'all',
  analyticsRange: 'all',
  charts: {},
  reportPeriod: 'this-month',
  undoTimer: null,
  lastMarked: null,
  offlineQueue: JSON.parse(localStorage.getItem('jt_offline_queue') || '[]'),
  syncIntervalId: null,
};

/* ── 3. DOM HELPERS ────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

/* ── 4. PIN SYSTEM ─────────────────────────────────────────── */
(function initPIN() {
  const overlay   = $('pinOverlay');
  const subText   = $('pinSubText');
  const setupNote = $('pinSetupNote');
  const dots      = [0,1,2,3].map(i => $(`pd${i}`));
  const del       = $('pinDel');
  let   entry     = '';
  let   setupPhase = null;
  let   firstEntry = '';

  const STORAGE_KEY = 'jt_pin_hash';

  function hashPIN(pin) {
    let h = 0;
    for (let i = 0; i < pin.length; i++) { h = (Math.imul(31, h) + pin.charCodeAt(i)) | 0; }
    return String(h);
  }

  function renderDots() {
    dots.forEach((d, i) => d.classList.toggle('filled', i < entry.length));
  }

  function resetEntry(msg, isError = false) {
    entry = '';
    renderDots();
    subText.textContent = msg;
    subText.classList.toggle('error', isError);
  }

  function unlock() {
    STATE.pinUnlocked = true;
    overlay.classList.add('hidden');
    $('appShell').style.display = 'flex';
    initApp();
  }

  function tryPIN(pin) {
    const stored = localStorage.getItem(STORAGE_KEY);

    if (!stored) {
      if (!setupPhase) {
        setupPhase = 'set';
        firstEntry = pin;
        setupNote.classList.remove('hidden');
        resetEntry('Confirm your new PIN');
        return;
      }
      if (setupPhase === 'set') {
        if (pin === firstEntry) {
          localStorage.setItem(STORAGE_KEY, hashPIN(pin));
          resetEntry('PIN set! Welcome 🎉');
          setTimeout(unlock, 600);
        } else {
          setupPhase = null;
          firstEntry = '';
          resetEntry("PINs didn't match. Try again.", true);
        }
        return;
      }
    }

    if (hashPIN(pin) === stored) {
      resetEntry('✓ Access granted');
      setTimeout(unlock, 400);
    } else {
      resetEntry('Incorrect PIN. Try again.', true);
    }
  }

  $$('.pin-btn[data-val]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (entry.length >= 4) return;
      entry += btn.dataset.val;
      renderDots();
      if (entry.length === 4) setTimeout(() => tryPIN(entry), 120);
    });
  });

  del.addEventListener('click', () => {
    entry = entry.slice(0, -1);
    renderDots();
    subText.classList.remove('error');
  });

  const hasPIN = !!localStorage.getItem(STORAGE_KEY);
  if (!hasPIN) {
    setupNote.classList.remove('hidden');
    subText.textContent = 'Create a 4-digit PIN to secure this app';
  }
  overlay.classList.remove('hidden');
  $('appShell').style.display = 'none';
})();

/* ── 5. CHANGE PIN ─────────────────────────────────────────── */
function changePIN() {
  const old = $('oldPin').value.trim();
  const nw  = $('newPin').value.trim();
  const cf  = $('confirmPin').value.trim();
  const STORAGE_KEY = 'jt_pin_hash';
  function hash(p) { let h=0; for(let i=0;i<p.length;i++){h=(Math.imul(31,h)+p.charCodeAt(i))|0;} return String(h); }

  if (old.length !== 4 || nw.length !== 4 || cf.length !== 4) return showToast('All fields require 4 digits', 'error');
  if (hash(old) !== localStorage.getItem(STORAGE_KEY)) return showToast('Current PIN is incorrect', 'error');
  if (nw !== cf) return showToast("New PINs don't match", 'error');

  localStorage.setItem(STORAGE_KEY, hash(nw));
  closePinChangeModal();
  showToast('PIN updated successfully', 'success');
}

function closePinChangeModal() {
  $('pinChangeModal').classList.add('hidden');
  ['oldPin','newPin','confirmPin'].forEach(id => $(id).value = '');
}

/* ── 6. APP INIT ───────────────────────────────────────────── */
function initApp() {
  // FIX: The URL is now fixed in code — remove any stale value left
  // behind by older builds so it can never be read again.
  localStorage.removeItem('jt_backend_url');

  loadServiceNames();
  buildDobSelects();           // FIX: build DOB dropdowns once
  injectPrintStyles();         // FIX: print stylesheet for PDF reports
  setupNavigation();
  setupHomeEvents();
  setupMembersEvents();
  setupOfferingsEvents();
  setupAnalyticsEvents();
  setupReportsEvents();
  setupSettingsEvents();
  loadMembersCache();
  loadTodayLog();
  loadTodayOfferings();
  startOfflineSyncLoop();
  updateSyncBadge();
  renderCounters();
}

/* ── 7. DOB SELECT BUILDER ─────────────────────────────────── */
// FIX: Replaces the single <input type="date"> with three native <select>
// elements — Day, Month, Year — so mobile users can jump straight to their
// birth year without scrolling through a drum-roll picker month-by-month.
function buildDobSelects() {
  const dayEl   = $('mDobDay');
  const monthEl = $('mDobMonth');
  const yearEl  = $('mDobYear');

  if (!dayEl || !monthEl || !yearEl) return;

  // Days 1–31
  dayEl.innerHTML = '<option value="">Day</option>' +
    Array.from({ length: 31 }, (_, i) => {
      const v = String(i + 1).padStart(2, '0');
      return `<option value="${v}">${i + 1}</option>`;
    }).join('');

  // Months Jan–Dec
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  monthEl.innerHTML = '<option value="">Month</option>' +
    months.map((m, i) => {
      const v = String(i + 1).padStart(2, '0');
      return `<option value="${v}">${m}</option>`;
    }).join('');

  // Years: current year down to 1940
  const currentYear = new Date().getFullYear();
  yearEl.innerHTML = '<option value="">Year</option>' +
    Array.from({ length: currentYear - 1939 }, (_, i) => {
      const y = currentYear - i;
      return `<option value="${y}">${y}</option>`;
    }).join('');
}

// Helper: read DOB from the three selects and return YYYY-MM-DD or ''
function getDobValue() {
  const d = $('mDobDay').value;
  const m = $('mDobMonth').value;
  const y = $('mDobYear').value;
  return (y && m && d) ? `${y}-${m}-${d}` : '';
}

// Helper: populate the three selects from a YYYY-MM-DD string
function setDobValue(dateStr) {
  if (!dateStr) {
    $('mDobDay').value   = '';
    $('mDobMonth').value = '';
    $('mDobYear').value  = '';
    return;
  }
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    $('mDobYear').value  = parts[0];
    $('mDobMonth').value = parts[1];
    $('mDobDay').value   = parts[2];
  }
}

/* ── 8. PRINT STYLES ───────────────────────────────────────── */
// FIX: Injects a <style media="print"> so the report doesn't print
// as a dark page consuming full ink cartridges.
function injectPrintStyles() {
  const style = document.createElement('style');
  style.media = 'print';
  style.textContent = `
    body { background: #fff !important; color: #000 !important; }
    .app-header, .counter-strip, .tab-bar, .undo-bar,
    .toast-container, #pinOverlay, .btn-primary, .btn-secondary,
    .btn-danger, .report-filters, #generateReportBtn { display: none !important; }
    .page-container { padding: 0 !important; overflow: visible !important; }
    .page { display: flex !important; }
    .page:not(#pageReports) { display: none !important; }
    .card { background: #fff !important; border: 1px solid #ccc !important; box-shadow: none !important; }
    .report-table th, .report-table td { color: #000 !important; border-color: #ccc !important; }
    .report-totals td { background: #f5f5f5 !important; color: #000 !important; }
    .tag.absent { background: #fee !important; color: #900 !important; border-color: #fcc !important; }
    .tag.new-member { background: #efe !important; color: #060 !important; border-color: #cfc !important; }
    .badge { background: #333 !important; }
    .card-title, .card-title i { color: #000 !important; }
    #reportOutput.hidden { display: block !important; }
  `;
  document.head.appendChild(style);
}

/* ── 9. NAVIGATION ─────────────────────────────────────────── */
function setupNavigation() {
  $$('.tab-item').forEach(tab => {
    tab.addEventListener('click', () => navigateTo(tab.dataset.page));
  });
  $('settingsHeaderBtn').addEventListener('click', () => navigateTo('pageSettings'));
}

function navigateTo(pageId) {
  $$('.page').forEach(p => p.classList.remove('active'));
  $$('.tab-item').forEach(t => t.classList.remove('active'));

  $(pageId).classList.add('active');
  const tab = document.querySelector(`.tab-item[data-page="${pageId}"]`);
  if (tab) tab.classList.add('active');

  const titles = {
    pageHome:      'Attendance Desk',
    pageMembers:   'Member Directory',
    pageOfferings: 'Offerings',
    pageAnalytics: 'Analytics',
    pageReports:   'Reports',
    pageSettings:  'Settings',
  };
  $('headerPageTitle').textContent = titles[pageId] || '';

  if (pageId === 'pageAnalytics') renderAnalytics();
  if (pageId === 'pageMembers')   renderMemberGrid();
}

/* ── 10. MEMBER CACHE ──────────────────────────────────────── */
async function loadMembersCache(force = false) {
  const now = Date.now();
  if (!force && STATE.members.length && (now - STATE.memberCacheTime) < CONFIG.CACHE_TTL_MS) return;

  try {
    const data = await apiFetch({ action: 'getMembers' });
    if (data.success && Array.isArray(data.data)) {
      STATE.members = data.data;
      STATE.memberCacheTime = Date.now();
      renderMemberGrid();
      updateMemberStats();
    }
  } catch (e) {
    console.warn('Member cache load failed:', e);
  }
}

function clearMemberCache() {
  STATE.members = [];
  STATE.memberCacheTime = 0;
  showToast('Cache cleared — reloading…', 'info');
  loadMembersCache(true);
}

/* ── 11. HOME PAGE ─────────────────────────────────────────── */
function setupHomeEvents() {
  // Service selector
  // FIX: after switching service, re-run search so "Present"/"Marked"
  // states update immediately for the newly selected service.
  $$('#markCard .svc-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#markCard .svc-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      STATE.selectedService = btn.dataset.service;
      // Re-run search so mark-state reflects the new service choice
      const query = $('searchInput').value.trim();
      if (query) runSearch(query);
    });
  });

  // Search input
  const input = $('searchInput');
  const clear = $('searchClear');

  input.addEventListener('input', () => {
    clear.classList.toggle('hidden', !input.value);
    clearTimeout(STATE.searchDebounceTimer);
    STATE.searchDebounceTimer = setTimeout(() => runSearch(input.value.trim()), CONFIG.DEBOUNCE_MS);
  });

  clear.addEventListener('click', () => {
    input.value = '';
    clear.classList.add('hidden');
    $('searchResults').innerHTML = '';
  });

  // Log filters
  $$('#logCard .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#logCard .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      STATE.logFilter = btn.dataset.filter;
      STATE.logPage = 1;
      renderLogList();
    });
  });

  // Pagination
  $('logPrevBtn').addEventListener('click', () => {
    if (STATE.logPage > 1) { STATE.logPage--; renderLogList(); }
  });
  $('logNextBtn').addEventListener('click', () => {
    const filtered = getFilteredLog();
    const pages = Math.ceil(filtered.length / CONFIG.LOG_PAGE_SIZE);
    if (STATE.logPage < pages) { STATE.logPage++; renderLogList(); }
  });
}

function runSearch(query) {
  const results = $('searchResults');
  if (!query) { results.innerHTML = ''; return; }

  const q = query.toLowerCase();
  const matches = STATE.members.filter(m =>
    m.name?.toLowerCase().includes(q) ||
    String(m.phone || '').replace(/\s/g,'').includes(q.replace(/\s/g,''))
  ).slice(0, 12);

  if (!matches.length) {
    results.innerHTML = `<div class="empty-state"><i class="fa-solid fa-user-slash"></i><p>No member found for "${escHtml(query)}"</p></div>`;
    return;
  }

  results.innerHTML = matches.map(m => buildResultCard(m)).join('');

  results.querySelectorAll('.mark-btn:not(.already-marked)').forEach(btn => {
    btn.addEventListener('click', () => markAttendance(btn.dataset.id));
  });
}

function buildResultCard(m) {
  const initials = getInitials(m.name);
  const genderClass = m.gender?.toLowerCase() === 'male' ? 'male' : '';
  const alreadyMarked = STATE.todayLog.some(l => l.id == m.id && l.service === STATE.selectedService);
  const maskedPhone = maskPhone(m.phone);
  const genderAccent = m.gender?.toLowerCase() === 'male' ? 'male' : 'female';

  return `
    <div class="result-card result-card--${genderAccent}">
      <div class="result-avatar ${genderClass}">${initials}</div>
      <div class="result-info">
        <div class="result-name">${escHtml(m.name)}</div>
        <div class="result-meta">
          <span class="result-meta-tag"><i class="fa-solid fa-${m.gender?.toLowerCase() === 'male' ? 'mars' : 'venus'}"></i> ${escHtml(m.gender || '—')}</span>
          <span class="result-phone-masked">${maskedPhone}</span>
        </div>
      </div>
      <div class="result-action">
        <button class="mark-btn ${alreadyMarked ? 'already-marked' : ''}" data-id="${m.id}">
          ${alreadyMarked ? '<i class="fa-solid fa-check"></i> Marked' : '<i class="fa-solid fa-plus"></i> Present'}
        </button>
      </div>
    </div>`;
}

async function markAttendance(memberId) {
  const member = STATE.members.find(m => m.id == memberId);
  if (!member) return;

  const service = STATE.selectedService;
  const now     = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const today   = formatDate(now);

  if (STATE.todayLog.some(l => l.id == memberId && l.service === service)) {
    showToast(`${member.name} already marked for ${service} service`, 'error');
    return;
  }

  const logEntry = {
    id: memberId,
    name: member.name,
    gender: member.gender,
    service,
    time: timeStr,
    isNew: isNewMemberToday(member),
  };
  STATE.todayLog.unshift(logEntry);
  STATE.lastMarked = { memberId, service, logIndex: 0 };
  renderLogList();
  renderCounters();
  runSearch($('searchInput').value.trim());

  showUndoBar(member.name, service);

  const payload = { action: 'markAttendance', memberId, memberName: member.name, service, date: today };
  try {
    await apiSubmit(payload);
    showToast(`${member.name} marked present`, 'success', `${service} Service · ${timeStr}`);
  } catch (e) {
    showToast('Saved offline — will sync shortly', 'info');
  }
}

// FIX: Undo now waits for the server undo call and reverts the optimistic
// removal if the server returns an error, instead of silently discarding it.
async function undoAttendance() {
  if (!STATE.lastMarked) return;
  const { memberId, service } = STATE.lastMarked;

  // Optimistically remove from local state
  const removedEntry = STATE.todayLog.find(l => l.id == memberId && l.service === service);
  STATE.todayLog = STATE.todayLog.filter(l => !(l.id == memberId && l.service === service));
  clearTimeout(STATE.undoTimer);
  hideUndoBar();
  renderLogList();
  renderCounters();
  runSearch($('searchInput').value.trim());

  try {
    await apiSubmit({ action: 'undoAttendance', memberId, service, date: formatDate(new Date()) });
    showToast('Attendance undone', 'info');
  } catch (e) {
    // Server undo failed — restore the entry so local state stays consistent
    if (removedEntry) {
      STATE.todayLog.unshift(removedEntry);
      renderLogList();
      renderCounters();
      runSearch($('searchInput').value.trim());
    }
    showToast('Undo failed — record remains on server', 'error');
  }

  STATE.lastMarked = null;
}

function showUndoBar(name, service) {
  clearTimeout(STATE.undoTimer);
  $('undoMsg').textContent = `${name} marked for ${service}`;
  $('undoBar').classList.remove('hidden');
  $('undoBtn').onclick = undoAttendance;
  STATE.undoTimer = setTimeout(hideUndoBar, CONFIG.UNDO_TIMEOUT_MS);
}

function hideUndoBar() {
  $('undoBar').classList.add('hidden');
}

/* ── TODAY LOG ─────────────────────────────────────────────── */
async function loadTodayLog() {
  try {
    const data = await apiFetch({ action: 'getAttendance' });
    if (data.success && Array.isArray(data.data)) {
      STATE.todayLog = data.data.map(r => ({
        id: r.memberId,
        name: r.memberName,
        gender: r.gender,
        service: r.service,
        time: r.time,
        isNew: r.isNew || false,
      }));
      renderLogList();
      renderCounters();
    }
  } catch (e) { /* use optimistic local state */ }
}

function getFilteredLog() {
  if (STATE.logFilter === 'All') return STATE.todayLog;
  return STATE.todayLog.filter(l => l.service === STATE.logFilter);
}

function renderLogList() {
  const filtered  = getFilteredLog();
  const list      = $('logList');
  const paginator = $('logPagination');
  const pageSize  = CONFIG.LOG_PAGE_SIZE;
  const pages     = Math.max(1, Math.ceil(filtered.length / pageSize));

  STATE.logPage = Math.min(STATE.logPage, pages);
  const slice = filtered.slice((STATE.logPage - 1) * pageSize, STATE.logPage * pageSize);

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><i class="fa-solid fa-moon"></i><p>No attendance marked yet today</p></div>`;
    paginator.classList.add('hidden');
    return;
  }

  list.innerHTML = slice.map(buildLogItem).join('');
  paginator.classList.toggle('hidden', pages <= 1);
  $('logPageInfo').textContent = `${STATE.logPage} / ${pages}`;
  $('logPrevBtn').disabled = STATE.logPage <= 1;
  $('logNextBtn').disabled = STATE.logPage >= pages;
}

function buildLogItem(entry) {
  const initials = getInitials(entry.name);
  const gClass   = entry.gender?.toLowerCase() === 'male' ? 'male' : '';
  const svcClass = entry.service?.toLowerCase() || 'first';
  const svcLabel = entry.service || 'First';
  const newTag   = entry.isNew ? `<span class="new-visitor-tag">NEW</span>` : '';
  return `
    <div class="log-item ${entry.isNew ? 'new-member-today' : ''}">
      <div class="log-avatar-sm ${gClass}">${initials}</div>
      <div class="log-info">
        <div class="log-name">${escHtml(entry.name)} ${newTag}</div>
        <div class="log-sub">${entry.time || ''}</div>
      </div>
      <span class="log-badge ${svcClass}">${svcLabel}</span>
    </div>`;
}

function renderCounters() {
  const counts = { First: 0, Second: 0, Combined: 0 };
  STATE.todayLog.forEach(l => { if (counts[l.service] !== undefined) counts[l.service]++; });
  const total = counts.First + counts.Second + counts.Combined;

  const ids = { First: 'cnt1st', Second: 'cnt2nd', Combined: 'cntComb' };
  Object.entries(ids).forEach(([svc, id]) => {
    const el     = $(id);
    const oldVal = parseInt(el.textContent) || 0;
    el.textContent = counts[svc];
    if (counts[svc] !== oldVal) {
      el.classList.add('pulse');
      setTimeout(() => el.classList.remove('pulse'), 400);
    }
  });
  $('cntTotal').textContent = total;
}

/* ── 12. MEMBERS PAGE ─────────────────────────────────────── */
function setupMembersEvents() {
  $('addMemberBtn').addEventListener('click', openAddMemberModal);

  $('memberSearch').addEventListener('input', debounce(() => {
    STATE.memberSearchQuery = $('memberSearch').value.trim().toLowerCase();
    renderMemberGrid();
  }, CONFIG.DEBOUNCE_MS));

  $('memberSort').addEventListener('change', () => {
    STATE.memberSort = $('memberSort').value;
    renderMemberGrid();
  });

  $('memberGenderFilter').addEventListener('change', () => {
    STATE.memberGenderFilter = $('memberGenderFilter').value;
    renderMemberGrid();
  });
}

function renderMemberGrid() {
  const grid = $('memberGrid');
  let list   = [...STATE.members];

  if (STATE.memberSearchQuery) {
    const q = STATE.memberSearchQuery;
    list = list.filter(m =>
      m.name?.toLowerCase().includes(q) ||
      String(m.phone || '').includes(q) ||
      m.email?.toLowerCase().includes(q)
    );
  }

  if (STATE.memberGenderFilter !== 'all') {
    list = list.filter(m => m.gender?.toLowerCase() === STATE.memberGenderFilter);
  }

  if (STATE.memberSort === 'az')              list.sort((a,b) => (a.name||'').localeCompare(b.name||''));
  else if (STATE.memberSort === 'za')         list.sort((a,b) => (b.name||'').localeCompare(a.name||''));
  else if (STATE.memberSort === 'recent')     list.sort((a,b) => new Date(b.dateJoined||0) - new Date(a.dateJoined||0));
  else if (STATE.memberSort === 'attendance') list.sort((a,b) => (b.totalAttendance||0) - (a.totalAttendance||0));

  if (!list.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><i class="fa-solid fa-users-slash"></i><p>${STATE.members.length ? 'No members match your filters' : 'No members yet'}</p></div>`;
  } else {
    grid.innerHTML = list.map(buildMemberCard).join('');
    grid.querySelectorAll('.member-card').forEach(card => {
      card.addEventListener('click', () => openProfileModal(card.dataset.id));
    });
  }
  updateMemberStats();
}

function buildMemberCard(m) {
  const initials = getInitials(m.name);
  const gClass   = m.gender?.toLowerCase() === 'male' ? 'male' : '';
  const joined   = m.dateJoined ? formatDisplayDate(m.dateJoined) : '';

  return `
    <div class="member-card" data-id="${m.id}">
      <div class="member-avatar ${gClass}">${initials}</div>
      <div class="member-card-name">${escHtml(m.name)}</div>
      <div class="member-card-sub">${joined}</div>
    </div>`;
}

function buildAttDots(history) {
  const slots = 12;
  const arr   = history.slice(-slots);
  while (arr.length < slots) arr.unshift(null);
  return arr.map(v => `<div class="att-dot ${v === true ? 'present' : ''}"></div>`).join('');
}

function updateMemberStats() {
  const total  = STATE.members.length;
  const male   = STATE.members.filter(m => m.gender?.toLowerCase() === 'male').length;
  const female = STATE.members.filter(m => m.gender?.toLowerCase() === 'female').length;
  $('totalMembersCount').textContent = total;
  $('maleCount').textContent  = male;
  $('femaleCount').textContent = female;
}

/* ── MEMBER MODAL ─────────────────────────────────────────── */
function openAddMemberModal() {
  $('memberModalTitle').textContent = 'Add New Member';
  $('editMemberId').value = '';
  ['mName','mPhone','mParentPhone','mEmail','mAddress'].forEach(id => $(id).value = '');
  $('mGender').value = '';
  setDobValue('');                        // FIX: use DOB helper
  $('mDateJoined').value = formatDate(new Date());
  $('memberModal').classList.remove('hidden');
}

function openEditMemberModal(m) {
  $('memberModalTitle').textContent = 'Edit Member';
  $('editMemberId').value  = m.id;
  $('mName').value         = m.name || '';
  $('mGender').value       = m.gender || '';
  $('mPhone').value        = m.phone || '';
  $('mParentPhone').value  = m.parentPhone || '';
  $('mEmail').value        = m.email || '';
  $('mAddress').value      = m.address || '';
  setDobValue(m.dob || '');              // FIX: use DOB helper
  $('mDateJoined').value   = m.dateJoined || '';
  $('memberModal').classList.remove('hidden');
  $('profileModal').classList.add('hidden');
}

function closeMemberModal() {
  $('memberModal').classList.add('hidden');
}

async function saveMember() {
  const id   = $('editMemberId').value;
  const name = $('mName').value.trim();
  if (!name) { showToast('Full name is required', 'error'); return; }

  const memberData = {
    action:      id ? 'editMember' : 'addMember',
    id,
    name,
    gender:      $('mGender').value,
    phone:       $('mPhone').value.trim(),
    parentPhone: $('mParentPhone').value.trim(),
    email:       $('mEmail').value.trim(),
    address:     $('mAddress').value.trim(),
    dob:         getDobValue(),          // FIX: reads from three selects
    dateJoined:  $('mDateJoined').value,
  };

  $('saveMemberBtn').disabled = true;
  try {
    const res = await apiSubmit(memberData);
    if (res.success) {
      showToast(id ? 'Member updated' : 'Member added', 'success');
      closeMemberModal();
      await loadMembersCache(true);
    } else {
      showToast(res.message || 'Failed to save', 'error');
    }
  } catch (e) {
    showToast('Network error — please retry', 'error');
  } finally {
    $('saveMemberBtn').disabled = false;
  }
}

/* ── PROFILE MODAL ────────────────────────────────────────── */
async function openProfileModal(memberId) {
  const m = STATE.members.find(m => m.id == memberId);
  if (!m) return;

  const gClass   = m.gender?.toLowerCase() === 'male' ? 'male' : '';
  const initials = getInitials(m.name);

  $('profileBody').innerHTML = `
    <div class="profile-header">
      <div class="profile-avatar ${gClass}">${initials}</div>
      <div>
        <div class="profile-name">${escHtml(m.name)}</div>
        <div class="profile-since">Member since ${m.dateJoined ? formatDisplayDate(m.dateJoined) : '—'}</div>
      </div>
    </div>
    <div class="profile-stats">
      <div class="profile-stat"><div class="profile-stat-val" id="ps-sundays">—</div><div class="profile-stat-label">Sundays</div></div>
      <div class="profile-stat"><div class="profile-stat-val" id="ps-streak">—</div><div class="profile-stat-label">Streak</div></div>
      <div class="profile-stat"><div class="profile-stat-val" id="ps-lastseen">—</div><div class="profile-stat-label">Last Seen</div></div>
    </div>
    <div class="attendance-dots" id="ps-dots" style="justify-content:flex-start;margin:4px 0 12px;">
      ${buildAttDots([])}
    </div>
    <div class="profile-fields">
      ${profileField('fa-venus-mars', 'Gender', m.gender)}
      ${profileField('fa-phone', 'Phone', m.phone)}
      ${profileField('fa-phone-volume', "Parent's Phone", m.parentPhone)}
      ${profileField('fa-envelope', 'Email', m.email)}
      ${profileField('fa-location-dot', 'Address', m.address)}
      ${profileField('fa-cake-candles', 'Date of Birth', m.dob ? formatDisplayDate(m.dob) : null)}
    </div>`;

  $('profileEditBtn').onclick   = () => openEditMemberModal(m);
  $('profileDeleteBtn').onclick = () => confirmDeleteMember(m);
  $('profileModal').classList.remove('hidden');

  try {
    const data = await apiFetch({ action: 'getMemberProfile', id: memberId });
    if (data.success && data.data) {
      const p = data.data;
      if ($('ps-sundays'))  $('ps-sundays').textContent  = p.totalAttended ?? 0;
      if ($('ps-streak'))   $('ps-streak').textContent   = p.streak ?? 0;
      if ($('ps-lastseen')) $('ps-lastseen').textContent = p.lastSeen ? formatDisplayDate(p.lastSeen) : 'Never';
      const psDots = $('ps-dots');
      if (psDots && Array.isArray(p.history)) {
        const slots = p.history.slice(0, 12).map(() => true);
        psDots.innerHTML = buildAttDots(slots);
      }
    }
  } catch (e) { /* non-critical — stats stay as dashes */ }
}

function profileField(icon, label, val) {
  if (!val) return '';
  return `
    <div class="profile-field">
      <i class="fa-solid ${icon} profile-field-icon"></i>
      <div>
        <div class="profile-field-label">${label}</div>
        <div class="profile-field-val">${escHtml(String(val))}</div>
      </div>
    </div>`;
}

function closeProfileModal() {
  $('profileModal').classList.add('hidden');
}

/* ── DELETE MEMBER ────────────────────────────────────────── */
let _pendingDeleteId = null;

function confirmDeleteMember(m) {
  _pendingDeleteId = m.id;
  $('deleteConfirmName').textContent = m.name;
  $('deleteConfirmModal').classList.remove('hidden');
  $('confirmDeleteBtn').onclick = executeSoftDelete;
}

function closeDeleteModal() {
  $('deleteConfirmModal').classList.add('hidden');
  _pendingDeleteId = null;
}

async function executeSoftDelete() {
  if (!_pendingDeleteId) return;
  try {
    const res = await apiSubmit({ action: 'softDeleteMember', id: _pendingDeleteId });
    if (res.success) {
      STATE.members = STATE.members.filter(m => m.id != _pendingDeleteId);
      closeDeleteModal();
      closeProfileModal();
      renderMemberGrid();
      showToast('Member removed from directory', 'success');
    } else {
      showToast(res.message || 'Delete failed', 'error');
    }
  } catch (e) {
    showToast('Network error', 'error');
  }
}

/* ── 13. OFFERINGS PAGE ───────────────────────────────────── */
function setupOfferingsEvents() {
  $$('#offeringForm .svc-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#offeringForm .svc-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      STATE.offeringService = btn.dataset.service;
    });
  });
}

async function loadTodayOfferings() {
  try {
    const data = await apiFetch({ action: 'getTodayOfferings', date: formatDate(new Date()) });
    if (data.success && Array.isArray(data.data)) {
      STATE.todayOfferings = data.data;
      renderOfferingHistory();
    }
  } catch (e) {}
}

async function submitOffering() {
  const amount = parseFloat($('offeringAmount').value);
  if (!amount || amount <= 0) { showToast('Enter a valid amount', 'error'); return; }

  const service = STATE.offeringService;
  const date    = formatDate(new Date());
  const btn     = $('submitOfferingBtn');

  btn.disabled = true;
  try {
    const res = await apiSubmit({ action: 'recordOffering', service, amount, date });
    if (res.success) {
      STATE.todayOfferings.push({
        service, amount,
        time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      });
      renderOfferingHistory();
      $('offeringAmount').value = '';
      showToast(`₦${amount.toLocaleString()} recorded for ${service} service`, 'success');
    } else {
      showToast(res.message || 'Failed to record', 'error');
    }
  } catch (e) {
    showToast('Saved offline — will sync', 'info');
    STATE.todayOfferings.push({ service, amount, time: '--:--', offline: true });
    renderOfferingHistory();
    $('offeringAmount').value = '';
    enqueueOffline({ action: 'recordOffering', service, amount, date });
  } finally {
    btn.disabled = false;
  }
}

function renderOfferingHistory() {
  const container = $('offeringHistory');
  if (!STATE.todayOfferings.length) {
    container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-coins"></i><p>No offerings recorded today</p></div>`;
    return;
  }
  container.innerHTML = STATE.todayOfferings.map(o => `
    <div class="offering-record">
      <div>
        <div class="offering-record-svc">${escHtml(o.service)} Service · ${o.time || ''}${o.offline ? ' <span style="color:var(--orange);font-size:0.65rem">(pending sync)</span>' : ''}</div>
      </div>
      <div class="offering-record-amount">₦${Number(o.amount).toLocaleString()}</div>
    </div>`).join('');
}

/* ── 14. ANALYTICS PAGE ───────────────────────────────────── */
function setupAnalyticsEvents() {
  $('analyticsRange').addEventListener('change', () => {
    STATE.analyticsRange = $('analyticsRange').value;
    renderAnalytics();
  });
}

async function renderAnalytics() {
  try {
    const data = await apiFetch({ action: 'getAnalytics', range: STATE.analyticsRange });
    if (!data.success) return;

    const d = data.data;
    renderKPIs(d);
    renderTrendChart(d.trendLabels, d.trendData);
    renderOfferChart(d.offerLabels, d.offerData);
    renderGenderChart(d.maleCount, d.femaleCount);
    renderAvgSvcChart(d.avgFirst, d.avgSecond, d.avgCombined);
    renderGrowthChart(d.growthLabels, d.growthData);
    renderLeaderboard(d.topMembers);
  } catch (e) {
    console.warn('Analytics load failed:', e);
  }
}

function renderKPIs(d) {
  $('kpiTotal').textContent  = d.totalMembers ?? '—';
  $('kpiAvg').textContent    = d.avgAttendance ?? '—';
  $('kpiMale').textContent   = d.totalMembers ? Math.round((d.maleCount / d.totalMembers) * 100) + '%' : '—';
  $('kpiFemale').textContent = d.totalMembers ? Math.round((d.femaleCount / d.totalMembers) * 100) + '%' : '—';
}

function buildChart(id, config) {
  if (STATE.charts[id]) STATE.charts[id].destroy();
  const ctx = $(id).getContext('2d');
  STATE.charts[id] = new Chart(ctx, config);
}

// FIX: Resolve chart colors dynamically from CSS variables at call time,
// not once at module load. This makes them work correctly if the user's
// system switches light/dark mode mid-session.
function getChartColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    text:   style.getPropertyValue('--text-secondary').trim() || '#9a9690',
    orange: '#e8621a',
    blue:   '#4a9eff',
    green:  '#3dba7e',
    pink:   '#e879a0',
    grid:   'rgba(255,255,255,0.06)',
  };
}

function chartScales(yLabel = '') {
  const C = getChartColors();
  return {
    x: {
      grid:  { color: C.grid },
      ticks: { color: C.text, font: { family: 'Montserrat', size: 10 } },
    },
    y: {
      grid:  { color: C.grid },
      ticks: { color: C.text, font: { family: 'Montserrat', size: 10 } },
      title: yLabel ? { display: true, text: yLabel, color: C.text } : undefined,
    },
  };
}

function chartLegend() {
  const C = getChartColors();
  return { labels: { color: C.text, font: { family: 'Montserrat', size: 10 }, boxWidth: 10 } };
}

function renderTrendChart(labels = [], data = []) {
  const C = getChartColors();
  buildChart('trendChart', {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Total Attendance',
        data,
        borderColor: C.orange,
        backgroundColor: 'rgba(232,98,26,0.12)',
        borderWidth: 2,
        pointBackgroundColor: C.orange,
        pointRadius: 4,
        fill: true,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: chartLegend() },
      scales: chartScales('Members'),
    },
  });
}

function renderOfferChart(labels = [], data = []) {
  const C = getChartColors();
  buildChart('offerChart', {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Offering (₦)',
        data,
        backgroundColor: 'rgba(232,98,26,0.7)',
        borderColor: C.orange,
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: chartLegend() },
      scales: chartScales('₦'),
    },
  });
}

function renderGenderChart(male = 0, female = 0) {
  const C = getChartColors();
  buildChart('genderChart', {
    type: 'doughnut',
    data: {
      labels: ['Male', 'Female'],
      datasets: [{ data: [male, female], backgroundColor: [C.blue, C.pink], borderWidth: 0 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: chartLegend() },
      cutout: '65%',
    },
  });
}

function renderAvgSvcChart(first = 0, second = 0, combined = 0) {
  const C = getChartColors();
  buildChart('avgSvcChart', {
    type: 'doughnut',
    data: {
      labels: ['1st Service', '2nd Service', 'Combined'],
      datasets: [{
        data: [first, second, combined],
        backgroundColor: [C.orange, C.blue, C.green],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: chartLegend() },
      cutout: '65%',
    },
  });
}

function renderGrowthChart(labels = [], data = []) {
  const C = getChartColors();
  buildChart('growthChart', {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Cumulative Members',
        data,
        borderColor: C.green,
        backgroundColor: 'rgba(61,186,126,0.10)',
        borderWidth: 2,
        pointBackgroundColor: C.green,
        pointRadius: 3,
        fill: true,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: chartLegend() },
      scales: chartScales('Members'),
    },
  });
}

function renderLeaderboard(top = []) {
  const lb = $('leaderboard');
  if (!top.length) {
    lb.innerHTML = `<div class="empty-state"><i class="fa-solid fa-trophy"></i><p>No data yet</p></div>`;
    return;
  }
  const max = top[0]?.count || 1;
  lb.innerHTML = top.map((m, i) => `
    <div class="lb-item" style="animation-delay:${i * 0.04}s">
      <div class="lb-rank ${i < 3 ? 'top' : ''}">${i + 1}</div>
      <div class="lb-name">${escHtml(m.name)}</div>
      <div class="lb-bar-wrap"><div class="lb-bar" style="width:${Math.round((m.count / max) * 100)}%"></div></div>
      <div class="lb-count">${m.count}</div>
    </div>`).join('');
}

/* ── 15. REPORTS PAGE ─────────────────────────────────────── */
function setupReportsEvents() {
  $$('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      STATE.reportPeriod = btn.dataset.period;
    });
  });
}

async function generateReport() {
  const btn = $('generateReportBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating…';

  try {
    const data = await apiFetch({ action: 'generateReport', period: STATE.reportPeriod });
    if (!data.success) throw new Error(data.message);
    renderReport(data.data);
    $('reportOutput').classList.remove('hidden');
  } catch (e) {
    showToast('Failed to generate report: ' + (e.message || ''), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-chart-bar"></i> Generate Report';
  }
}

function renderReport(r) {
  const tbody = $('reportTableBody');
  let t1=0, t2=0, tC=0, tT=0, tO=0;

  tbody.innerHTML = (r.rows || []).map(row => {
    t1 += row.first||0; t2 += row.second||0; tC += row.combined||0;
    tT += row.total||0; tO += row.offering||0;
    return `<tr>
      <td>${row.date}</td>
      <td>${row.first||0}</td>
      <td>${row.second||0}</td>
      <td>${row.combined||0}</td>
      <td>${row.total||0}</td>
      <td>₦${(row.offering||0).toLocaleString()}</td>
    </tr>`;
  }).join('');

  $('rTot1').textContent = t1;
  $('rTot2').textContent = t2;
  $('rTotC').textContent = tC;
  $('rTotT').textContent = tT;
  $('rTotO').textContent = '₦' + tO.toLocaleString();

  const absentees = r.absentees || [];
  $('absenteeBadge').textContent = absentees.length;
  $('absenteeList').innerHTML = absentees.length
    ? absentees.map(n => `<span class="tag absent">${escHtml(n)}</span>`).join('')
    : '<p class="helper-text">None — great turnout!</p>';

  const newMembers = r.newMembers || [];
  $('newMemberBadge').textContent = newMembers.length;
  $('newMemberList').innerHTML = newMembers.length
    ? newMembers.map(n => `<span class="tag new-member">${escHtml(n)}</span>`).join('')
    : '<p class="helper-text">No new members this period</p>';
}

async function downloadReportPDF() {
  showToast('Preparing PDF…', 'info');
  window.print();
}

/* ── 16. SETTINGS PAGE ────────────────────────────────────── */
function setupSettingsEvents() {
  $('changePinBtn').addEventListener('click', () => $('pinChangeModal').classList.remove('hidden'));

  // FIX: Backend URL is fixed in code — the input is display-only and
  // the Edit button is disabled. Guards make this safe even if either
  // node is ever removed from index.html.
  const urlInput = $('backendUrlInput');
  if (urlInput) {
    urlInput.value    = CONFIG.WEB_APP_URL;
    urlInput.readOnly = true;
    urlInput.classList.remove('hidden');   // show it so admins can verify the endpoint
  }
  const editBtn = $('editUrlBtn');
  if (editBtn) {
    editBtn.disabled    = true;
    editBtn.textContent = 'Fixed';
    editBtn.title       = 'Backend URL is set in script.js and cannot be changed here';
  }

  $('manualSyncBtn').addEventListener('click', flushOfflineQueue);
}

function loadServiceNames() {
  const names = JSON.parse(localStorage.getItem('jt_service_names') || 'null');
  if (names) {
    $('svcName1').value = names[0] || 'First';
    $('svcName2').value = names[1] || 'Second';
    $('svcName3').value = names[2] || 'Combined';
  }
}

function saveServiceNames() {
  const names = [
    $('svcName1').value.trim(),
    $('svcName2').value.trim(),
    $('svcName3').value.trim(),
  ];
  localStorage.setItem('jt_service_names', JSON.stringify(names));
  showToast('Service names saved', 'success');
  const services = ['First','Second','Combined'];
  $$('.svc-btn').forEach(btn => {
    const idx = services.indexOf(btn.dataset.service);
    if (idx !== -1 && names[idx]) btn.textContent = names[idx];
  });
}

async function testConnection() {
  const status = $('connStatus');
  status.textContent = 'Testing…';
  try {
    const data = await apiFetch({ action: 'ping' });
    if (data.success) {
      status.textContent = '✓ Connected — ' + new Date().toLocaleTimeString();
      showToast('Backend connection successful', 'success');
    } else {
      status.textContent = '✗ Connected but error returned';
    }
  } catch (e) {
    status.textContent = '✗ Could not reach backend';
    showToast('Connection failed — check deployment access in Apps Script', 'error');
  }
}

/* ── 17. OFFLINE QUEUE ────────────────────────────────────── */
// FIX: Deduplicate the queue before pushing. For attendance and undo
// actions, if an identical memberId + service + date combo already
// exists in the queue we skip the duplicate to avoid double-marking.
function enqueueOffline(payload) {
  // Deduplication for attendance-type actions
  if (payload.action === 'markAttendance' || payload.action === 'undoAttendance') {
    const isDuplicate = STATE.offlineQueue.some(
      q => q.action === payload.action &&
           q.memberId === payload.memberId &&
           q.service  === payload.service &&
           q.date     === payload.date
    );
    if (isDuplicate) return;
  }

  payload._queuedAt = Date.now();
  STATE.offlineQueue.push(payload);
  persistQueue();
  updateSyncBadge();
}

function persistQueue() {
  localStorage.setItem('jt_offline_queue', JSON.stringify(STATE.offlineQueue));
}

function updateSyncBadge() {
  const count = STATE.offlineQueue.length;
  const badge = $('syncBadge');
  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);
  $('queueStatus').textContent = count > 0
    ? `${count} record${count > 1 ? 's' : ''} pending sync`
    : 'All synced';
}

async function flushOfflineQueue() {
  if (!STATE.offlineQueue.length) { showToast('Nothing to sync', 'info'); return; }
  if (!CONFIG.WEB_APP_URL) { showToast('Backend URL is not configured in script.js', 'error'); return; }

  const btn = $('manualSyncBtn');
  btn.disabled = true;
  let synced = 0;

  for (const payload of [...STATE.offlineQueue]) {
    try {
      await apiSubmit(payload);
      STATE.offlineQueue = STATE.offlineQueue.filter(q => q !== payload);
      synced++;
    } catch (e) {
      // Leave failed items in the queue for next sync attempt
    }
  }

  const remaining = STATE.offlineQueue.length;
  persistQueue();
  updateSyncBadge();
  btn.disabled = false;

  if (synced > 0)      showToast(`${synced} record${synced > 1 ? 's' : ''} synced`, 'success');
  if (remaining > 0)   showToast(`${remaining} record${remaining > 1 ? 's' : ''} failed to sync`, 'error');
}

function startOfflineSyncLoop() {
  if (STATE.syncIntervalId) clearInterval(STATE.syncIntervalId);
  STATE.syncIntervalId = setInterval(() => {
    if (STATE.offlineQueue.length > 0 && navigator.onLine) flushOfflineQueue();
  }, CONFIG.OFFLINE_SYNC_INTERVAL_MS);

  window.addEventListener('online', () => {
    if (STATE.offlineQueue.length > 0) {
      showToast('Back online — syncing…', 'info');
      flushOfflineQueue();
    }
  });
}

/* ── 18. API LAYER ────────────────────────────────────────── */
async function apiFetch(params) {
  const url = CONFIG.WEB_APP_URL;
  if (!url) throw new Error('Backend URL is not configured in script.js');

  const qs  = new URLSearchParams(params).toString();
  const res = await fetch(`${url}?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiSubmit(payload) {
  const url = CONFIG.WEB_APP_URL;
  if (!url) {
    enqueueOffline(payload);
    throw new Error('Backend URL is not configured in script.js');
  }

  if (!navigator.onLine) {
    enqueueOffline(payload);
    throw new Error('Offline — queued');
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ── 19. TOAST SYSTEM ─────────────────────────────────────── */
function showToast(msg, type = 'info', sub = '') {
  const icons = { success: 'fa-check', error: 'fa-xmark', info: 'fa-circle-info' };
  const container = $('toastContainer');
  const toast     = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div class="toast-icon"><i class="fa-solid ${icons[type] || icons.info}"></i></div>
    <div>
      <div class="toast-msg">${escHtml(msg)}</div>
      ${sub ? `<div class="toast-sub">${escHtml(sub)}</div>` : ''}
    </div>`;

  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 350);
  }, 3500);
}

/* ── 20. UTILITIES ─────────────────────────────────────────── */
function getInitials(name = '') {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
}

function maskPhone(phone = '') {
  const str = String(phone || '');
  if (!str || str.length < 8) return str || '—';
  return str.slice(0, 4) + '****' + str.slice(-3);
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(d) {
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

// FIX: Only append T00:00:00 if the string is a plain date (no T already).
// Previously, passing a full ISO timestamp like "2025-06-08T14:32:00Z"
// would produce "2025-06-08T14:32:00ZT00:00:00" which silently fails parsing.
function formatDisplayDate(dateStr) {
  if (!dateStr) return '—';
  const normalised = dateStr.includes('T') ? dateStr : dateStr + 'T00:00:00';
  const d = new Date(normalised);
  if (isNaN(d.getTime())) return dateStr; // graceful fallback
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function isNewMemberToday(member) {
  return member.dateJoined === formatDate(new Date());
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
