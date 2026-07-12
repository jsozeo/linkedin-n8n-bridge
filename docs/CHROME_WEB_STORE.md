# Chrome Web Store submission notes

Everything the reviewer (and the dashboard forms) need for **Social Media Bridge
for n8n**. Copy the relevant text into the corresponding dashboard fields.

## Single purpose

> This extension lets a user connect their own, already-logged-in social media
> sessions (starting with LinkedIn) to their own automation tool (n8n, Make,
> Zapier, or a self-hosted server) by running browser actions — such as opening
> a page and reading structured data — either on a schedule (cron) the user
> configures or manually from the side panel. It is a bridge/automation helper;
> it has no other function.

## Why each permission is requested

| Permission | Why it is needed |
|---|---|
| `debugger` | Actions run through the Chrome DevTools Protocol (`chrome.debugger`) so that clicks, typing and scrolling are genuine input events on the pages the user chooses to automate. This is the core mechanism of the extension. |
| `tabs` | Open, focus, read and close the tabs the extension operates on, and report tab metadata (id, url, title) back to the user's workflow. |
| `scripting` | Run the extraction/automation logic in the context of the target page. |
| `cookies` | Optional read/write of cookies for the sites the user automates, exposed as commands the user's own workflow can call. No cookies are sent to us — see Data use. |
| `webNavigation` | Detect when a newly opened tab has finished loading (`DOMContentLoaded`) so actions start at the right moment, without attaching the debugger prematurely. |
| `storage` | Persist the user's settings locally (automation webhook URL, shared token, schedule, a per-browser client id). |
| `alarms` | Wake the service worker on the user's cron schedule to run a cycle. Manifest V3 service workers are suspended when idle; alarms are the supported way to schedule work. |
| `sidePanel` | The extension's entire UI (settings + manual run) is a side panel opened from the toolbar icon. |

## Host permissions

**Requested up front** (`host_permissions`): the social-media domains the
extension can operate on — currently:
`linkedin.com`, `instagram.com`, `facebook.com`, `pinterest.com`,
`youtube.com`, `x.com`, `twitter.com`, `tiktok.com`, `threads.net`.

> Justification: the extension automates pages on these sites on the user's
> behalf (reading structured data from pages the user navigates to). It only
> ever acts on these known social platforms; it does not inject into arbitrary
> websites.

**Requested at runtime** (`optional_host_permissions: http(s)://*/*`): the
user's own automation endpoint (n8n / Make / Zapier / self-hosted) can live on
any domain, so the extension asks for permission to that **specific host only**
when the user saves its URL in the settings — never broadly at install time.

## Remote code

None. All executable code ships inside the package. The extension does not load
or `eval()` remote scripts. It exchanges only JSON with the user-configured
automation webhook.

## Data use disclosures

- **What the extension handles:** page content the user asks it to read
  (e.g. a LinkedIn profile's public fields), plus the user's settings.
- **Where it goes:** only to the automation webhook URL the user configures
  (their own n8n/Make/Zapier/server). The developer operates **no server** and
  receives **no data**.
- **Selling data:** no.
- **Use unrelated to single purpose:** no.
- **Creditworthiness/lending:** no.

Suggested privacy single-sentence: *"All data stays between your browser and the
automation endpoint you configure; the developer collects nothing."*

## Listing copy (suggested)

- **Name:** Social Media Bridge for n8n
- **Short description (≤132 chars):** Connect your social media accounts to your automation tools — on a schedule or on demand.
- **Category:** Workflow & Planning (or Developer Tools)
- **Screenshots to prepare (1280×800 or 640×400):** the side panel with the
  Manual run result, the schedule builder, and a sample n8n workflow.

## Assets

Icons are in [`../extension/icons/`](../extension/icons/) (16/32/48/128). The
128px icon doubles as the store icon; prepare a 440×280 small promo tile
separately if you want a featured listing.
