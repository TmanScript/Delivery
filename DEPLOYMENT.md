# Delivery Confirmation — Deployment & Security Notes

A static web app used by field technicians to confirm Wi-Fi equipment
deliveries. It is served from GitHub Pages and talks to a **Google Apps Script
proxy** that holds all privileged credentials server-side.

```
index.html ──login──┐
                    ├──►  Apps Script proxy  ──►  Splynx API (customer docs)
Confirmation.html ──┘     (apps-script-proxy.gs)    Spreadsheet (delivery log)
```

---

## ⚠️ Do this first — rotate the leaked Splynx key

A Splynx **admin** API key was previously hard-coded into `Confirmation.html`
and pushed to this repo, so it is compromised and present in git history.

1. In Splynx, **revoke/rotate** that API key and generate a new key/secret.
2. Put the new credential only in the proxy's Script Properties (below) —
   never back in the HTML.

---

## 1. Create the spreadsheet + proxy

1. Create a Google Spreadsheet (this stores the delivery log and the user list).
2. Add a sheet named **`Users`** with this header row:

   | id | login | fullName | salt | passwordHash |
   |----|-------|----------|------|--------------|

   Leave the data rows empty for now (you'll add users in step 3).
   The `Deliveries` sheet is created automatically on the first submission.
3. **Extensions → Apps Script**, delete the boilerplate, and paste the contents
   of [`apps-script-proxy.gs`](apps-script-proxy.gs).

## 2. Configure Script Properties

**Project Settings → Script properties** → add:

| Property       | Value                                                        |
|----------------|--------------------------------------------------------------|
| `SPLYNX_BASE`  | `https://portal.umoja.network/api/2.0/admin`                 |
| `SPLYNX_AUTH`  | `Basic <base64(newApiKey:newApiSecret)>` (the rotated key)   |
| `TOKEN_SECRET` | a long random string (signs session tokens)                  |

## 3. Add technician logins

In the Apps Script editor open `apps-script-proxy.gs`, edit the values in the
`addUser()` function (`id`, `login`, `fullName`, `password`), and **Run** it once
per technician. It stores a random salt + salted SHA-256 hash — the plain
password is never saved. Repeat for each user, then clear the test values.

> Migrating the old roster: the previous login phone numbers are in this repo's
> git history. Set a real password for each and add them with `addUser()`.

## 4. Deploy as a Web App

**Deploy → New deployment → Web app**
- *Execute as:* **Me**
- *Who has access:* **Anyone**

Copy the `…/exec` URL.

## 5. Point the front-end at the proxy

Set `PROXY_URL` to that `…/exec` URL in **both**:
- `index.html` (login)
- `Confirmation.html` (customer lookup + delivery submission)

Commit and push to `main`; GitHub Pages redeploys via
`.github/workflows/static.yml`.

> Re-deploying the script after code changes: use **Manage deployments → Edit →
> New version** to keep the same `/exec` URL (otherwise update `PROXY_URL`).

---

## What changed in the front-end

**Security**
- Splynx admin credentials removed from the browser; all Splynx calls go
  through the proxy.
- Login is validated server-side (salted hashed passwords) instead of a public,
  password-less, client-side user array.
- All externally-sourced values (customer names, sheet rows) are HTML-escaped
  before rendering — fixes stored XSS.
- `html5-qrcode` and `signature_pad` are vendored under `vendor/` (version
  pinned) instead of loaded from a CDN.

**Reliability for the field**
- Photos are downscaled/compressed (max 1600px JPEG) before upload — faster and
  more reliable on weak mobile data.
- GPS location and a capture timestamp are recorded with each delivery.
- Each submission carries a stable `deliveryId`; the proxy de-duplicates, so a
  retry after a partial failure won't create duplicate documents. On error the
  captured entry is kept so the technician can simply press Confirm again.
- Required proof documents (premises photo, proof of residence, and the
  customer or collector ID/portrait) are now enforced before submitting.

**Correctness / a11y**
- Fixed the post-logout / not-logged-in redirect (`login.html` → `index.html`).
- Delivery-history CSV is parsed correctly (quoted fields / embedded commas) and
  columns are matched by header name; agent matching prefers a stable Agent ID.
- Form labels are associated with their inputs (`for`/`id`).

---

## Not yet done (discussed, deferred)

- **Offline / PWA queue** — storing deliveries locally when there is no
  connectivity and syncing later. Worth doing given where this app is used.
