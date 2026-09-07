# Renderer App Modules

This directory contains the modular renderer implementation. `../app.js` is a
compatibility bootstrap only; feature implementation belongs here.

- `core/rendererApp.js`: composition root for legacy controller code that has
  not yet moved into a feature.
- `platform/`: DOM, storage, preload, and other browser/Electron adapters.
- `features/`: public feature entry points, controllers, views, and styles.
- `state.js`: shared renderer state and user/permission helpers.
- `constants.js`: model, attachment, agent, template, and home-screen constants.
- `storage.js`: localStorage-backed UI preferences.
- `ui/icons.js`: shared SVG icon rendering.
- `utils/format.js`: escaping, Markdown rendering, status labels, and number/date formatting.
- `utils/filePayload.js`: file preview/action payload normalization.
- `components/overlays.js`: window chrome, notices, rename dialog, and file preview modal.
- `views/navigationView.js`: sidebar, topbar, chat search modal, project/session navigation.
- `views/chatView.js`: chat messages, artifacts, attachments, composer, model and PPT pickers.
- `views/settingsView.js`: auth, account, friends, admin users, Codex, cloud, release, archive settings.
- `views/pluginsView.js`: skill list and PPT creation skill dependency card.
- `views/evolutionView.js`: agent/lab self-evolution pages and detail views.
- `views/collaborationView.js`: collaboration dashboard and task graph views.

Keep new renderer UI code in the smallest matching feature. A feature may
depend on `core`, `platform`, and shared utilities, but must use another
feature's `index.js` rather than importing its internals. Do not add feature
logic to `../app.js` or grow `core/rendererApp.js`; migrate the touched flow to
its feature controller instead.
