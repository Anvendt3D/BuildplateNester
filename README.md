# PrintNest

**PrintNest** is a private, browser-based build-plate planner for additive manufacturing. Import STEP or STL files, set quantities and print-bed constraints, find efficient layouts across one or more plates, then export a slicer-ready 3MF project.

All geometry processing, nesting, previews, project saving, and exports run in the browser. Models are never uploaded and no account or server is required.

## What it does

- Imports `.step`, `.stp`, and `.stl` part files directly in the browser
- Converts STEP geometry locally with meshStep using a planning-oriented tessellation preset
- Calculates oriented 2D footprints from imported meshes
- Plans layouts for common printer beds or custom bed dimensions
- Supports quantities, priorities, minimum quantities, edge clearance, locked placements, and manual placement edits
- Searches multiple rotations and candidate arrangements to improve plate utilisation
- Plans across multiple plates, including overflow, consolidation, and production-set workflows
- Previews and adjusts 3D part orientation before nesting
- Saves the active project in browser IndexedDB on the current device
- Exports placement data as JSON and standards-compliant Core 3MF files for any compatible slicer

## Method

1. **Import and inspect** — each part is parsed locally and represented by a 3D mesh plus a 2D footprint.
2. **Orient for print** — choose a print face manually or use the orientation helper. The resulting footprint and height are recalculated.
3. **Define the plate** — select a printer or enter custom X, Y, and Z limits. PrintNest enforces an edge safety margin and chosen part clearance.
4. **Nest** — the search evaluates eligible positions and XY rotations in the browser. The selected effort and objective trade run time against packing quality.
5. **Review and export** — inspect collisions and unassigned copies, make manual changes, then export a Core 3MF handoff for a single plate. Multi-plate jobs download as one Bambu Studio / OrcaSlicer project 3MF, preserving every plate and its placements in one file.

The nesting engine uses original geometry footprints for its final collision checks. It does not send model geometry or project data to a service.

## Run locally

Requirements: Node.js 22.18 or later.

```bash
npm ci
npm run dev
```

Open the local address Vite prints in the terminal. For a production-style local build:

```bash
npm run build
npm run preview
```

## GitHub Pages deployment

The repository includes [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml), which builds a static browser-only site and deploys it whenever `main` changes.

1. In GitHub, open **Settings → Pages** for the repository.
2. Set the publishing source to **GitHub Actions**.
3. Push to `main` or run **Deploy Nester to GitHub Pages** from the **Actions** tab.

For this repository the site is published at:

`https://anvendt3d.github.io/BuildplateNester/`

To build the same Pages artifact locally on macOS or Linux:

```bash
npm run build:pages
```

The build writes the publishable files to `dist/client`. It uses relative static-asset URLs, so the same artifact works from this repository's Pages URL or a custom domain.

## Project layout

```text
app/
  page.tsx              Application UI and browser workflow
  nest-engine.ts        Packing search and placement evaluation
  footprint.ts          Polygon footprints and collision checks
  stl.ts                STL parsing
  three-mf.ts           3MF and slicer-project export
  *.worker.ts           Background nesting and orientation work
app/step-import.worker.ts Background `meshStep` STEP conversion worker
.github/workflows/      GitHub Pages deployment
```

## Privacy and limitations

PrintNest is designed for local, in-browser planning. Browser storage is device-specific and can be cleared by browser settings. Complex STEP files and very dense layouts may take significant memory or time; reduce orientation/search effort when working with large assemblies.

This project uses [meshStep](https://github.com/CNCKitchen/meshStep) for local STEP-to-mesh conversion. It has no sign-in flow, server-side API, database, or telemetry.
