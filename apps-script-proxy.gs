/**
 * Delivery Confirmation — server-side proxy (Google Apps Script)
 * =============================================================
 *
 * This Web App is the ONLY place that holds privileged credentials. The static
 * front-end (index.html / Confirmation.html) calls it and never sees the Splynx
 * API key or any password. Deploy it as a Web App ("Execute as: Me",
 * "Who has access: Anyone") and paste the resulting /exec URL into PROXY_URL in
 * both HTML files. See DEPLOYMENT.md for step-by-step instructions.
 *
 * Required Script Properties (Project Settings → Script properties):
 *   SPLYNX_BASE   e.g. https://portal.umoja.network/api/2.0/admin
 *   SPLYNX_AUTH   e.g. Basic <base64(apiKey:apiSecret)>   ← ROTATE the leaked key first
 *   TOKEN_SECRET  any long random string (used to sign session tokens)
 *
 * Required sheets in the bound spreadsheet:
 *   "Users"       columns: id | login | fullName | salt | passwordHash
 *   "Deliveries"  (created automatically on first submit)
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
  var sheet = SpreadsheetApp.getActive().getSheetByName("Users");
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
  // Pull the active customer list from Splynx and return only {id, name}.
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

// ─────────────────────────────────────────────────────────────
// SUBMIT DELIVERY
// ─────────────────────────────────────────────────────────────
function submitDelivery_(body) {
  var sheet = getDeliveriesSheet_();

  // Idempotency: if this deliveryId was already committed, do nothing.
  if (body.deliveryId && deliveryExists_(sheet, body.deliveryId)) {
    return { result: "success", note: "Already recorded." };
  }

  var customerId = body.customer && body.customer.id;
  if (!customerId) throw new Error("Missing customer.");

  // Upload every captured document to Splynx.
  (body.files || []).forEach(function (f) {
    if (!f || !f.dataBase64) return;
    uploadDocument_(customerId, f);
  });

  // Log the delivery row.
  var loc = body.location || {};
  sheet.appendRow([
    body.capturedAt || new Date().toISOString(),
    customerId,
    (body.customer && body.customer.name) || "",
    body.router || "",
    body.sim || "",
    (body.agent && body.agent.name) || "",
    (body.agent && body.agent.id) || "",
    (body.collector && body.collector.type) || "",
    (body.collector && body.collector.name) || "",
    loc.latitude != null ? loc.latitude : "",
    loc.longitude != null ? loc.longitude : "",
    loc.accuracy != null ? loc.accuracy : "",
    body.deliveryId || "",
  ]);

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

function getDeliveriesSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName("Deliveries");
  if (!sheet) {
    sheet = ss.insertSheet("Deliveries");
    sheet.appendRow([
      "Timestamp",
      "Customer ID",
      "Name",
      "Router Barcode",
      "SIM Barcode",
      "Agent",
      "Agent ID",
      "Collector Type",
      "Collector Name",
      "Latitude",
      "Longitude",
      "Accuracy",
      "Delivery ID",
    ]);
  }
  return sheet;
}

function deliveryExists_(sheet, deliveryId) {
  var values = sheet.getDataRange().getValues();
  if (!values.length) return false;
  var idCol = values[0].indexOf("Delivery ID");
  if (idCol < 0) return false;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][idCol]) === String(deliveryId)) return true;
  }
  return false;
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
  var sheet = SpreadsheetApp.getActive().getSheetByName("Users");
  sheet.appendRow([id, login, fullName, salt, hashPassword_(salt, password)]);
}
