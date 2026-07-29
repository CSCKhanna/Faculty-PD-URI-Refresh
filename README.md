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

The updater fetches sources listed in `data/sources.json`, writes verification snapshots into `data/trainings.json`, refreshes known source checks, and adds any new matches as `status: discovered`. Newly detected items should be reviewed before being advertised to faculty.

During the same run, clearly dated past events are archived with `status: expired` and omitted from every dashboard view and export. Expiration applies only to `exact` and updater-`detected` dates whose end date is before the current Eastern date. Ongoing resources, recommended windows, placeholders, and records with `keepAfterEnd: true` remain visible. If a recurring record is later refreshed with a future date, the updater restores its previous status automatically.

On GitHub Pages, `.github/workflows/update-training-data.yml` runs this updater daily at 11:59 p.m. Eastern and commits any resulting data changes.

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
