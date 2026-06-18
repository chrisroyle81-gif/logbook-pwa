/**
 * LOGBOOK — Apps Script web app
 * Receives entries from the Logbook PWA and appends them to the master notes Google Doc.
 *
 * Setup:
 *   1. Open https://script.google.com and create a new project named "Logbook".
 *   2. Paste this file as Code.gs.
 *   3. Fill in CONFIG below.
 *   4. Deploy → New deployment → Type: Web app
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      Copy the /exec URL. Paste it (and SHARED_TOKEN) into the PWA Setup screen.
 *   5. First request will prompt an authorisation flow — accept it.
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const DOC_ID = '1HDEhHvKE20wKkCFxYFN8H3AHklDEA8-AjT_x6pijPpg'; // 2026 Master Notes
const SHARED_TOKEN = '&^WK,C0[kQD.GA?%{PwT:l!<fIHvs`4"';  // also paste in PWA Setup
const TIMEZONE = 'Australia/Sydney';

// Known locations resolve first (matched by haversine distance).
// Add entries as you discover the coords — easiest way: log a few entries
// without filling these in, then read the lat,lng from the doc and paste here.
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

    appendEntry_(ts, location, content, data.mode || 'type');

    return _json({ ok: true, location: location });
  } catch (err) {
    return _json({ ok: false, error: String(err && err.message || err) });
  }
}

// Optional GET — handy for sanity-checking the deployment from a browser.
function doGet() {
  return _json({ ok: true, service: 'logbook', time: new Date().toISOString() });
}

// ─── DOC APPEND ──────────────────────────────────────────────────────────────

function appendEntry_(ts, location, content, mode) {
  const doc = DocumentApp.openById(DOC_ID);
  const body = doc.getBody();

  const dayHeader = Utilities.formatDate(ts, TIMEZONE, "yyyy-MM-dd EEEE");
  const timeStr   = Utilities.formatDate(ts, TIMEZONE, "HH:mm");
  const entryHeader = `${timeStr} · ${location}`;

  // Find today's day-header paragraph (Heading 1).
  const paragraphs = body.getParagraphs();
  let dayIdx = -1;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (p.getHeading() === DocumentApp.ParagraphHeading.HEADING1 &&
        p.getText() === dayHeader) {
      dayIdx = i;
      break;
    }
  }

  if (dayIdx === -1) {
    // New day — insert a fresh day block at the very top of the body.
    let insertAt = 0;
    const h1 = body.insertParagraph(insertAt++, dayHeader)
                   .setHeading(DocumentApp.ParagraphHeading.HEADING1);
    body.insertParagraph(insertAt++, entryHeader)
        .setHeading(DocumentApp.ParagraphHeading.HEADING2);
    body.insertParagraph(insertAt++, content)
        .setHeading(DocumentApp.ParagraphHeading.NORMAL);
    body.insertParagraph(insertAt++, ''); // breathing room
  } else {
    // Existing day — find the index just before the NEXT Heading 1 (or end).
    let insertAt = body.getChildIndex(paragraphs[dayIdx]) + 1;
    for (let i = dayIdx + 1; i < paragraphs.length; i++) {
      if (paragraphs[i].getHeading() === DocumentApp.ParagraphHeading.HEADING1) {
        insertAt = body.getChildIndex(paragraphs[i]);
        break;
      }
      insertAt = body.getChildIndex(paragraphs[i]) + 1;
    }
    // Skip trailing empty paragraphs so entries stack cleanly.
    while (insertAt > 0) {
      const prev = body.getChild(insertAt - 1);
      if (prev.getType() === DocumentApp.ElementType.PARAGRAPH &&
          prev.asParagraph().getText() === '') {
        insertAt--;
      } else break;
    }
    body.insertParagraph(insertAt++, entryHeader)
        .setHeading(DocumentApp.ParagraphHeading.HEADING2);
    body.insertParagraph(insertAt++, content)
        .setHeading(DocumentApp.ParagraphHeading.NORMAL);
    body.insertParagraph(insertAt++, '');
  }

  doc.saveAndClose();
}

// ─── LOCATION ────────────────────────────────────────────────────────────────

function resolveLocation_(lat, lng) {
  if (lat == null || lng == null) return 'unknown';

  // 1) Known locations.
  for (const loc of KNOWN_LOCATIONS) {
    const d = haversine_(lat, lng, loc.lat, loc.lng);
    if (d <= loc.radius_m) return loc.name;
  }

  // 2) Reverse-geocode via Apps Script Maps service (no API key needed).
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
  } catch (err) {
    // Fall through to coords.
  }

  // 3) Coordinate fallback so the entry still has *something*.
  return `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`;
}

function haversine_(lat1, lng1, lat2, lng2) {
  const R = 6371000; // metres
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
