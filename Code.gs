/**
 * LOGBOOK — Apps Script web app
 * Receives entries from the Logbook PWA and appends them to the master notes Google Doc.
 *
 * v3 — adds automatic year-rollover. When the calendar year changes, the
 *      script creates a new "{year} Master Notes" doc in the same Drive
 *      folder as the previous one and starts writing to it. Chris gets
 *      a one-off email when this happens as a reminder to update Cowork
 *      skills that reference the doc by name.
 *
 * v4 — appendEntry_() now takes the shared script lock before touching the
 *      Doc. Root cause of the diary's paragraph corruption (multiple days'
 *      entries silently merged, invisible to \r-splitting readers like
 *      calendar-sync.gs): rapid-fire / queued-offline PWA submissions could
 *      call appendEntry_() concurrently with no synchronization, racing on
 *      the same read-modify-write (find today's H1, then insert relative to
 *      it) — a known DocumentApp failure mode. calendar-sync.gs and
 *      email-sync.gs already lock around their own shared-state writes; this
 *      was the one writer to the same Doc that didn't.
 *
 * v5 — entry-level idempotency. The lock in v4 stopped concurrent appends from
 *      corrupting each other, but nothing stopped the SAME entry being written
 *      twice: the PWA retries any send it doesn't get a reply to, and a reply
 *      lost after a successful write is indistinguishable from one that never
 *      arrived. Large entries made this likely — a slow append outlives the
 *      mobile connection. The PWA (v5) now sends a stable per-entry id, and
 *      appendEntry_() skips ids it has already written. See _hasSeenId_().
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────

// Seed DOC_ID — only used on first run. After that the active doc is stored
// in Script Properties and rotated automatically each calendar year.
const SEED_DOC_ID = '1HDEhHvKE20wKkCFxYFN8H3AHklDEA8-AjT_x6pijPpg';
const SHARED_TOKEN = '&^WK,C0[kQD.GA?%{PwT:l!<fIHvs`4"';
const TIMEZONE = 'Australia/Sydney';

const KNOWN_LOCATIONS = [
  // { name: 'Home',                          lat: -33.0000, lng: 150.0000, radius_m: 150 },
  // { name: '115 Thunderbolt',               lat: -33.0000, lng: 150.0000, radius_m: 150 },
  // { name: 'Cement Australia, Rooty Hill',  lat: -33.0000, lng: 150.0000, radius_m: 250 },
];

// ─── ENTRYPOINT ──────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents || '{}');
    if (!data.token || data.token !== SHARED_TOKEN) {
      return _json({ ok: false, error: 'bad token' });
    }
    const content = (data.content || '').trim();
    if (!content) return _json({ ok: false, error: 'empty content' });

    const ts = data.ts ? new Date(data.ts) : new Date();
    const location = resolveLocation_(data.lat, data.lng);

    // data.id is the PWA's per-entry idempotency key (PWA v5+). Older clients
    // that send no id still work — they simply get no duplicate protection.
    const result = appendEntry_(ts, location, content, data.id);

    return _json({ ok: true, location: location, duplicate: !!result.duplicate });
  } catch (err) {
    return _json({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return _json({ ok: true, service: 'logbook', time: new Date().toISOString() });
}

// ─── YEAR-AWARE DOC SELECTION ───────────────────────────────────────────────

/**
 * Returns the ID of the Master Notes doc for the current calendar year.
 * Auto-creates a new yearly doc when the year rolls over.
 */
/**
 *
 * HOW TO APPLY (surgical — do NOT paste your whole Code.gs over):
 *   1. In Code.gs, REPLACE the existing getActiveDocId_() function with the
 *      version below.
 *   2. ADD the new _setActiveDoc_() helper below it (it's new, no existing copy).
 *   3. Leave everything else in Code.gs untouched — especially SHARED_TOKEN.
 *      (The copy you shared shows the placeholder token; don't let a wholesale
 *      paste wipe your real one and break the PWA.)
 */

function getActiveDocId_() {
  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperty('activeDocId');
  const storedYear = props.getProperty('activeDocYear');
  const now = new Date();
  const currentYear = parseInt(Utilities.formatDate(now, TIMEZONE, 'yyyy'), 10);

  // First run — seed from config.
  if (!stored) {
    _setActiveDoc_(SEED_DOC_ID, currentYear);
    return SEED_DOC_ID;
  }

  if (parseInt(storedYear, 10) === currentYear) {
    // Keep DIARY_DOC_ID (read by the sibling sync scripts) in sync. Cheap, and
    // self-heals if it ever gets unset or drifts — only writes when different.
    if (props.getProperty('DIARY_DOC_ID') !== stored) {
      props.setProperty('DIARY_DOC_ID', stored);
    }
    return stored;
  }

  // Year has changed — find or create the new yearly doc in the same folder
  // as the previous one.
  const oldFile = DriveApp.getFileById(stored);
  const parents = oldFile.getParents();
  const folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const newName = `${currentYear} Master Notes`;

  // Defensive: if a doc with this name already exists (e.g. Chris pre-created
  // it), reuse it rather than making a duplicate.
  let newDocId = null;
  const existing = folder.getFilesByName(newName);
  if (existing.hasNext()) {
    newDocId = existing.next().getId();
  } else {
    const newDoc = DocumentApp.create(newName);
    newDocId = newDoc.getId();
    // DocumentApp.create() puts files in My Drive root — move into the folder.
    const newFile = DriveApp.getFileById(newDocId);
    newFile.moveTo(folder);
  }

  _setActiveDoc_(newDocId, currentYear);

  // Notify Chris — don't block the entry if the email fails.
  try {
    const email = Session.getActiveUser().getEmail();
    if (email) {
      MailApp.sendEmail({
        to: email,
        subject: `Logbook: rolled over to '${newName}'`,
        body:
          `Logbook detected a new calendar year and started writing to a new master notes doc.\n\n` +
          `New doc: ${newName}\n` +
          `URL: https://docs.google.com/document/d/${newDocId}/edit\n\n` +
          `Your Apps Script syncs (calendar, camera, Lisa, good-things, weekly) resolve the\n` +
          `diary through the DIARY_DOC_ID property, which this rollover just updated — so they\n` +
          `follow the new doc automatically. No action needed for those.\n\n` +
          `Only update the Cowork skills that name the doc directly (your medical-log and\n` +
          `shareable-summary skills, career-master-sync, diary-sync-all) so they read from\n` +
          `"${newName}" instead of the previous year.\n\n` +
          `— Logbook`
      });
    }
  } catch (_) { /* ignore */ }

  return newDocId;
}

/**
 * Sets the active doc for the PWA AND mirrors it into DIARY_DOC_ID — the shared
 * property the sibling sync scripts read. One write point = one source of truth
 * = automatic year rollover for every diary script at once.
 */
function _setActiveDoc_(id, year) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('activeDocId', id);
  props.setProperty('activeDocYear', String(year));
  props.setProperty('DIARY_DOC_ID', id);
}

// ─── DOC APPEND ──────────────────────────────────────────────────────────────

/**
 * v4: takes the shared script lock before touching the Doc — see the file
 * header. Concurrent/queued PWA submissions used to race on this
 * read-modify-write (find today's H1, then insert relative to it), which is
 * the most likely cause of the paragraph corruption found in the live diary
 * (multiple days' entries silently merged via \n instead of separate \r
 * paragraphs). tryLock(30000): appends are fast, 30s is generous; if it can't
 * get the lock in that window something is genuinely stuck and the caller
 * (the PWA) should see an error and retry rather than race silently.
 */
function appendEntry_(ts, location, content, entryId) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Could not acquire document lock — another entry is being written right now. Please retry.');
  }
  try {
    // v5 dedupe. Inside the lock, so check-then-append is atomic: two copies of
    // the same entry arriving together cannot both pass the check.
    const props = PropertiesService.getScriptProperties();
    if (entryId && _hasSeenId_(props, entryId)) {
      return { duplicate: true };
    }

    const doc = DocumentApp.openById(getActiveDocId_());
    const body = doc.getBody();

    const dayHeader = Utilities.formatDate(ts, TIMEZONE, "yyyy-MM-dd EEEE");
    const timeStr   = Utilities.formatDate(ts, TIMEZONE, "HH:mm");
    const entryHeader = `${timeStr} · ${location}`;

    const paragraphs = body.getParagraphs();
    let dayParagraph = null;
    for (const p of paragraphs) {
      if (p.getHeading() === DocumentApp.ParagraphHeading.HEADING1 &&
          p.getText() === dayHeader) {
        dayParagraph = p;
        break;
      }
    }

    if (!dayParagraph) {
      // New day — fresh day block at the top of the body.
      let i = 0;
      body.insertParagraph(i++, dayHeader)
          .setHeading(DocumentApp.ParagraphHeading.HEADING1);
      body.insertParagraph(i++, entryHeader)
          .setHeading(DocumentApp.ParagraphHeading.HEADING2);
      body.insertParagraph(i++, content)
          .setHeading(DocumentApp.ParagraphHeading.NORMAL);
      body.insertParagraph(i++, '');
    } else {
      // Existing day — insert directly under today's H1 (newest entry on top).
      let i = body.getChildIndex(dayParagraph) + 1;
      body.insertParagraph(i++, '');
      body.insertParagraph(i++, entryHeader)
          .setHeading(DocumentApp.ParagraphHeading.HEADING2);
      body.insertParagraph(i++, content)
          .setHeading(DocumentApp.ParagraphHeading.NORMAL);
    }

    doc.saveAndClose();

    // Recorded only AFTER a successful write, so an append that throws can
    // still be retried by the phone.
    if (entryId) _rememberId_(props, entryId);

    return { duplicate: false };
  } finally {
    lock.releaseLock();
  }
}

// ─── IDEMPOTENCY ─────────────────────────────────────────────────────────────
//
// The PWA cannot tell "the request never arrived" apart from "the request
// arrived, was written, and the reply was lost on the way back" — both look
// like a failed fetch. It retries either way, which is correct for the first
// case and duplicates the entry in the second. A very large entry makes the
// second case likely: the append is slow, so the round trip is more likely to
// outlive the mobile connection.
//
// So the phone mints an id per entry and reuses it on every retry, and we keep
// a short memory of ids already written. The ids live in Script Properties,
// never in the Doc — every downstream sync script parses the doc as plain text,
// so anything written into the body would show up in their output.
//
// SEEN_MAX is bounded by the 9KB-per-property limit: 150 ids at ~37 bytes each
// is ~5.5KB, comfortably inside it, and far more history than a retry needs.

const SEEN_PROP = 'seenEntryIds';
const SEEN_MAX  = 150;

function _hasSeenId_(props, id) {
  const raw = props.getProperty(SEEN_PROP) || '';
  return raw ? raw.split(',').indexOf(id) >= 0 : false;
}

function _rememberId_(props, id) {
  const raw = props.getProperty(SEEN_PROP) || '';
  const ids = raw ? raw.split(',') : [];
  ids.push(id);
  while (ids.length > SEEN_MAX) ids.shift();
  props.setProperty(SEEN_PROP, ids.join(','));
}

// ─── LOCATION ────────────────────────────────────────────────────────────────

function resolveLocation_(lat, lng) {
  if (lat == null || lng == null) return 'unknown';

  for (const loc of KNOWN_LOCATIONS) {
    const d = haversine_(lat, lng, loc.lat, loc.lng);
    if (d <= loc.radius_m) return loc.name;
  }

  try {
    const res = Maps.newGeocoder().reverseGeocode(lat, lng);
    if (res && res.results && res.results.length) {
      const comps = res.results[0].address_components || [];
      const get = (type) => {
        const c = comps.find(c => c.types.indexOf(type) >= 0);
        return c ? c.short_name : null;
      };
      const suburb = get('locality') || get('sublocality') || get('postal_town');
      const state  = get('administrative_area_level_1');
      if (suburb && state) return `${suburb}, ${state}`;
      if (suburb) return suburb;
      return res.results[0].formatted_address;
    }
  } catch (err) { /* fall through */ }

  return `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`;
}

function haversine_(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ─── UTIL ────────────────────────────────────────────────────────────────────

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── EXPORTS USED BY OTHER SCRIPTS IN THIS PROJECT ──────────────────────────
// weekly_summary.gs calls these.

function _getActiveDocId() { return getActiveDocId_(); }
function _getPreviousYearDocId(year) {
  // Find a doc named "{year} Master Notes" in the same folder as the active one.
  try {
    const activeId = getActiveDocId_();
    const folder = DriveApp.getFileById(activeId).getParents().next();
    const files = folder.getFilesByName(`${year} Master Notes`);
    if (files.hasNext()) return files.next().getId();
  } catch (_) {}
  return null;
}
function _getTimezone() { return TIMEZONE; }
