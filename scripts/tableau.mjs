/**
 * Tableau de jeu - Foundry VTT 13 et 14.
 *
 * Foundry utilisé comme un tableau blanc, à la Roll20 :
 *  - glisser-déposer d'images sur la scène : pages image et images des journaux, portraits des fiches
 *    (glisser le portrait, ou Maj + glisser l'acteur), images des objets, fichiers de l'ordinateur ;
 *  - trois calques, tous en tuiles (images libres : redimensionnement, rotation, sans règle de mouvement) :
 *    Fond (sous tout le reste), Joueurs (déplaçable par les joueurs), MJ (caché, ou visible sans être
 *    déplaçable) ;
 *  - verrou, « Montrer en grand », groupes d'images, de dessins et de formes ;
 *  - scène « tableau » vierge, nettoyage d'un calque, préparation et bascule de scène.
 *
 * Calque Joueurs : Foundry ne laisse que le MJ modifier une tuile. Le client du joueur gère donc lui-même le
 * glisser (aperçu local) et demande le déplacement au MJ connecté par le canal du module (game.socket).
 *
 * Données : `flags.tableau-de-jeu` = { layer: "fond" | "joueurs" | "mj", group?: identifiant, name? } sur les
 * tuiles et dessins ; { board: true } sur les scènes tableau ; noms des groupes dans
 * `flags.tableau-de-jeu.groups` de la scène. La version 1.0 posait des jetons : convertis en tuiles par le MJ.
 */

const MODULE = "tableau-de-jeu";
const APP_ID = "tableau-de-jeu-panel";
const LAYERS = {
  fond: { label: "Fond", icon: "fa-solid fa-image", hint: "sous tout le reste, MJ seul" },
  joueurs: { label: "Joueurs", icon: "fa-solid fa-users", hint: "visible, déplaçable par les joueurs" },
  mj: { label: "MJ", icon: "fa-solid fa-user-secret", hint: "MJ seul, ou visible sans être déplaçable" }
};
const LAYER_ORDER = ["fond", "joueurs", "mj"];
const GROUPABLE = ["Tile", "Drawing"];
const SOCKET = "module.tableau-de-jeu";
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|svg|bmp)(\?.*)?$/i;

/* ---------------------------------------------------------------------------------------------- */
/* Outils                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const flagOf = (doc) => doc?.flags?.[MODULE] ?? {};
const isActiveGM = () => game.users.activeGM?.isSelf ?? game.user.isGM;
const filePicker = () => foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
const ImagePopoutClass = () => foundry.applications?.apps?.ImagePopout ?? globalThis.ImagePopout;
const DialogV2 = () => foundry.applications.api.DialogV2;
const uuidSync = (uuid) => (foundry.utils.fromUuidSync ?? globalThis.fromUuidSync)(uuid);
const isV14 = () => (game.release?.generation ?? 13) >= 14;
/** Suppression d'une clé de données (syntaxe « -=clé », encore acceptée en v14). */
const unsetKey = (path) => {
  const parts = path.split(".");
  const last = parts.pop();
  return { [[...parts, `-=${last}`].join(".")]: null };
};
const boardElement = () => canvas?.app?.canvas ?? canvas?.app?.view ?? document.getElementById("board");

function notify(message, type = "info") {
  ui.notifications?.[type]?.(message);
}

/** Calque d'une tuile (Fond par défaut pour une tuile posée sans le module). */
function layerOf(doc) {
  if (doc?.documentName !== "Tile") return null;
  const layer = flagOf(doc).layer;
  return LAYERS[layer] ? layer : "fond";
}

/** Image et géométrie (pixels) d'une tuile, ou d'un jeton d'image de la version 1.0. */
function geometry(doc) {
  const grid = doc.parent?.grid?.size ?? canvas.dimensions?.size ?? 100;
  const isToken = doc.documentName === "Token";
  return {
    src: doc.texture?.src ?? "",
    name: flagOf(doc).name || doc.name || "",
    x: doc.x, y: doc.y,
    w: isToken ? doc.width * grid : doc.width,
    h: isToken ? doc.height * grid : doc.height,
    rotation: doc.rotation ?? 0,
    locked: !!doc.locked,
    hidden: !!doc.hidden,
    group: flagOf(doc).group ?? null,
    level: doc.level ?? (doc.levels?.size ? [...doc.levels][0] : null)
  };
}

/** Niveau affiché (Foundry 14) : les images déposées y sont rangées. */
const currentLevel = () => canvas.level?.id ?? null;

/** Taille naturelle d'une image (pixels). */
async function naturalSize(src) {
  try {
    const load = foundry.canvas?.loadTexture ?? globalThis.loadTexture;
    const tex = await load(src);
    if (tex?.width) return { w: tex.width, h: tex.height };
  } catch (err) { /* repli ci-dessous */ }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 400, h: img.naturalHeight || 400 });
    img.onerror = () => resolve({ w: 400, h: 400 });
    img.src = src;
  });
}

/** Taille de dépôt : image entière, réduite pour tenir dans 40 % de la scène. */
function fitSize({ w, h }) {
  const d = canvas.dimensions;
  const max = Math.max(200, Math.min(d?.sceneWidth ?? 2000, d?.sceneHeight ?? 2000) * 0.4);
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(50, Math.round(w * scale)), h: Math.max(50, Math.round(h * scale)) };
}

/** Chemin utilisable par Foundry pour une adresse d'image glissée (même serveur : chemin relatif). */
function normalizeSrc(url) {
  if (!url) return null;
  try {
    const u = new URL(url, window.location.href);
    if (u.protocol === "data:") return url;
    if (u.origin === window.location.origin) {
      const prefix = foundry.utils.getRoute?.("/") ?? "/";
      let path = decodeURIComponent(u.pathname);
      if (prefix !== "/" && path.startsWith(prefix)) path = path.slice(prefix.length);
      return path.replace(/^\/+/, "");
    }
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch (err) {
    return null;
  }
}

/** Image d'un glisser-déposer du navigateur (élément <img>, lien vers une image). */
function imageFromTransfer(dt) {
  const html = dt.getData("text/html");
  if (html) {
    const img = new DOMParser().parseFromString(html, "text/html").querySelector("img[src]");
    if (img) return { src: normalizeSrc(img.getAttribute("src")), name: img.getAttribute("alt") || img.getAttribute("title") || "" };
  }
  const list = dt.getData("text/uri-list").split(/\r?\n/).find((l) => l && !l.startsWith("#"));
  if (list && IMAGE_EXT.test(list)) return { src: normalizeSrc(list), name: "" };
  return null;
}

const baseName = (src) => decodeURIComponent(String(src).split("/").pop()?.split("?")[0] ?? "")
  .replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();

/* ---------------------------------------------------------------------------------------------- */
/* Création et changement de calque                                                                */
/* ---------------------------------------------------------------------------------------------- */

/** Ordre d'affichage d'une tuile selon son calque : Fond sous les autres tuiles, MJ au-dessus. */
function sortFor(scene, layer) {
  const sorts = scene.tiles.map((t) => t.sort ?? 0);
  if (!sorts.length) return 0;
  return layer === "fond" ? Math.min(...sorts) - 1 : Math.max(...sorts) + 1;
}

/** Données d'une tuile pour un calque, à partir d'une géométrie. */
function tileData(scene, layer, g) {
  const level = g.level ?? currentLevel();
  return {
    texture: { src: g.src }, x: Math.round(g.x), y: Math.round(g.y), width: Math.round(g.w), height: Math.round(g.h),
    rotation: g.rotation ?? 0, locked: !!g.locked, hidden: layer === "mj" ? !!g.hidden : false,
    sort: sortFor(scene, layer),
    ...(level && TileDocument.schema?.fields?.levels ? { levels: [level] } : {}),
    flags: { [MODULE]: { layer, ...(g.group ? { group: g.group } : {}), ...(g.name ? { name: g.name } : {}) } }
  };
}

/** Pose une image sur la scène en cours, centrée sur (x, y), sur la couche active (cachée sur la couche MJ). */
async function placeImage({ src, name, x, y, layer = activeCouche() }) {
  const scene = canvas.scene;
  if (!scene || !src) return;
  if (!game.user.isGM) return notify("Seul le MJ peut poser des images sur la scène.", "warn");
  const { w, h } = fitSize(await naturalSize(src));
  const g = { src, name: name || baseName(src), x: x - w / 2, y: y - h / 2, w, h,
    rotation: 0, locked: false, hidden: true, group: null, level: currentLevel() };
  const [doc] = await scene.createEmbeddedDocuments("Tile", [tileData(scene, layer, g)]);
  // Les images sont des tuiles : outil Tuiles activé pour pouvoir les prendre, redimensionner, tourner.
  if (canvas.activeLayer !== canvas.tiles) canvas.tiles?.activate?.();
  notify(`« ${g.name} » posée sur la couche ${LAYERS[layer].label}${layer === "mj" ? " (cachée aux joueurs)" : ""}.`);
  return doc;
}

/** Fait passer des tuiles sur un autre calque (position, taille, rotation, groupe gardés). */
async function moveToLayer(docs, layer) {
  if (!game.user.isGM) return;
  const items = docs.filter((d) => d.documentName === "Tile" && layerOf(d) !== layer);
  if (!items.length) return;
  const byScene = new Map();
  for (const doc of items) {
    if (!byScene.has(doc.parent)) byScene.set(doc.parent, []);
    const update = { _id: doc.id, [`flags.${MODULE}.layer`]: layer, sort: sortFor(doc.parent, layer) };
    if (layer === "fond") update.hidden = false;  // le Fond est protégé en n'étant pas la couche active
    if (layer === "joueurs") update.hidden = false;
    if (layer === "mj") update.hidden = true;     // entrer sur le calque MJ : caché par défaut
    byScene.get(doc.parent).push(update);
  }
  for (const [scene, updates] of byScene) await scene.updateEmbeddedDocuments("Tile", updates, { [MODULE]: { sync: true } });
  notify(`${items.length} image(s) envoyée(s) sur la couche ${LAYERS[layer].label}${layer === activeCouche() ? "" : ` (Maj+${LAYER_ORDER.indexOf(layer) + 1} pour y aller)`}.`);
}

/** Version 1.0 : les images étaient des jetons d'acteurs du module ; converties en tuiles (MJ actif). */
async function convertLegacyTokens() {
  if (!isActiveGM()) return;
  const boardActors = new Set(game.actors.filter((a) => flagOf(a).board === "joueurs" || flagOf(a).board === "mj").map((a) => a.id));
  if (!boardActors.size) return;
  let count = 0;
  for (const scene of game.scenes) {
    const tokens = scene.tokens.filter((t) => boardActors.has(t.actorId));
    if (!tokens.length) continue;
    const data = tokens.map((t) => {
      const layer = flagOf(t).layer ?? flagOf(game.actors.get(t.actorId)).board;
      return tileData(scene, LAYERS[layer] ? layer : "mj", geometry(t));
    });
    await scene.createEmbeddedDocuments("Tile", data);
    await scene.deleteEmbeddedDocuments("Token", tokens.map((t) => t.id));
    count += tokens.length;
  }
  if (count) notify(`Tableau de jeu : ${count} image(s) de la version précédente converties en tuiles. Les acteurs « Tableau - Joueurs » et « Tableau - MJ » peuvent être supprimés.`);
}

/** 1.1 verrouillait les images envoyées sur le Fond : déverrouillées une fois (la couche active les protège). */
async function unlockLegacyFond() {
  if (!isActiveGM() || game.settings.get(MODULE, "migrated12")) return;
  for (const scene of game.scenes) {
    const tiles = scene.tiles.filter((t) => flagOf(t).layer === "fond" && t.locked);
    if (tiles.length) await scene.updateEmbeddedDocuments("Tile", tiles.map((t) => ({ _id: t.id, locked: false })), { [MODULE]: { sync: true } });
  }
  await game.settings.set(MODULE, "migrated12", true);
}

/* ---------------------------------------------------------------------------------------------- */
/* Sélection, groupes, verrou, visibilité                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** Documents sélectionnés sur le calque actif. */
function selection() {
  return (canvas.activeLayer?.controlled ?? []).map((o) => o.document).filter((d) => GROUPABLE.includes(d.documentName));
}

/** Documents visés : la sélection si elle contient `doc`, sinon `doc` seul. */
function targets(doc) {
  const sel = selection();
  return doc && !sel.includes(doc) ? [doc] : sel;
}

function groupMembers(scene, group) {
  if (!scene || !group) return [];
  return GROUPABLE.flatMap((type) => scene.getEmbeddedCollection(type).filter((d) => flagOf(d).group === group));
}

/** Les documents et tous les membres de leurs groupes. */
function withGroups(docs) {
  const out = new Set(docs);
  for (const doc of docs) for (const m of groupMembers(doc.parent, flagOf(doc).group)) out.add(m);
  return [...out];
}

async function updateMany(docs, changes, options = {}) {
  const byKey = new Map();
  for (const doc of docs) {
    const key = `${doc.parent.uuid}|${doc.documentName}`;
    if (!byKey.has(key)) byKey.set(key, { scene: doc.parent, type: doc.documentName, updates: [] });
    byKey.get(key).updates.push({ _id: doc.id, ...(typeof changes === "function" ? changes(doc) : changes) });
  }
  for (const { scene, type, updates } of byKey.values()) {
    await scene.updateEmbeddedDocuments(type, updates, { [MODULE]: { sync: true }, ...options });
  }
}

async function toggleLock(docs) {
  const all = withGroups(docs);
  if (!all.length) return;
  const lock = !all.every((d) => d.locked);
  await updateMany(all, { locked: lock });
  notify(lock ? `${all.length} élément(s) verrouillé(s).` : `${all.length} élément(s) déverrouillé(s).`);
}

async function toggleHidden(docs) {
  const all = withGroups(docs).filter((d) => d.documentName !== "Tile" || layerOf(d) !== "fond");
  if (!all.length) return notify("Le calque Fond est toujours visible : passez l'image sur le calque MJ pour la cacher.", "warn");
  const hide = !all.every((d) => d.hidden);
  await updateMany(all, { hidden: hide });
  notify(hide ? "Caché aux joueurs." : "Visible des joueurs.");
}

async function groupSelection(docs, groupId = null) {
  if (docs.length < (groupId ? 1 : 2)) return notify("Sélectionnez au moins deux éléments à grouper.", "warn");
  const scene = docs[0].parent;
  const existing = groupId ?? docs.map((d) => flagOf(d).group).find(Boolean);
  const group = existing ?? foundry.utils.randomID();
  await updateMany(docs, { [`flags.${MODULE}.group`]: group });
  const names = scene.flags?.[MODULE]?.groups ?? {};
  if (!names[group]) {
    const n = Object.keys(names).length + 1;
    await scene.update({ [`flags.${MODULE}.groups.${group}`]: `Groupe ${n}` });
  }
  notify(`${docs.length} élément(s) dans « ${scene.flags?.[MODULE]?.groups?.[group] ?? "le groupe"} ». Ils bougent ensemble.`);
  return group;
}

async function ungroup(docs) {
  const grouped = docs.filter((d) => flagOf(d).group);
  if (!grouped.length) return;
  await updateMany(grouped, unsetKey(`flags.${MODULE}.group`));
  notify(`${grouped.length} élément(s) retiré(s) de leur groupe.`);
}

async function dissolveGroup(scene, group) {
  await updateMany(groupMembers(scene, group), unsetKey(`flags.${MODULE}.group`));
  await scene.update(unsetKey(`flags.${MODULE}.groups.${group}`));
}

/* Déplacement d'un groupe : le client qui déplace note le décalage ; le MJ actif applique le même décalage
   aux autres membres (un joueur ne peut pas modifier une tuile ni un jeton du MJ). */

const syncedOps = new Set();

function onPreUpdate(doc, change, options) {
  if (options[MODULE]?.sync) return;
  const group = flagOf(doc).group;
  if (!group || (!("x" in change) && !("y" in change))) return;
  const dx = (change.x ?? doc.x) - doc.x;
  const dy = (change.y ?? doc.y) - doc.y;
  if (!dx && !dy) return;
  const info = (options[MODULE] ??= {});
  info.op ??= foundry.utils.randomID();
  info.moved ??= [];
  info.deltas ??= {};
  info.moved.push(doc.id);
  info.deltas[group] ??= { dx, dy };
}

function onUpdate(doc, change, options) {
  const info = options[MODULE];
  if (!info || info.sync || !isActiveGM()) return;
  const group = flagOf(doc).group;
  const delta = group && info.deltas?.[group];
  if (!delta) return;
  const key = `${info.op}|${group}`;
  if (syncedOps.has(key)) return;
  syncedOps.add(key);
  if (syncedOps.size > 500) syncedOps.clear();
  const moved = new Set(info.moved);
  const others = groupMembers(doc.parent, group).filter((m) => !moved.has(m.id));
  if (others.length) updateMany(others, (m) => ({ x: m.x + delta.dx, y: m.y + delta.dy })).catch((err) => console.error(`${MODULE} |`, err));
}

/* ---------------------------------------------------------------------------------------------- */
/* Calque Joueurs : glisser par les joueurs, appliqué par le MJ                                    */
/* ---------------------------------------------------------------------------------------------- */

/** Le point (coordonnées de la scène) est-il dans la tuile, rotation comprise ? */
function tileContains(doc, p) {
  const cx = doc.x + doc.width / 2;
  const cy = doc.y + doc.height / 2;
  const a = -((doc.rotation ?? 0) * Math.PI) / 180;
  const dx = p.x - cx, dy = p.y - cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= doc.width / 2 && Math.abs(ly) <= doc.height / 2;
}

/** Tuile du calque Joueurs la plus haute sous le point, déplaçable par les joueurs. */
function playerTileAt(p) {
  const tiles = canvas.tiles?.placeables ?? [];
  return tiles
    .filter((t) => t.visible !== false && layerOf(t.document) === "joueurs" && !t.document.hidden && !t.document.locked
      && tileContains(t.document, p))
    .sort((a, b) => (b.document.elevation ?? 0) - (a.document.elevation ?? 0) || (b.document.sort ?? 0) - (a.document.sort ?? 0))[0] ?? null;
}

let playerDrag = null;

/* MJ : comme dans Roll20, un clic prend ce qui est sous le pointeur sans changer d'outil à la main. Sur l'outil
   Jetons, un clic sur une image (aucun jeton dessous) passe sur l'outil Tuiles avant que Foundry ne traite le
   clic : l'image est prise du premier coup. Sur l'outil Tuiles, un clic sur un jeton revient aux Jetons. */
function onGMPointerDown(event) {
  if (!game.user.isGM || event.button !== 0 || !canvas?.ready || event.target !== boardElement()) return;
  const active = canvas.activeLayer;
  if (active !== canvas.tokens && active !== canvas.tiles) return;
  const p = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  const token = canvas.tokens?.placeables?.find((t) => t.visible && t.bounds?.contains(p.x, p.y));
  if (token) {
    if (active === canvas.tiles) canvas.tokens.activate();
    return;
  }
  if (active !== canvas.tokens) return;
  const tile = (canvas.tiles?.placeables ?? []).some((t) => t.visible !== false && layerOf(t.document) === activeCouche()
    && tileContains(t.document, p));
  if (tile) canvas.tiles.activate();
}

function onPlayerPointerDown(event) {
  if (game.user.isGM || event.button !== 0 || !canvas?.ready || event.target !== boardElement()) return;
  const p = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  // Un jeton que le joueur peut prendre (son personnage) reste prioritaire.
  const token = canvas.tokens?.placeables?.find((t) => t.visible && t.document.isOwner && t.bounds?.contains(p.x, p.y));
  if (token) return;
  const tile = playerTileAt(p);
  if (!tile) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  const members = groupMembers(canvas.scene, flagOf(tile.document).group)
    .map((d) => d.object).filter((o) => o && o !== tile);
  playerDrag = {
    tile, start: p, moved: false, ox: tile.document.x, oy: tile.document.y,
    previews: [tile, ...members].map((o) => { const view = o.mesh ?? o.shape ?? o; return { object: o, mesh: view, x: view.x, y: view.y }; })
  };
  window.addEventListener("pointermove", onPlayerPointerMove, true);
  window.addEventListener("pointerup", onPlayerPointerUp, true);
}

function onPlayerPointerMove(event) {
  if (!playerDrag) return;
  event.preventDefault();
  event.stopPropagation();
  const p = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  const dx = p.x - playerDrag.start.x, dy = p.y - playerDrag.start.y;
  if (Math.abs(dx) + Math.abs(dy) > 2) playerDrag.moved = true;
  for (const pv of playerDrag.previews) pv.mesh.position?.set?.(pv.x + dx, pv.y + dy);
}

function restorePreview(drag) {
  for (const pv of drag.previews) pv.mesh.position?.set?.(pv.x, pv.y);
}

function onPlayerPointerUp(event) {
  window.removeEventListener("pointermove", onPlayerPointerMove, true);
  window.removeEventListener("pointerup", onPlayerPointerUp, true);
  const drag = playerDrag;
  playerDrag = null;
  if (!drag) return;
  event.preventDefault();
  event.stopPropagation();
  if (!drag.moved) return restorePreview(drag);
  const p = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  const doc = drag.tile.document;
  if (!game.users.activeGM) {
    restorePreview(drag);
    return notify("Aucun MJ connecté : l'image ne peut pas être déplacée.", "warn");
  }
  game.socket.emit(SOCKET, { type: "move", sceneId: doc.parent.id, tileId: doc.id, userId: game.user.id,
    x: drag.ox + (p.x - drag.start.x), y: drag.oy + (p.y - drag.start.y) });
  // Sans réponse du MJ (refus, déconnexion), l'image revient à sa place.
  setTimeout(() => {
    if (doc.x === drag.ox && doc.y === drag.oy) restorePreview(drag);
  }, 3000);
}

/** Côté MJ actif : déplacement demandé par un joueur, vérifié puis appliqué (le groupe suit). */
function onSocket(message) {
  if (message?.type !== "move" || !isActiveGM()) return;
  const scene = game.scenes.get(message.sceneId);
  const tile = scene?.tiles.get(message.tileId);
  const user = game.users.get(message.userId);
  if (!tile || !user || layerOf(tile) !== "joueurs" || tile.hidden || tile.locked) return;
  const d = scene.dimensions;
  const x = Math.round(Math.min(Math.max(Number(message.x), -tile.width), (d?.width ?? 1e5)));
  const y = Math.round(Math.min(Math.max(Number(message.y), -tile.height), (d?.height ?? 1e5)));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  tile.update({ x, y }, { [MODULE]: { relay: user.id } }).catch((err) => console.error(`${MODULE} |`, err));
}

/* ---------------------------------------------------------------------------------------------- */
/* Montrer en grand                                                                                */
/* ---------------------------------------------------------------------------------------------- */

function showLarge(doc) {
  const src = doc?.texture?.src;
  if (!src) return;
  const Popout = ImagePopoutClass();
  const title = flagOf(doc).name || doc.name || baseName(src) || "Image";
  // showTitle : les joueurs n'ont pas de droit sur la tuile, le titre serait masqué chez eux.
  const popout = new Popout({ src, uuid: doc.uuid, showTitle: true, caption: title, window: { title } });
  popout.render(true);
  popout.shareImage?.();
}

/* ---------------------------------------------------------------------------------------------- */
/* Dépôts sur la scène                                                                             */
/* ---------------------------------------------------------------------------------------------- */

async function uploadFile(file) {
  const FP = filePicker();
  const root = `worlds/${game.world.id}`;
  const dir = `${root}/tableau`;
  try { await FP.createDirectory("data", dir, {}); } catch (err) { /* existe déjà */ }
  const safe = file.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "-");
  const named = new File([file], `${Date.now()}-${safe}`, { type: file.type });
  const result = await FP.upload("data", dir, named, {}, { notify: false });
  if (!result?.path) throw new Error(result?.message || "dépôt refusé par Foundry");
  return result.path;
}

async function dataUrlToFile(src, name) {
  const blob = await (await fetch(src)).blob();
  const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
  return new File([blob], `${name || "image"}.${ext}`, { type: blob.type });
}

/* Images des fenêtres de Foundry (portrait d'une fiche, image d'une page de journal, image dans le texte) :
   rendues glissables pour le MJ, avec l'adresse de l'image comme donnée de glisser. Ce qui est déjà
   glissable (ligne d'objet d'une fiche, entrée de la barre latérale) et l'éditeur de texte ne sont pas touchés. */
const IMAGE_DRAG = "TableauImage";

function draggableWindowImage(target) {
  if (!game.user.isGM || !(target instanceof HTMLImageElement)) return null;
  if (!target.closest(".application, .app, .window-app")) return null;
  if (target.closest("#sidebar, .directory, [contenteditable='true'], .editor-content.editing")) return null;
  if (target.parentElement?.closest("[draggable='true']")) return null;
  const src = normalizeSrc(target.currentSrc || target.getAttribute("src"));
  return src ? { src, name: target.getAttribute("alt") || target.getAttribute("title") || target.dataset.tooltip || "" } : null;
}

function onWindowImagePointerDown(event) {
  const img = draggableWindowImage(event.target);
  if (img) event.target.draggable = true;
}

function onWindowImageDragStart(event) {
  const img = draggableWindowImage(event.target);
  if (!img) return;
  event.stopPropagation();
  event.dataTransfer.setData("text/plain", JSON.stringify({ type: IMAGE_DRAG, ...img }));
  event.dataTransfer.effectAllowed = "copy";
}

/** Dépôt du navigateur sur la scène : fichiers de l'ordinateur, <img> glissée d'un journal ou d'une fiche. */
function onNativeDrop(event) {
  const board = boardElement();
  if (!board || event.target !== board || !game.user.isGM || !canvas.scene) return;
  const dt = event.dataTransfer;
  if (!dt) return;
  const text = dt.getData("text/plain");
  let json = null;
  if (text && text.trim().startsWith("{")) {
    try { json = JSON.parse(text); } catch (err) { json = null; }
    // Document de Foundry (page, objet, acteur…) : laissé à dropCanvasData.
    if (json?.type !== IMAGE_DRAG) return;
  }
  if (json?.type === IMAGE_DRAG) {
    event.preventDefault();
    event.stopPropagation();
    const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
    placeImage({ src: json.src, name: json.name, x: point.x, y: point.y })
      .catch((err) => notify(`Image non posée : ${err.message ?? err}`, "error"));
    return;
  }
  // Une <img> de Foundry glissée peut aussi remplir dt.files : l'adresse sur le serveur est alors préférée.
  const fromPage = dt.types?.includes?.("text/html") ? imageFromTransfer(dt) : null;
  const local = fromPage?.src && !/^(https?:|data:)/.test(fromPage.src);
  const files = local ? [] : [...(dt.files ?? [])].filter((f) => f.type.startsWith("image/"));
  const image = files.length ? null : (fromPage ?? imageFromTransfer(dt));
  if (!files.length && !image?.src) return;
  event.preventDefault();
  event.stopPropagation();
  const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  (async () => {
    let offset = 0;
    for (const file of files) {
      const path = await uploadFile(file);
      await placeImage({ src: path, name: baseName(file.name), x: point.x + offset, y: point.y + offset });
      offset += 40;
    }
    if (image?.src) {
      let src = image.src;
      if (src.startsWith("data:")) src = await uploadFile(await dataUrlToFile(src, image.name));
      await placeImage({ src, name: image.name, x: point.x, y: point.y });
    }
  })().catch((err) => {
    console.error(`${MODULE} |`, err);
    notify(`Image non posée : ${err.message ?? err}`, "error");
  });
}

/** Dépôt d'un document de Foundry : page image, objet, acteur avec Alt. */
function onDropCanvasData(cnv, data, event) {
  if (!game.user.isGM || !data?.uuid) return;
  // Maj : Alt est déjà pris par Foundry (dépôt d'un jeton caché).
  const shift = !!(event?.shiftKey || game.keyboard?.isModifierActive?.("Shift"));
  let src = null, name = "";
  const get = (uuid) => {
    try { return uuidSync(uuid); } catch (err) { return null; }  // compendium non chargé : comportement de Foundry
  };
  if (data.type === "JournalEntryPage") {
    const page = get(data.uuid);
    if (page?.type !== "image" || !page.src) return;  // page de texte : note de Foundry, comme d'habitude
    src = page.src;
    name = page.image?.caption || page.name;
  } else if (data.type === "Item") {
    // Objet lâché sur un jeton : laissé au système (donner l'objet au personnage, etc.).
    if (data.x != null && canvas.tokens?.placeables?.some((t) => t.bounds?.contains(data.x, data.y))) return;
    const item = get(data.uuid);
    src = item?.img;
    name = item?.name;
  } else if (data.type === "Actor" && shift) {
    const actor = get(data.uuid);
    src = actor?.img;
    name = actor?.name;
  } else {
    return;
  }
  if (!src || src === CONST.DEFAULT_TOKEN) return;
  let { x, y } = data;
  if ((x == null || y == null) && event) ({ x, y } = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY }));
  if (x == null || y == null) ({ x, y } = canvas.scene.dimensions?.rect?.center ?? { x: 0, y: 0 });
  placeImage({ src, name, x, y }).catch((err) => notify(`Image non posée : ${err.message ?? err}`, "error"));
  return false;
}

/* ---------------------------------------------------------------------------------------------- */
/* Boutons du clic droit (HUD)                                                                     */
/* ---------------------------------------------------------------------------------------------- */

function hudButton(icon, title, onClick, active = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `control-icon tableau-hud${active ? " active" : ""}`;
  button.dataset.tooltip = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = `<i class="${icon}"></i>`;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    Promise.resolve(onClick()).catch((err) => notify(err.message ?? String(err), "error"));
  });
  return button;
}

function onRenderHUD(hud, html) {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const doc = hud.document ?? hud.object?.document;
  if (!root || !doc) return;
  const layer = layerOf(doc);
  const isImage = !!layer && !!doc.texture?.src;
  const column = root.querySelector(".col.left") ?? root;
  if (column.querySelector(".tableau-hud-box")) return;
  const box = document.createElement("div");
  box.className = "tableau-hud-box";
  if (isImage) {
    for (const key of LAYER_ORDER) {
      box.append(hudButton(LAYERS[key].icon, `Calque ${LAYERS[key].label} : ${LAYERS[key].hint}`,
        () => (key === layer ? null : moveToLayer(targets(doc), key)), key === layer));
    }
    box.append(hudButton("fa-solid fa-expand", "Montrer en grand aux joueurs", () => showLarge(doc)));
  }
  box.append(hudButton(doc.locked ? "fa-solid fa-lock" : "fa-solid fa-lock-open",
    doc.locked ? "Déverrouiller (avec son groupe)" : "Verrouiller (avec son groupe)", () => toggleLock(targets(doc)), doc.locked));
  const group = flagOf(doc).group;
  box.append(group
    ? hudButton("fa-solid fa-object-ungroup", "Retirer du groupe", () => ungroup(targets(doc)), true)
    : hudButton("fa-solid fa-object-group", "Grouper la sélection", () => groupSelection(targets(doc))));
  column.append(box);
}

/* ---------------------------------------------------------------------------------------------- */
/* Panneau « Tableau de jeu »                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------------------------- */
/* Couche active (comme Roll20) : seules ses images se prennent                                    */
/* ---------------------------------------------------------------------------------------------- */

const COUCHE_COLORS = { fond: "#9aa3ad", joueurs: "#3fae5b", mj: "#d9534f" };

function activeCouche() {
  const value = game.settings.get(MODULE, "couche");
  return LAYERS[value] ? value : "mj";
}

/** Change de couche : seules les images de la nouvelle couche réagissent, l'outil Tuiles est activé. */
async function setCouche(layer, { activateTiles = true } = {}) {
  if (!game.user.isGM || !LAYERS[layer]) return;
  await game.settings.set(MODULE, "couche", layer);
  applyCouche();
  if (activateTiles && canvas?.ready && canvas.activeLayer !== canvas.tiles) canvas.tiles?.activate?.();
}

/** Interactivité des tuiles selon la couche active (MJ seulement), barre, liseré, panneau. */
function applyCouche() {
  if (!game.user.isGM) return;
  for (const tile of canvas?.tiles?.placeables ?? []) applyTileCouche(tile);
  for (const tile of [...(canvas?.tiles?.controlled ?? [])]) {
    if (layerOf(tile.document) !== activeCouche()) tile.release();
  }
  renderCoucheBar();
  refreshPanel();
}

function applyTileCouche(tile) {
  if (!game.user.isGM || !tile?.document) return;
  const inCouche = layerOf(tile.document) === activeCouche();
  // Hors de la couche active : le clic passe à travers (eventMode de PIXI), comme dans Roll20.
  if (!inCouche) tile.eventMode = "none";
  else if (canvas.tiles?.active && tile.eventMode === "none") tile.eventMode = "static";
}

/** Sélection au cadre (ou par programme) d'une image d'une autre couche : relâchée aussitôt. */
function onControlTile(tile, controlled) {
  if (controlled && game.user.isGM && layerOf(tile.document) !== activeCouche()) tile.release();
}

/** Barre fixe en haut de la scène : couche active, changement de couche, panneau. */
function renderCoucheBar() {
  if (!game.user.isGM) return;
  let bar = document.getElementById("tableau-couche-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "tableau-couche-bar";
    bar.addEventListener("click", (event) => {
      const button = event.target.closest("[data-couche], [data-open]");
      if (!button) return;
      event.preventDefault();
      if (button.dataset.open) return TableauPanel.open();
      setCouche(button.dataset.couche);
    });
    document.body.append(bar);
  }
  let frame = document.getElementById("tableau-couche-frame");
  if (!frame) {
    frame = document.createElement("div");
    frame.id = "tableau-couche-frame";
    document.body.append(frame);
  }
  const current = activeCouche();
  const show = !!canvas?.ready && !!canvas.scene;
  bar.hidden = !show;
  frame.hidden = !show || !game.settings.get(MODULE, "frame");
  frame.style.setProperty("--tableau-couche", COUCHE_COLORS[current]);
  bar.style.setProperty("--tableau-couche", COUCHE_COLORS[current]);
  bar.innerHTML = LAYER_ORDER.map((k, i) => `
    <button type="button" data-couche="${k}" class="${k === current ? "active" : ""}" style="--c: ${COUCHE_COLORS[k]}"
      data-tooltip="Couche ${LAYERS[k].label} : ${LAYERS[k].hint} (Maj+${i + 1})" aria-pressed="${k === current}">
      <i class="${LAYERS[k].icon}"></i> ${LAYERS[k].label}
    </button>`).join("") + `
    <button type="button" data-open="1" class="tableau-bar__panel" data-tooltip="Panneau Tableau de jeu (Maj+B)" aria-label="Panneau Tableau de jeu">
      <i class="fa-solid fa-chalkboard"></i>
    </button>`;
}

/* Pastille au survol : couche de l'image sous le pointeur, cachée, verrouillée. */
let hoverFrame = 0;
let lastPointer = null;

function onHoverMove(event) {
  if (!game.user.isGM) return;
  lastPointer = { x: event.clientX, y: event.clientY, target: event.target };
  if (hoverFrame) return;
  hoverFrame = requestAnimationFrame(updateHoverBadge);
}

function updateHoverBadge() {
  hoverFrame = 0;
  let badge = document.getElementById("tableau-hover-badge");
  const hide = () => { if (badge) badge.hidden = true; };
  if (!lastPointer || !canvas?.ready || lastPointer.target !== boardElement() || !game.settings.get(MODULE, "badge")) return hide();
  if (canvas.activeLayer !== canvas.tiles && canvas.activeLayer !== canvas.tokens) return hide();
  const p = canvas.canvasCoordinatesFromClient({ x: lastPointer.x, y: lastPointer.y });
  if (canvas.tokens?.placeables?.some((t) => t.visible && t.bounds?.contains(p.x, p.y))) return hide();
  const tile = (canvas.tiles?.placeables ?? [])
    .filter((t) => t.visible !== false && tileContains(t.document, p))
    .sort((a, b) => (b.document.elevation ?? 0) - (a.document.elevation ?? 0) || (b.document.sort ?? 0) - (a.document.sort ?? 0))[0];
  if (!tile) return hide();
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "tableau-hover-badge";
    document.body.append(badge);
  }
  const doc = tile.document;
  const layer = layerOf(doc);
  const other = layer !== activeCouche();
  badge.style.setProperty("--c", COUCHE_COLORS[layer]);
  badge.classList.toggle("is-other", other);
  badge.innerHTML = `<i class="${LAYERS[layer].icon}"></i> ${LAYERS[layer].label}`
    + (doc.hidden ? ' · <i class="fa-solid fa-eye-slash"></i> cachée' : "")
    + (doc.locked ? ' · <i class="fa-solid fa-lock"></i>' : "")
    + (flagOf(doc).group ? ' · <i class="fa-solid fa-object-group"></i>' : "")
    + (other ? ` <span>(Maj+${LAYER_ORDER.indexOf(layer) + 1} pour la prendre)</span>` : "");
  badge.style.left = `${lastPointer.x + 16}px`;
  badge.style.top = `${lastPointer.y + 18}px`;
  badge.hidden = false;
}

/* ---------------------------------------------------------------------------------------------- */
/* Panneau « Tableau de jeu » : onglets Couche, Groupes, Scènes                                    */
/* ---------------------------------------------------------------------------------------------- */

const { ApplicationV2 } = foundry.applications.api;

const HELP = `
  <ul>
    <li><strong>Couche active</strong> (barre en haut de la scène, Maj+1 / 2 / 3) : seules ses images se prennent. Une image déposée y arrive (cachée sur la couche MJ).</li>
    <li><strong>Déposer</strong> : un fichier de Windows, une image d'une fiche ou d'un journal ouvert, une page image, un objet ; Maj + glisser un acteur pour son portrait.</li>
    <li><strong>Image</strong> : clic pour la prendre, poignées pour la taille, Maj + molette pour la tourner, clic droit pour ses boutons (couche, verrou, en grand, groupe).</li>
    <li><strong>Joueurs</strong> : ils déplacent les images de la couche Joueurs (un MJ doit être connecté) ; celles de la couche MJ montrées (œil) restent fixes pour eux.</li>
  </ul>
  <table class="tableau__keys">
    <tr><td>Maj+1 / 2 / 3</td><td>Couche Fond / Joueurs / MJ</td></tr>
    <tr><td>Maj+F / J / M</td><td>Envoyer la sélection vers Fond / Joueurs / MJ</td></tr>
    <tr><td>Maj+H</td><td>Montrer / cacher</td></tr>
    <tr><td>Maj+L</td><td>Verrouiller / déverrouiller</td></tr>
    <tr><td>Maj+G</td><td>Grouper</td></tr>
    <tr><td>Maj+V</td><td>Montrer en grand</td></tr>
    <tr><td>Maj+B</td><td>Ce panneau</td></tr>
  </table>`;

class TableauPanel extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: APP_ID,
    tag: "div",
    classes: ["tableau-de-jeu"],
    window: { title: "Tableau de jeu", icon: "fa-solid fa-chalkboard", resizable: true },
    position: { width: 360, height: "auto", top: 80, left: 120 }
  };

  static open() {
    const app = foundry.applications.instances?.get(APP_ID) ?? new TableauPanel();
    return app.render({ force: true });
  }

  constructor(options) {
    super(options);
    // « state » est réservé par ApplicationV2 : nom propre au module.
    this.tbView = { tab: "couche", help: false, newScene: "Tableau", prepared: "" };
  }

  async _renderHTML() {
    const scene = canvas.scene;
    const div = document.createElement("div");
    div.className = "tableau__body";
    if (!scene) {
      div.innerHTML = "<p>Aucune scène affichée.</p>";
      return div;
    }
    const v = this.tbView;
    const tab = (key, icon, label) => `<a class="tableau__tab ${v.tab === key ? "active" : ""}" data-tab="${key}"><i class="${icon}"></i> ${label}</a>`;
    div.innerHTML = `
      <nav class="tableau__tabs">
        ${tab("couche", "fa-solid fa-layer-group", "Couche")}
        ${tab("groupes", "fa-solid fa-object-group", "Groupes")}
        ${tab("scenes", "fa-solid fa-map", "Scènes")}
        <a class="tableau__help-toggle ${v.help ? "active" : ""}" data-do="help" data-tooltip="Aide : gestes et raccourcis"><i class="fa-solid fa-circle-question"></i></a>
      </nav>
      ${v.help ? `<section class="tableau__help">${HELP}</section>` : ""}
      ${v.tab === "couche" ? this.coucheTab(scene) : v.tab === "groupes" ? this.groupsTab(scene) : this.scenesTab(scene)}`;
    return div;
  }

  coucheTab(scene) {
    const current = activeCouche();
    const tiles = scene.tiles.filter((t) => layerOf(t) === current);
    const visible = tiles.filter((t) => !t.hidden).length;
    const locked = tiles.filter((t) => t.locked).length;
    const sel = selection();
    const btn = (action, icon, label, attrs = "") => `<button type="button" data-do="${action}" ${attrs}><i class="${icon}"></i> ${label}</button>`;
    const others = LAYER_ORDER.filter((k) => k !== current);
    return `
      <section>
        <div class="tableau__segmented">
          ${LAYER_ORDER.map((k) => `<button type="button" data-couche="${k}" class="${k === current ? "active" : ""}" style="--c: ${COUCHE_COLORS[k]}"><i class="${LAYERS[k].icon}"></i> ${LAYERS[k].label}</button>`).join("")}
        </div>
        <p class="tableau__status" style="--c: ${COUCHE_COLORS[current]}">
          <strong>${LAYERS[current].label}</strong> · ${tiles.length} image${tiles.length > 1 ? "s" : ""}
          ${current === "mj" ? ` · ${visible} visible${visible > 1 ? "s" : ""} des joueurs` : ""}${locked ? ` · ${locked} verrouillée${locked > 1 ? "s" : ""}` : ""}
        </p>
        <div class="tableau__row">
          ${current === "mj" ? btn("show-couche", "fa-solid fa-eye", "Tout montrer") + btn("hide-couche", "fa-solid fa-eye-slash", "Tout cacher") : ""}
          ${locked ? btn("unlock-couche", "fa-solid fa-lock-open", "Tout déverrouiller") : ""}
          ${btn("clear-couche", "fa-solid fa-broom", "Vider la couche", tiles.length ? "" : "disabled")}
        </div>
      </section>
      <section>
        <h3>Sélection${sel.length ? ` : ${sel.length}` : ""}</h3>
        ${sel.length ? `
          <div class="tableau__row">
            ${others.map((k) => btn(`to-${k}`, "fa-solid fa-arrow-right", LAYERS[k].label)).join("")}
          </div>
          <div class="tableau__row">
            ${btn("lock", sel.every((d) => d.locked) ? "fa-solid fa-lock-open" : "fa-solid fa-lock", sel.every((d) => d.locked) ? "Déverrouiller" : "Verrouiller")}
            ${current !== "fond" || sel.some((d) => d.documentName !== "Tile") ? btn("hide", "fa-solid fa-eye-slash", sel.every((d) => d.hidden) ? "Montrer" : "Cacher") : ""}
            ${sel.length === 1 && sel[0].texture?.src ? btn("show-large", "fa-solid fa-expand", "En grand") : ""}
          </div>
          <div class="tableau__row">
            ${sel.length > 1 ? btn("group", "fa-solid fa-object-group", "Grouper") : ""}
            ${sel.some((d) => flagOf(d).group) ? btn("ungroup", "fa-solid fa-object-ungroup", "Dégrouper") : ""}
          </div>`
        : `<p class="tableau__hint">Cliquez une image de la couche ${LAYERS[current].label} (ou tracez un cadre) pour agir dessus.</p>`}
      </section>`;
  }

  groupsTab(scene) {
    const names = scene.flags?.[MODULE]?.groups ?? {};
    const groups = new Map();
    for (const type of GROUPABLE) for (const d of scene.getEmbeddedCollection(type)) {
      const g = flagOf(d).group;
      if (g) groups.set(g, (groups.get(g) ?? 0) + 1);
    }
    const sel = selection();
    const btn = (action, icon, label, attrs = "") => `<button type="button" data-do="${action}" ${attrs}><i class="${icon}"></i> ${label}</button>`;
    return `
      <section>
        <div class="tableau__row">
          ${btn("group", "fa-solid fa-object-group", `Grouper la sélection${sel.length ? ` (${sel.length})` : ""}`, sel.length > 1 ? "" : "disabled")}
          ${btn("ungroup", "fa-solid fa-object-ungroup", "Dégrouper", sel.some((d) => flagOf(d).group) ? "" : "disabled")}
        </div>
        ${groups.size ? `<ul class="tableau__groups">${[...groups].map(([id, n]) => `
          <li>
            <span>${escapeHtml(names[id] ?? "Groupe")} <small>(${n})</small></span>
            <span class="tableau__icons">
              <a data-do="g-add" data-group="${id}" data-tooltip="Ajouter la sélection (autre couche ou dessins compris)"><i class="fa-solid fa-plus"></i></a>
              <a data-do="g-lock" data-group="${id}" data-tooltip="Verrouiller / déverrouiller"><i class="fa-solid fa-lock"></i></a>
              <a data-do="g-hide" data-group="${id}" data-tooltip="Montrer / cacher"><i class="fa-solid fa-eye-slash"></i></a>
              <a data-do="g-rename" data-group="${id}" data-tooltip="Renommer"><i class="fa-solid fa-pen"></i></a>
              <a data-do="g-dissolve" data-group="${id}" data-tooltip="Défaire le groupe"><i class="fa-solid fa-xmark"></i></a>
            </span>
          </li>`).join("")}</ul>`
        : `<p class="tableau__hint">Aucun groupe. Sélectionnez au moins deux éléments puis « Grouper » ; ils bougeront, se verrouilleront et se montreront ensemble.</p>`}
      </section>`;
  }

  scenesTab(scene) {
    const v = this.tbView;
    const active = game.scenes.active;
    const scenes = game.scenes.filter((s) => s.id !== scene.id).sort((a, b) => a.name.localeCompare(b.name));
    const btn = (action, icon, label, attrs = "") => `<button type="button" data-do="${action}" ${attrs}><i class="${icon}"></i> ${label}</button>`;
    return `
      <section>
        <p class="tableau__status">Vous : <strong>${escapeHtml(scene.name)}</strong> · joueurs : <strong>${escapeHtml(active?.name ?? "aucune")}</strong></p>
        ${active?.id === scene.id ? "" : `<div class="tableau__row">${btn("activate-here", "fa-solid fa-bullseye", "Amener le groupe ici")}</div>`}
      </section>
      <section>
        <h3>Scène suivante</h3>
        <div class="tableau__row">
          <select name="prepared" aria-label="Scène suivante">
            <option value="">Choisir…</option>
            ${scenes.map((s) => `<option value="${s.id}" ${s.id === v.prepared ? "selected" : ""}>${escapeHtml(s.name)}${s.active ? " (joueurs)" : ""}</option>`).join("")}
          </select>
        </div>
        <div class="tableau__row">
          ${btn("prepare", "fa-solid fa-hourglass-half", "Préparer", v.prepared ? "" : "disabled")}
          ${btn("switch", "fa-solid fa-person-walking-arrow-right", "Basculer le groupe", v.prepared ? "" : "disabled")}
        </div>
        <p class="tableau__hint">Préparer : vous y allez seul, elle se précharge chez les joueurs. Basculer : tout le monde y passe.</p>
      </section>
      <section>
        <h3>Nouvelle scène tableau</h3>
        <div class="tableau__row">
          <input type="text" name="newScene" value="${escapeHtml(v.newScene)}" aria-label="Nom de la scène">
          ${btn("new-scene", "fa-solid fa-plus", "Créer")}
        </div>
      </section>`;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  _onRender() {
    const run = (fn) => Promise.resolve(fn()).catch((err) => {
      console.error(`${MODULE} |`, err);
      notify(err.message ?? String(err), "error");
    });
    for (const el of this.element.querySelectorAll("[data-do]")) {
      el.addEventListener("click", (event) => {
        event.preventDefault();
        run(() => this.run(el.dataset.do, el.dataset.group));
      });
    }
    for (const el of this.element.querySelectorAll("[data-tab]")) {
      el.addEventListener("click", (event) => {
        event.preventDefault();
        this.tbView.tab = el.dataset.tab;
        this.render();
      });
    }
    for (const el of this.element.querySelectorAll("[data-couche]")) {
      el.addEventListener("click", (event) => {
        event.preventDefault();
        run(() => setCouche(el.dataset.couche));
      });
    }
    this.element.querySelector('[name="newScene"]')?.addEventListener("input", (e) => { this.tbView.newScene = e.target.value; });
    this.element.querySelector('[name="prepared"]')?.addEventListener("change", (e) => { this.tbView.prepared = e.target.value; this.render(); });
  }

  async run(action, group) {
    const scene = canvas.scene;
    const sel = selection();
    const current = activeCouche();
    const coucheTiles = () => scene.tiles.filter((t) => layerOf(t) === current);
    switch (action) {
      case "help": this.tbView.help = !this.tbView.help; return this.render();
      case "show-couche": return updateMany(coucheTiles(), { hidden: false });
      case "hide-couche": return updateMany(coucheTiles(), { hidden: true });
      case "unlock-couche": return updateMany(coucheTiles().filter((t) => t.locked), { locked: false });
      case "clear-couche": {
        const ids = coucheTiles().map((t) => t.id);
        if (!ids.length) return;
        const ok = await DialogV2().confirm({ window: { title: `Vider la couche ${LAYERS[current].label}` },
          content: `<p>Retirer les ${ids.length} image(s) de la couche ${LAYERS[current].label} de « ${escapeHtml(scene.name)} » ? Les fichiers restent sur le serveur.</p>` });
        if (ok) await scene.deleteEmbeddedDocuments("Tile", ids);
        return;
      }
      case "to-fond": case "to-joueurs": case "to-mj": return moveToLayer(sel, action.slice(3));
      case "lock": return toggleLock(sel);
      case "hide": return toggleHidden(sel);
      case "show-large": return showLarge(sel[0]);
      case "group": return groupSelection(sel);
      case "ungroup": return ungroup(sel);
      case "g-add":
        if (!sel.length) return notify("Sélectionnez d'abord ce qu'il faut ajouter au groupe.", "warn");
        return groupSelection(sel, group);
      case "g-lock": return toggleLock(groupMembers(scene, group));
      case "g-hide": return toggleHidden(groupMembers(scene, group));
      case "g-rename": {
        const name0 = scene.flags?.[MODULE]?.groups?.[group] ?? "Groupe";
        const name = await DialogV2().prompt({
          window: { title: "Renommer le groupe" },
          content: `<input type="text" name="name" value="${escapeHtml(name0)}" autofocus>`,
          ok: { callback: (event, button) => button.form.elements.name.value }
        });
        if (name?.trim()) await scene.update({ [`flags.${MODULE}.groups.${group}`]: name.trim() });
        return;
      }
      case "g-dissolve": return dissolveGroup(scene, group);
      case "new-scene": return createBoardScene(this.tbView.newScene);
      case "prepare": {
        const next = game.scenes.get(this.tbView.prepared);
        if (!next) return notify("Choisissez la scène suivante.", "warn");
        await game.scenes.preload(next.id, isV14() ? { broadcast: true } : true);
        await next.view();
        return notify(`« ${next.name} » préparée : vous seul la voyez, elle est préchargée chez les joueurs.`);
      }
      case "switch": {
        const next = game.scenes.get(this.tbView.prepared);
        if (!next) return notify("Choisissez la scène suivante.", "warn");
        await next.activate();
        this.tbView.prepared = "";
        return notify(`Le groupe passe sur « ${next.name} ».`);
      }
      case "activate-here": return scene.activate();
    }
  }
}

const BOARD_COLOR = "#2e3138";

async function createBoardScene(name) {
  const v14 = isV14();
  const fogModes = CONST.FOG_EXPLORATION_MODES;
  const scene = await Scene.implementation.create({
    name: (name || "Tableau").trim(),
    width: 4000, height: 2500, padding: 0,
    grid: { type: CONST.GRID_TYPES.GRIDLESS, size: 100 },
    tokenVision: false,
    fog: v14 && fogModes ? { mode: fogModes.DISABLED } : { exploration: false },
    ...(v14 ? {} : { backgroundColor: BOARD_COLOR }),
    environment: { globalLight: { enabled: true } },
    navigation: true,
    flags: { [MODULE]: { board: true } }
  });
  // Foundry 14 : la couleur de fond appartient au niveau de la scène.
  if (v14) {
    try {
      const level = scene.initialLevel ?? scene.firstLevel ?? scene.levels?.contents?.[0];
      if (level) await level.update({ "background.color": BOARD_COLOR });
    } catch (err) { console.warn(`${MODULE} | couleur de fond`, err); }
  }
  await scene.view();
  notify(`Scène « ${scene.name} » créée : sans grille ni brouillard. Déposez-y vos images.`);
  return scene;
}

/* ---------------------------------------------------------------------------------------------- */
/* Rafraîchissement du panneau                                                                     */
/* ---------------------------------------------------------------------------------------------- */

let refreshTimer = null;
function refreshPanel() {
  const app = foundry.applications.instances?.get(APP_ID);
  if (!app?.rendered) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    // Pas pendant une saisie (nom de scène, choix de la scène suivante) : le champ perdrait le focus.
    if (app.element?.contains(document.activeElement) && document.activeElement.matches("input, select")) return;
    app.render();
  }, 150);
}

/* ---------------------------------------------------------------------------------------------- */
/* Initialisation                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

function keybinding(name, title, key, onDown) {
  game.keybindings.register(MODULE, name, {
    name: title,
    editable: [{ key, modifiers: ["Shift"] }],
    restricted: true,
    onDown: () => {
      if (!canvas?.ready) return false;
      Promise.resolve(onDown()).catch((err) => notify(err.message ?? String(err), "error"));
      return true;
    }
  });
}

Hooks.once("init", () => {
  game.settings.register(MODULE, "couche", { scope: "client", config: false, type: String, default: "mj",
    onChange: () => applyCouche() });
  game.settings.register(MODULE, "frame", { name: "Liseré de la couche active", hint: "Fin cadre coloré autour de la scène (gris Fond, vert Joueurs, rouge MJ).",
    scope: "client", config: true, type: Boolean, default: true, onChange: () => renderCoucheBar() });
  game.settings.register(MODULE, "badge", { name: "Pastille au survol des images", hint: "Couche, visibilité et verrou de l'image sous le pointeur.",
    scope: "client", config: true, type: Boolean, default: true });
  game.settings.register(MODULE, "migrated12", { scope: "world", config: false, type: Boolean, default: false });
  keybinding("couche-fond", "Couche active : Fond", "Digit1", () => setCouche("fond"));
  keybinding("couche-joueurs", "Couche active : Joueurs", "Digit2", () => setCouche("joueurs"));
  keybinding("couche-mj", "Couche active : MJ", "Digit3", () => setCouche("mj"));
  keybinding("panel", "Ouvrir le panneau Tableau de jeu", "KeyB", () => TableauPanel.open());
  keybinding("to-fond", "Sélection vers le calque Fond", "KeyF", () => moveToLayer(selection(), "fond"));
  keybinding("to-joueurs", "Sélection vers le calque Joueurs", "KeyJ", () => moveToLayer(selection(), "joueurs"));
  keybinding("to-mj", "Sélection vers le calque MJ", "KeyM", () => moveToLayer(selection(), "mj"));
  keybinding("lock", "Verrouiller / déverrouiller la sélection", "KeyL", () => toggleLock(selection()));
  keybinding("hide", "Montrer / cacher la sélection", "KeyH", () => toggleHidden(selection()));
  keybinding("group", "Grouper la sélection", "KeyG", () => groupSelection(selection()));
  keybinding("show", "Montrer en grand l'image sélectionnée", "KeyV", () => showLarge(selection()[0]));
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const tool = {
    name: "tableau-de-jeu",
    title: "Tableau de jeu (Maj+B)",
    icon: "fa-solid fa-chalkboard",
    order: 100,
    button: true,
    visible: true,
    onChange: () => TableauPanel.open()
  };
  // Foundry 13 et 14 : contrôles indexés par nom (jetons et tuiles) ; ancien format en tableau.
  const groups = Array.isArray(controls)
    ? controls.filter((c) => c.name === "token" || c.name === "tiles")
    : [controls.tokens ?? controls.token, controls.tiles].filter(Boolean);
  for (const group of groups) {
    if (Array.isArray(group.tools)) group.tools.push({ ...tool, onClick: tool.onChange });
    else group.tools[tool.name] = tool;
  }
});

Hooks.once("ready", () => {
  window.addEventListener("drop", onNativeDrop, true);
  window.addEventListener("pointerdown", onWindowImagePointerDown, true);
  window.addEventListener("dragstart", onWindowImageDragStart, true);
  window.addEventListener("pointerdown", onPlayerPointerDown, true);
  window.addEventListener("pointerdown", onGMPointerDown, true);
  game.socket.on(SOCKET, onSocket);
  window.addEventListener("pointermove", onHoverMove, true);
  convertLegacyTokens().catch((err) => console.error(`${MODULE} | conversion des jetons`, err));
  unlockLegacyFond().catch((err) => console.error(`${MODULE} | déverrouillage du Fond`, err));
  renderCoucheBar();
  const module = game.modules.get(MODULE);
  if (module) module.api = { open: () => TableauPanel.open(), placeImage, moveToLayer, toggleLock, toggleHidden, groupSelection, ungroup, createBoardScene };
});

Hooks.on("dropCanvasData", onDropCanvasData);
Hooks.on("refreshTile", applyTileCouche);
Hooks.on("drawTile", applyTileCouche);
Hooks.on("controlTile", onControlTile);
Hooks.on("canvasReady", () => applyCouche());
Hooks.on("activateTilesLayer", () => applyCouche());
Hooks.on("activateTokenLayer", () => applyCouche());
Hooks.on("renderTileHUD", onRenderHUD);
Hooks.on("renderDrawingHUD", onRenderHUD);

for (const type of GROUPABLE) {
  Hooks.on(`preUpdate${type}`, onPreUpdate);
  Hooks.on(`update${type}`, onUpdate);
  for (const event of ["create", "update", "delete"]) Hooks.on(`${event}${type}`, refreshPanel);
}
for (const event of ["controlTile", "controlDrawing", "canvasReady", "updateScene"]) Hooks.on(event, refreshPanel);
