> **Superseded.** Betterleaf no longer needs the Discover API.
>
> Scenes downloaded in the Nanoleaf app land on the lights, and the lights
> serve their full effect documents over the local API. Betterleaf harvests
> them into a local library instead, which needs no cloud endpoint, no
> account, and cannot break when Nanoleaf changes something.
>
> The reconnaissance below is kept because it is hard-won and still true, and
> because browsing Discover *without* a phone would still require it.

---

# Capturing the Nanoleaf Discover API

Betterleaf can already put effects on your lights from files and from the
device's own motions. The one source it cannot reach is Nanoleaf's **Discover**
marketplace, because the API behind it has never been documented.

This is how we find out what it actually speaks.

## What we know already

Established by DNS and a single request, before any capture:

| Host | Status |
|---|---|
| `api.nanoleaf.me` | Does not resolve. The host the old cloud docs referenced is gone. |
| `cloud.nanoleaf.me` | Resolves to CloudFront, but its TLS certificate does not cover the name, so nothing can reach it over HTTPS. |
| **`my.nanoleaf.me`** | **Live JSON API.** `GET /api/v1` returns `{"error":"Not found"}` as `application/json` from nginx. Structured JSON errors mean real routes exist under it. |

So `my.nanoleaf.me` is almost certainly the target. What we don't know is the
route names, the auth scheme, or the response shape — and those are exactly what
a capture gives us without guessing.

## The honest risk

**Certificate pinning may stop this dead.** If the Nanoleaf app pins its server
certificate, it will refuse to talk through a proxy no matter how correctly the
CA is installed. You will know within about twenty minutes: the app will fail to
load the Discover tab while everything else on the phone still works.

If that happens, the remaining options are patching the APK (`apk-mitm`) or a
rooted device, and at that point it is worth asking whether the marketplace is
worth it versus the local effect library.

## Which phone to use

**Use an iPhone if you have one.** iOS apps trust user-installed CAs by default
unless they explicitly pin, so a plain profile install usually works.

**Android 7 and later ignores user-installed CAs for app traffic** unless the app
opts in, which no shipping app does. So on Android the plain route almost
certainly fails and you would need `apk-mitm` to repackage the app, or an
emulator with a writable system partition. Not impossible, just a longer road.

## Setup

### 1. Install and run mitmproxy on this PC

```powershell
pip install mitmproxy
mitmweb --listen-host 0.0.0.0 --listen-port 8080
```

That opens a browser UI at <http://127.0.0.1:8080>. Leave it running.

Windows Firewall will likely prompt — allow it on **private** networks only.

### 2. Point the phone at it

This PC is `192.168.1.73` on your LAN.

- **iOS:** Settings → Wi-Fi → (i) next to your network → Configure Proxy → Manual
  → Server `192.168.1.73`, Port `8080`
- **Android:** Wi-Fi → long-press network → Modify → Advanced → Proxy: Manual →
  same values

### 3. Install the CA certificate

On the phone, browse to <http://mitm.it> and follow the instructions for your
platform.

**iOS needs a second step people miss:** after installing the profile, go to
Settings → General → About → **Certificate Trust Settings** and enable full trust
for the mitmproxy certificate. Without this, nothing works.

### 4. Confirm it works at all

Load any website on the phone. You should see the request appear in mitmweb. If
not, stop and fix that before touching the Nanoleaf app — there is no point
debugging two problems at once.

## What to capture

With the proxy running, in the Nanoleaf app:

1. Open the **Discover** tab and let the featured list load.
2. Switch to the **Community** tab.
3. Search for something, so we see how queries are expressed.
4. Open a single scene's detail page.
5. **Download that scene to one of your devices.** This is the important one — it
   shows both the fetch and how the app turns it into a device write.

Then in mitmweb: **File → Save** the flows, or filter to `~d nanoleaf` first to
keep only Nanoleaf traffic.

## Before sending it to me

**The capture will contain your account credentials.** Please:

- Filter to Nanoleaf hosts only (`~d nanoleaf` in mitmweb) so nothing unrelated
  is included.
- Redact the **values** of `Authorization`, `Cookie`, `X-Api-Key` or similar —
  but **keep the header names and their general form** (`Bearer <redacted>` vs
  `Basic <redacted>` tells me the auth scheme, which is what I need).
- Redact your email address and any account id.

Device serial numbers are fine to leave — I already know both of yours.

## What I need out of it

Enough to write a client:

- The **host and paths** for the featured list, the community list, and search
- How **pagination** works (page numbers, cursors, offsets)
- The **auth scheme**: which header, what kind of token, and whether anonymous
  browsing is possible at all
- The **response shape** for a scene summary and a scene detail
- Whether a downloaded scene arrives as the same effect JSON the local `add`
  command takes, or needs converting

That last one matters most. If it is the same shape, Discover becomes a thin
fetch layer over machinery Betterleaf already has and is tested against. If it
differs, there is a translation step to write.

## If it works

Discover becomes one more `EffectSource` alongside files and the built-in
motions, subject to the constraints already agreed:

- Off by default, behind an explicit opt-in
- Network calls only in the main process, never the renderer
- Requests only on deliberate user action, rate limited, no bulk scraping
- Every response validated against the effect schema before it goes near a device
- Personal-use interoperability only
