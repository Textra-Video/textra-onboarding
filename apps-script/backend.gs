/**
 * Textra Onboarding — Apps Script backend
 *
 * This is your existing script (Sheet ID 1zgAwpkowKm4s1cpELT1hh5LlUVSLz_gL35iVXWp-72Y,
 * Slack webhook, header list, Slack notification, script-URL hyperlink logic)
 * with two live bugs fixed and new portal/script functionality merged in.
 *
 * BUGS FIXED FROM THE PREVIOUS VERSION
 * 1. `updateDataSheetWithScriptUrl` and `findColumnByHeader` were accidentally
 *    declared *inside* `sendSlack()`'s function body (a missing `}` before the
 *    "NEW LINE" comment). Since doPost() calls updateDataSheetWithScriptUrl()
 *    from the outer scope, this threw `ReferenceError: ... is not defined` on
 *    EVERY submission — right after the row was saved, but before sendSlack()
 *    ever ran. Data was saving fine; Slack notifications were never actually
 *    sent. Fixed by giving each function its own top-level scope.
 * 2. The backend read `data.sceneDesc`, but the frontend sent `sceneNotes` —
 *    so the "Scene Notes" column has always been blank. Fixed on the frontend
 *    (index.html now sends `sceneDesc`) to match this backend, which is
 *    unchanged here.
 * 3. The backend read `data.companyName`, but the frontend sent `data.company`
 *    — so the "Company" column and Slack's "Company:" line have always been
 *    blank/"N/A". Fixed on the frontend to send `companyName`.
 *
 * WHAT'S NEW
 * - A "Portal Token" column: a random ID the frontend generates on submit so
 *   a client can return later via a link (?token=...) with no password.
 * - A per-client Drive folder, created on first submission, holding all
 *   uploaded files (logo, guidelines, character references, etc.) instead of
 *   giant base64 blobs stuffed into a sheet cell (which risks hitting Google
 *   Sheets' ~50,000-character cell limit).
 * - doGet(action=getSubmission&token=...): lets a returning client fetch
 *   their prior submission for the read-only portal checklist.
 * - doPost(action=submitScript): a second, separate submission once the
 *   client writes/uploads their script — updates the SAME row (found by
 *   token) rather than assuming "last row", since it now arrives on its own
 *   request, potentially much later and after other clients' submissions.
 * - doPost(action=emailPortalLink): emails the client their portal link
 *   (manual "Email it to me" button on the portal page).
 * - sendClientConfirmationEmail(): automatically emails the client on brief
 *   submission with a confirmation + their portal link (no button needed).
 * - sendTeamNotificationEmail(): optional internal notification email,
 *   separate from Slack — only sends once TEAM_NOTIFY_EMAIL is configured.
 *
 * DEPLOYMENT
 * 1. Paste this entire file over your existing script (same Sheet — nothing
 *    to reconfigure there).
 * 2. Set your Slack webhook as a Script Property instead of hardcoding it:
 *    Project Settings (gear icon, left sidebar) → Script Properties →
 *    Add script property → key `SLACK_WEBHOOK`, value = your webhook URL.
 *    (This used to be a hardcoded constant — moved out of source because
 *    GitHub blocks commits containing a raw Slack webhook URL, and because
 *    committing real secrets to a repo is bad practice regardless.)
 * 3. Optional: once you have a dedicated internal address, add a second
 *    Script Property — key `TEAM_NOTIFY_EMAIL`, value = that address — to
 *    start receiving a notification email per submission alongside Slack.
 *    Leaving it unset is fine; everything else works without it.
 * 4. Deploy → Manage deployments → edit your existing deployment → New
 *    version. This keeps the same /exec URL, so index.html's
 *    GOOGLE_SCRIPT_URL doesn't need to change.
 *
 * TROUBLESHOOTING "NO SLACK NOTIFICATION"
 * - Confirm the Script Property key is exactly `SLACK_WEBHOOK` (case
 *   sensitive) with no extra spaces, and that you redeployed a NEW VERSION
 *   after adding it — saving the property alone doesn't update a live
 *   deployment.
 * - Apps Script editor → View → Executions: find your test submission's
 *   doPost execution and open it. If Slack was skipped, you'll see the log
 *   line "Slack webhook not configured..." — that means the property isn't
 *   being read, most likely because it wasn't saved or the deployment is
 *   still running an older version.
 */

const SHEET_ID = '1zgAwpkowKm4s1cpELT1hh5LlUVSLz_gL35iVXWp-72Y';
// Set this once in the Apps Script editor: Project Settings (gear icon) →
// Script Properties → add key SLACK_WEBHOOK with your webhook URL as the
// value. Keeping it out of source means it's never committed to GitHub —
// GitHub's push protection will reject any commit containing a raw
// Slack webhook URL.
const SLACK_WEBHOOK = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK');

// Internal team-facing notification address — separate from the client's
// own confirmation email. Optional: leave unset until you have a dedicated
// address, everything else works fine without it. Set the same way as
// SLACK_WEBHOOK: Script Properties → key TEAM_NOTIFY_EMAIL → your address.
const TEAM_NOTIFY_EMAIL = PropertiesService.getScriptProperties().getProperty('TEAM_NOTIFY_EMAIL');

// Fields that carry base64 data URLs — saved as real Drive files instead of
// being stuffed into a sheet cell.
const FILE_FIELDS = ['logoDataUrl', 'guidelinesFileData', 'c1refFileData', 'c2refFileData',
                      'sceneRefFileData', 'musicRefFileData'];

function doPost(e) {
  try {
    var jsonPayload = null;
    try { if (e.postData && e.postData.contents) jsonPayload = JSON.parse(e.postData.contents); } catch (err) {}

    if (jsonPayload && jsonPayload.action === 'submitScript') {
      return handleSubmitScript(jsonPayload);
    }
    if (jsonPayload && jsonPayload.action === 'emailPortalLink') {
      return handleEmailPortalLink(jsonPayload);
    }

    return handleBriefSubmission(e.parameter);
  } catch (error) {
    Logger.log('ERROR: ' + error.toString());
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  try {
    if (e.parameter.action === 'getSubmission') {
      return handleGetSubmission(e.parameter.token);
    }
    return jsonOut({ success: false, message: 'Unknown action' });
  } catch (error) {
    return jsonOut({ success: false, message: error.toString() });
  }
}

// ── BRIEF SUBMISSION (existing logic, extended) ───────────────
function handleBriefSubmission(data) {
  Logger.log('Request received');
  Logger.log('Data: ' + JSON.stringify(data));

  if (!data.email) {
    throw new Error('Email is required');
  }

  const sheet = SpreadsheetApp.openById(SHEET_ID).getActiveSheet();

  if (sheet.getLastRow() === 0) {
    const headers = [
      'Timestamp', 'Email', 'Full Name', 'Company', 'Project', 'Brand Method', 'Font',
      'Characters Style', 'Character A Gender', 'Character A Age', 'Character A Ethnicity',
      'Character A Accent', 'Character A Clothing', 'Character A Notes',
      'Character B Gender', 'Character B Age', 'Character B Ethnicity',
      'Character B Accent', 'Character B Clothing', 'Character B Notes',
      'Background', 'Scene Notes', 'Title Screen', 'Music',
      'Script Title', 'Script Method', 'Deadline', 'Full Data',
      'Portal Token', 'Status', 'Client Folder'
    ];
    sheet.appendRow(headers);
    Logger.log('Headers created');
  }

  var token = data.portalToken || Utilities.getUuid();
  var folder = getOrCreateClientFolder(token, data.companyName || data.projectName || data.fullName || 'Client');
  saveUploadedFiles(folder, data);

  // Keep "Full Data" lean — strip base64 blobs (saved as real files above)
  // so we don't risk hitting the ~50,000-character sheet cell limit.
  var lightData = {};
  for (var key in data) {
    if (!data.hasOwnProperty(key)) continue;
    if (FILE_FIELDS.indexOf(key) !== -1) continue;
    lightData[key] = data[key];
  }

  const row = [
    new Date(),
    data.email || '',
    data.fullName || '',
    data.companyName || '',
    data.projectName || '',
    data.brandMethod || '',
    data.font || '',
    data.charStyle || '',
    data.c1gender || '',
    data.c1age || '',
    data.c1eth || '',
    data.c1accent || '',
    data.c1clothing || '',
    data.c1notes || '',
    data.c2gender || '',
    data.c2age || '',
    data.c2eth || '',
    data.c2accent || '',
    data.c2clothing || '',
    data.c2notes || '',
    data.background || '',
    data.sceneDesc || '',
    data.titleScreen || '',
    data.music || '',
    data.scriptTitle || '',
    data.scriptMethod || '',
    data.deadline || '',
    JSON.stringify(lightData),
    token,
    'Brief submitted',
    ''
  ];

  var existingRow = findRowByColumnValue(sheet, findColumnByHeader(sheet, 'Portal Token'), token);
  if (existingRow) {
    sheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
    Logger.log('Row added to sheet');
  }

  var targetRow = existingRow || sheet.getLastRow();
  setColumnFormula(sheet, targetRow, 'Client Folder', '=HYPERLINK("' + folder.getUrl() + '","📁 Open Folder")');

  // Legacy: if a script sheet URL happened to arrive with the brief itself,
  // still link it (kept for backwards compatibility with the old flow).
  if (data.scriptSheetUrl) {
    setColumnFormula(sheet, targetRow, 'Script Sheet URL', '=HYPERLINK("' + data.scriptSheetUrl + '","📊 Open Script")');
  }

  sendSlack(data);
  sendClientConfirmationEmail(data, data.portalLink);
  sendTeamNotificationEmail(data, folder.getUrl());

  return jsonOut({
    success: true,
    message: 'Form submitted successfully',
    token: token,
    folder: folder.getUrl()
  });
}

// ── SCRIPT SUBMISSION (separate step, same row via token) ─────
function handleSubmitScript(payload) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getActiveSheet();
  const tokenCol = findColumnByHeader(sheet, 'Portal Token');
  if (tokenCol === -1) return jsonOut({ success: false, message: 'Portal Token column not found — submit a brief first.' });

  const row = findRowByColumnValue(sheet, tokenCol, payload.portalToken);
  if (!row) return jsonOut({ success: false, message: 'No submission found for this token.' });

  var folder = getFolderFromRow(sheet, row);

  var scriptLink = '';
  if (payload.scriptInputMethod === 'write' && payload.scriptText) {
    var doc = DocumentApp.create(payload.scriptTitle || 'Script');
    doc.getBody().setText(payload.scriptText);
    var docFile = DriveApp.getFileById(doc.getId());
    if (folder) docFile.moveTo(folder);
    scriptLink = docFile.getUrl();
  } else if (payload.scriptInputMethod === 'upload' && payload.scriptFileData) {
    var file = folder ? saveBase64File(folder, payload.scriptFileData, payload.scriptTitle || 'script-upload') : null;
    if (file) scriptLink = file.getUrl();
  } else if (payload.scriptInputMethod === 'sheet' && payload.scriptSheetUrl) {
    scriptLink = payload.scriptSheetUrl;
  }

  setColumnValue(sheet, row, 'Script Title', payload.scriptTitle || '');
  setColumnValue(sheet, row, 'Script Method', payload.scriptInputMethod || '');
  if (scriptLink) setColumnFormula(sheet, row, 'Script Sheet URL', '=HYPERLINK("' + scriptLink + '","📊 Open Script")');
  setColumnValue(sheet, row, 'Status', 'Script submitted');

  return jsonOut({ success: true, scriptLink: scriptLink });
}

// ── PORTAL LOOKUP (magic link revisit) ─────────────────────────
function handleGetSubmission(token) {
  if (!token) return jsonOut({ success: false, message: 'Missing token' });
  const sheet = SpreadsheetApp.openById(SHEET_ID).getActiveSheet();
  const tokenCol = findColumnByHeader(sheet, 'Portal Token');
  const row = findRowByColumnValue(sheet, tokenCol, token);
  if (!row) return jsonOut({ success: false, message: 'Not found' });

  const fullDataCol = findColumnByHeader(sheet, 'Full Data');
  var data = {};
  try { data = JSON.parse(sheet.getRange(row, fullDataCol).getValue()); } catch (e) {}

  var folder = getFolderFromRow(sheet, row);
  data.driveFolderUrl = folder ? folder.getUrl() : '';

  return jsonOut({ success: true, data: data });
}

// ── EMAIL PORTAL LINK (manual "Email it to me" button) ─────────
function handleEmailPortalLink(payload) {
  if (!payload.email || !payload.portalLink) {
    return jsonOut({ success: false, message: 'Missing email or link' });
  }
  MailApp.sendEmail({
    to: payload.email,
    subject: 'Your Textra Video project link',
    body: portalLinkEmailBody(payload.portalLink)
  });
  return jsonOut({ success: true });
}

function portalLinkEmailBody(portalLink) {
  return 'Here is your link to return to your Textra Video project any time:\n\n' +
         portalLink +
         '\n\nBookmark it — no password needed. Use it to check progress or write your script.';
}

// ── CLIENT CONFIRMATION EMAIL (automatic, on brief submission) ─
function sendClientConfirmationEmail(data, portalLink) {
  try {
    if (!data.email) return;
    var greeting = data.fullName ? ('Hi ' + data.fullName + ',') : 'Hi,';
    var body = greeting + '\n\n' +
      'Thanks — your Textra Video brand brief has been received. Our team is already on it.\n\n' +
      (portalLink
        ? 'Here is your project link — bookmark it, no password needed. Use it any time to check progress or write your script:\n\n' + portalLink + '\n\n'
        : '') +
      'We will be in touch shortly.\n\n— Textra Video';
    MailApp.sendEmail({
      to: data.email,
      subject: 'Your Textra Video brief has been received',
      body: body
    });
    Logger.log('Client confirmation email sent to ' + data.email);
  } catch (e) {
    Logger.log('Client confirmation email error: ' + e.toString());
  }
}

// ── TEAM NOTIFICATION EMAIL (optional, internal) ────────────────
function sendTeamNotificationEmail(data, folderUrl) {
  try {
    if (!TEAM_NOTIFY_EMAIL) {
      Logger.log('TEAM_NOTIFY_EMAIL not configured — skipping team notification email.');
      return;
    }
    var body = 'New Textra Video brief submitted.\n\n' +
      'Name: ' + (data.fullName || 'N/A') + '\n' +
      'Email: ' + (data.email || 'N/A') + '\n' +
      'Company: ' + (data.companyName || 'N/A') + '\n' +
      'Project: ' + (data.projectName || 'N/A') + '\n\n' +
      'Client folder: ' + folderUrl;
    MailApp.sendEmail({
      to: TEAM_NOTIFY_EMAIL,
      subject: 'New Textra submission — ' + (data.companyName || data.fullName || 'Client'),
      body: body
    });
    Logger.log('Team notification email sent to ' + TEAM_NOTIFY_EMAIL);
  } catch (e) {
    Logger.log('Team notification email error: ' + e.toString());
  }
}

// ── SLACK ─────────────────────────────────────────────────────
function sendSlack(data) {
  try {
    if (!SLACK_WEBHOOK) {
      Logger.log('Slack webhook not configured (Script Properties → SLACK_WEBHOOK) — skipping notification.');
      return;
    }
    var nameVal = data.fullName ? data.fullName : 'N/A';
    var emailVal = data.email ? data.email : 'N/A';
    var companyVal = data.companyName ? data.companyName : 'N/A';
    var projectVal = data.projectName ? data.projectName : 'N/A';

    var textMsg = 'Name: ' + nameVal + '\nEmail: ' + emailVal + '\nCompany: ' + companyVal + '\nProject: ' + projectVal;

    var message = {
      text: 'New Textra Submission',
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: textMsg }
      }]
    };

    UrlFetchApp.fetch(SLACK_WEBHOOK, {
      method: 'post',
      payload: JSON.stringify(message),
      headers: { 'Content-Type': 'application/json' },
      muteHttpExceptions: true
    });

    Logger.log('Slack notification sent');
  } catch (e) {
    Logger.log('Slack error: ' + e.toString());
  }
}

// ── DRIVE FOLDER HELPERS ────────────────────────────────────────
const ROOT_FOLDER_NAME = 'Textra Onboarding — Client Briefs';

function getOrCreateClientFolder(token, label) {
  var root = getOrCreateRootFolder();
  var name = (label || 'Client') + ' — ' + token.slice(0, 8);
  var existing = root.getFoldersByName(name);
  if (existing.hasNext()) return existing.next();
  return root.createFolder(name);
}

function getOrCreateRootFolder() {
  var it = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(ROOT_FOLDER_NAME);
}

function getFolderFromRow(sheet, row) {
  var col = findColumnByHeader(sheet, 'Client Folder');
  if (col === -1) return null;
  var formula = sheet.getRange(row, col).getFormula();
  var match = /"(https:\/\/drive\.google\.com[^"]+)"/.exec(formula);
  if (!match) return null;
  var idMatch = /\/folders\/([a-zA-Z0-9_-]+)/.exec(match[1]);
  if (!idMatch) return null;
  try { return DriveApp.getFolderById(idMatch[1]); } catch (e) { return null; }
}

function saveUploadedFiles(folder, data) {
  FILE_FIELDS.forEach(function (key) {
    var value = data[key];
    if (!value) return;
    saveBase64File(folder, value, key);
  });
}

function saveBase64File(folder, dataUrl, baseName) {
  var match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!match) return null;
  var mimeType = match[1];
  var base64 = match[2];
  var bytes = Utilities.base64Decode(base64);
  var ext = (mimeType.split('/')[1] || 'bin').split('+')[0];
  var blob = Utilities.newBlob(bytes, mimeType, baseName + '.' + ext);
  return folder.createFile(blob);
}

// ── SHEET HELPERS ─────────────────────────────────────────────
function findColumnByHeader(sheet, headerName) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (let i = 0; i < headers.length; i++) {
    if (headers[i] === headerName) return i + 1;
  }
  return -1;
}

function findRowByColumnValue(sheet, col, value) {
  if (col === -1 || !value) return null;
  const values = sheet.getRange(2, col, Math.max(sheet.getLastRow() - 1, 0), 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === value) return i + 2; // 1-indexed, +1 for header row
  }
  return null;
}

function setColumnValue(sheet, row, headerName, value) {
  var col = getOrCreateColumn(sheet, headerName);
  sheet.getRange(row, col).setValue(value);
}

function setColumnFormula(sheet, row, headerName, formula) {
  var col = getOrCreateColumn(sheet, headerName);
  sheet.getRange(row, col).setFormula(formula);
}

function getOrCreateColumn(sheet, headerName) {
  var col = findColumnByHeader(sheet, headerName);
  if (col !== -1) return col;
  var newCol = sheet.getLastColumn() + 1;
  sheet.getRange(1, newCol).setValue(headerName);
  return newCol;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
