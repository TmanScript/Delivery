/**
 * Delivery Confirmation — server-side proxy (Google Apps Script)
 * =============================================================
 *
 * This Web App is the ONLY place that holds privileged credentials. The static
 * front-end (index.html / Confirmation.html) calls it and never sees the Splynx
 * API key or any password. Deploy it as its OWN standalone Apps Script project
 * (script.google.com → New project — keep it separate from other automations),
 * deploy as a Web App ("Execute as: Me", "Who has access: Anyone"), and paste
 * the resulting /exec URL into PROXY_URL in both HTML files. See DEPLOYMENT.md.
 *
 * Required Script Properties (Project Settings → Script properties):
 *   SPLYNX_BASE     e.g. https://portal.umoja.network/api/2.0/admin
 *   SPLYNX_AUTH     e.g. Basic <base64(apiKey:apiSecret)>  ← ROTATE the leaked key first
 *   TOKEN_SECRET    any long random string (used to sign session tokens)
 *   SPREADSHEET_ID  id of the spreadsheet holding the log + Users sheets
 *                   (from its URL: /spreadsheets/d/<THIS_ID>/edit)
 *
 * Optional Script Properties:
 *   LOG_SHEET        name of the existing delivery-log tab (default "Deliverd_Devices")
 *   CUSTOMERS_SHEET  name of a sheet to read the customer list from; if unset,
 *                    customers are fetched live from Splynx
 *
 * Required sheet in that spreadsheet:
 *   "Users"   columns: id | login | fullName | salt | passwordHash
 *
 * The delivery log is appended to LOG_SHEET by matching its existing header row,
 * so your current sheet and the published history CSV keep working. To capture
 * the new fields, add any of these columns to that sheet (optional):
 *   Agent ID | Latitude | Longitude | Accuracy | Delivery ID
 * (A "Delivery ID" column also enables duplicate-submit protection.)
 */

var PROPS = PropertiesService.getScriptProperties();
var SPLYNX_BASE = PROPS.getProperty("SPLYNX_BASE");
var SPLYNX_AUTH = PROPS.getProperty("SPLYNX_AUTH");
var TOKEN_SECRET = PROPS.getProperty("TOKEN_SECRET");
var TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// ─────────────────────────────────────────────────────────────
// HTTP ENTRY POINTS
// ─────────────────────────────────────────────────────────────
function doGet(e) {
  try {
    var action = (e.parameter && e.parameter.action) || "customers";
    if (action === "customers") {
      requireUser_(e.parameter && e.parameter.token);
      return json_({ result: "success", data: listCustomers_() });
    }
    return json_({ error: "Unknown action: " + action });
  } catch (err) {
    return json_({ error: String(err.message || err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e.postData && e.postData.contents) || "{}");
    switch (body.action) {
      case "login":
        return json_(login_(body.username, body.password));
      case "submitDelivery":
        requireUser_(body.token);
        return json_(submitDelivery_(body));
      default:
        return json_({ error: "Unknown action: " + body.action });
    }
  } catch (err) {
    return json_({ error: String(err.message || err) });
  }
}

// ─────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────
function login_(username, password) {
  if (!username || !password) return { error: "Missing credentials." };
  var user = findUser_(String(username).trim());
  if (!user) return { error: "Invalid login. Please try again." };

  var attempt = hashPassword_(user.salt, password);
  if (attempt !== user.passwordHash) {
    return { error: "Invalid login. Please try again." };
  }
  return {
    result: "success",
    user: { id: user.id, login: user.login, fullName: user.fullName },
    token: makeToken_(user),
  };
}

function findUser_(login) {
  var sheet = getSpreadsheet_().getSheetByName("Users");
  if (!sheet) throw new Error("Users sheet not found.");
  var rows = sheet.getDataRange().getValues();
  var head = rows[0].map(function (h) {
    return String(h).trim().toLowerCase();
  });
  var ci = {
    id: head.indexOf("id"),
    login: head.indexOf("login"),
    fullName: head.indexOf("fullname"),
    salt: head.indexOf("salt"),
    passwordHash: head.indexOf("passwordhash"),
  };
  for (var r = 1; r < rows.length; r++) {
    if (String(rows[r][ci.login]).trim() === login) {
      return {
        id: rows[r][ci.id],
        login: String(rows[r][ci.login]).trim(),
        fullName: String(rows[r][ci.fullName]).trim(),
        salt: String(rows[r][ci.salt]),
        passwordHash: String(rows[r][ci.passwordHash]).trim(),
      };
    }
  }
  return null;
}

function makeToken_(user) {
  var payload = Utilities.base64EncodeWebSafe(
    JSON.stringify({ id: user.id, exp: Date.now() + TOKEN_TTL_MS }),
  );
  return payload + "." + sign_(payload);
}

function requireUser_(token) {
  if (!token) throw new Error("Not authorised.");
  var parts = String(token).split(".");
  if (parts.length !== 2 || sign_(parts[0]) !== parts[1]) {
    throw new Error("Invalid session. Please log in again.");
  }
  var payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  if (!payload.exp || payload.exp < Date.now()) {
    throw new Error("Session expired. Please log in again.");
  }
  return payload;
}

function sign_(data) {
  if (!TOKEN_SECRET) throw new Error("TOKEN_SECRET not configured.");
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(data, TOKEN_SECRET),
  );
}

function hashPassword_(salt, password) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(salt) + String(password),
  );
  return Utilities.base64Encode(bytes);
}

// ─────────────────────────────────────────────────────────────
// CUSTOMERS
// ─────────────────────────────────────────────────────────────
function listCustomers_() {
  // If CUSTOMERS_SHEET is set, read the list from that sheet (e.g. one your
  // existing Sync_For_Delivery flow populates); otherwise fetch live from Splynx.
  var sheetName = PROPS.getProperty("CUSTOMERS_SHEET");
  return sheetName ? customersFromSheet_(sheetName) : customersFromSplynx_();
}

function customersFromSplynx_() {
  var res = UrlFetchApp.fetch(SPLYNX_BASE + "/customers/customer", {
    method: "get",
    headers: { Authorization: SPLYNX_AUTH },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error("Could not load customers from Splynx.");
  }
  var list = JSON.parse(res.getContentText());
  return (list || []).map(function (c) {
    return { id: c.id, name: c.name || c.full_name || "" };
  });
}

function customersFromSheet_(name) {
  var sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error("Customers sheet not found: " + name);
  var rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return [];
  var head = rows[0].map(function (h) {
    return String(h).trim().toLowerCase();
  });
  var idCol = head.indexOf("id");
  if (idCol < 0) idCol = head.indexOf("customer id");
  var nameCol = head.indexOf("name");
  if (nameCol < 0) nameCol = head.indexOf("customer name");
  var out = [];
  for (var r = 1; r < rows.length; r++) {
    var id = rows[r][idCol];
    var nm = rows[r][nameCol];
    if (id === "" && nm === "") continue;
    out.push({ id: id, name: nm });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// SUBMIT DELIVERY
// ─────────────────────────────────────────────────────────────
function submitDelivery_(body) {
  var sheet = getLogSheet_();
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var idxDelivery = header.indexOf("Delivery ID");

  // Idempotency: skip if this deliveryId is already logged (needs the column).
  if (
    body.deliveryId &&
    idxDelivery >= 0 &&
    logHasDelivery_(sheet, idxDelivery, body.deliveryId)
  ) {
    return { result: "success", note: "Already recorded." };
  }

  var customerId = body.customer && body.customer.id;
  if (!customerId) throw new Error("Missing customer.");

  // Upload every captured document to Splynx.
  (body.files || []).forEach(function (f) {
    if (!f || !f.dataBase64) return;
    uploadDocument_(customerId, f);
  });

  // Append a row matching the sheet's existing header names. Unknown columns
  // are left blank; recognised columns are filled regardless of their order.
  var loc = body.location || {};
  var now = new Date();
  var values = {
    Time: now,
    Timestamp: now,
    "Customer ID": customerId,
    Name: (body.customer && body.customer.name) || "",
    "Router Barcode": body.router || "",
    "SIM Barcode": body.sim || "",
    Agent: (body.agent && body.agent.name) || "",
    "Agent ID": (body.agent && body.agent.id) || "",
    "Collector Type": (body.collector && body.collector.type) || "",
    "Collector Name": (body.collector && body.collector.name) || "",
    Latitude: loc.latitude != null ? loc.latitude : "",
    Longitude: loc.longitude != null ? loc.longitude : "",
    Accuracy: loc.accuracy != null ? loc.accuracy : "",
    "Delivery ID": body.deliveryId || "",
  };
  var row = header.map(function (h) {
    var key = String(h).trim();
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : "";
  });
  sheet.appendRow(row);

  return { result: "success" };
}

function uploadDocument_(customerId, f) {
  // 1) create the document record
  var createRes = UrlFetchApp.fetch(
    SPLYNX_BASE + "/customers/customer-documents",
    {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: SPLYNX_AUTH },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        customer_id: customerId,
        type: "uploaded",
        title: f.title,
        description: f.description,
        visible_by_customer: "0",
      }),
    },
  );
  if (createRes.getResponseCode() >= 300) {
    throw new Error("Failed to create document record: " + f.title);
  }
  var docId = JSON.parse(createRes.getContentText()).id;

  // 2) upload the file blob
  var blob = Utilities.newBlob(
    Utilities.base64Decode(f.dataBase64),
    f.mimeType || "application/octet-stream",
    f.filename || f.title,
  );
  var uploadRes = UrlFetchApp.fetch(
    SPLYNX_BASE + "/customers/customer-documents/" + docId + "--upload",
    {
      method: "post",
      headers: { Authorization: SPLYNX_AUTH },
      muteHttpExceptions: true,
      payload: { file: blob },
    },
  );
  if (uploadRes.getResponseCode() >= 300) {
    throw new Error("Failed to upload: " + f.title);
  }
}

function getLogSheet_() {
  var name = PROPS.getProperty("LOG_SHEET") || "Deliverd_Devices";
  var sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error("Log sheet not found: " + name);
  return sheet;
}

function logHasDelivery_(sheet, idxDelivery, deliveryId) {
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][idxDelivery]) === String(deliveryId)) return true;
  }
  return false;
}

// Resolve the spreadsheet by id (standalone project) or fall back to the bound
// spreadsheet if this script is container-bound.
function getSpreadsheet_() {
  var id = PROPS.getProperty("SPREADSHEET_ID");
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActive();
  if (active) return active;
  throw new Error("Set the SPREADSHEET_ID script property.");
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

/**
 * One-off utility: run from the editor to add/update a technician login.
 * Edit the values, run, then delete the call. Generates a random salt and
 * stores only a salted SHA-256 hash — never the plain password.
 */
function addUser() {
  var id = 24;
  var login = "0762956670";
  var fullName = "Luyanda Rammalo";
  var password = "CHANGE_ME";

  var salt = Utilities.getUuid();
  var sheet = getSpreadsheet_().getSheetByName("Users");
  sheet.appendRow([id, login, fullName, salt, hashPassword_(salt, password)]);
}
