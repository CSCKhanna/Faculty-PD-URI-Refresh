# URI Faculty Development Training Dashboard

This package turns the curated faculty-development list into an interactive webpage with:

- Search, provider, topic, audience, and semester filters
- Card, timeline, and table views
- CSV export
- Calendar file export
- Print view
- Clipboard-ready announcement copy
- A scheduled updater that refreshes provider sources, archives past events, and records verification snapshots

The URI-styled version is published at:

```text
https://csckhanna.github.io/Faculty-PD-URI-Refresh/
```

## Run Locally

From this folder:

```bash
node server.mjs
```

Then open:

```text
http://localhost:4173
```

The page can also be served by any static web server.

## Update the Data

To run the updater manually:

```bash
node update-feeds.mjs
```

The updater fetches every enabled source listed in `data/sources.json`, writes verification snapshots into `data/trainings.json`, refreshes known source checks, and adds new matches as `status: discovered`. It also checks every distinct training `sourceUrl` each night. A confirmed 404 or 410 must occur on two consecutive runs before an item is marked `source-removed` and hidden, which prevents a temporary outage from deleting a valid opportunity.

Sources with `catalogSync` are compared title-by-title against the dashboard. New catalog titles are added for review, missing titles require two consecutive successful catalog checks before removal, and removed titles are restored automatically if they return. URI-ATL is the first fully managed catalog. Other providers still receive daily source and link checks; their additions are discovered from configured event pages where the page structure allows it.

During the same run, clearly dated past events are archived with `status: expired` and omitted from every dashboard view and export. Expiration applies only to `exact` and updater-`detected` dates whose end date is before the current Eastern date. Ongoing resources, recommended windows, placeholders, and records with `keepAfterEnd: true` remain visible. If a recurring record is later refreshed with a future date, the updater restores its previous status automatically.

On GitHub Pages, `.github/workflows/update-training-data.yml` runs this updater daily at 11:59 p.m. Eastern and commits any resulting data changes. Its background-only audit trail is stored in `meta.updateHistory` inside `data/trainings.json`; the dashboard does not render or display that metadata.

## Edit the Curated List

Edit:

```text
data/trainings.json
```

Recommended items use:

```json
"status": "recommended"
```

Items that should be held unless URI sponsors or confirms access use:

```json
"status": "hold"
```

Automatically detected items use:

```json
"status": "discovered"
```

## Deployment Notes

For a static CMS page, copy `index.html`, `styles.css`, `app.js`, and the `data/` folder. For automatic refreshes outside GitHub Pages, run `node update-feeds.mjs` on a schedule and publish the updated `data/trainings.json`.
