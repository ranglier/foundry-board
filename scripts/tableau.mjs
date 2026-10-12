/**
 * Tableau de jeu - Foundry VTT 13 et 14.
 *
 * Foundry utilisé comme un tableau blanc, à la Roll20 :
 *  - glisser-déposer d'images sur la scène : pages image et images des journaux, portraits des fiches
 *    (glisser le portrait, ou Maj + glisser l'acteur), images des objets, fichiers de l'ordinateur ;
 *  - trois calques : Fond (tuile, sous tout le reste), Joueurs (jeton d'image que les joueurs peuvent
 *    déplacer), MJ (jeton d'image du MJ, caché ou visible des joueurs mais pas déplaçable par eux) ;
 *  - verrou par image (et par dessin), « Montrer en grand », groupes d'images, de dessins et de formes ;
 *  - scène « tableau » vierge, nettoyage d'un calque, préparation et bascule de scène.
 *
 * Calques Joueurs et MJ : des jetons, car Foundry ne laisse que le MJ déplacer une tuile alors qu'un joueur
 * déplace les jetons dont il est propriétaire. Ces jetons appartiennent à deux acteurs créés par le module,
 * « Tableau - Joueurs » (propriété de tous) et « Tableau - MJ » (MJ seul), sans vision, nom ni barres.
 *
 * Données : `flags.tableau-de-jeu` = { layer: "fond" | "joueurs" | "mj", group?: identifiant } sur les
 * tuiles, jetons et dessins ; { board: "joueurs" | "mj" } sur les deux acteurs ; { board: true } sur les
 * scènes tableau ; noms des groupes dans `flags.tableau-de-jeu.groups` de la scène.
 */

const MODULE = "tableau-de-jeu";
const APP_ID = "tableau-de-jeu-panel";
const LAYERS = {
  fond: { label: "Fond", icon: "fa-solid fa-image", hint: "sous tout le reste, MJ seul" },
  joueurs: { label: "Joueurs", icon: "fa-solid fa-users", hint: "visible, déplaçable par les joueurs" },
  mj: { label: "MJ", icon: "fa-solid fa-user-secret", hint: "MJ seul, ou visible sans être déplaçable" }
};
const LAYER_ORDER = ["fond", "joueurs", "mj"];
const GROUPABLE = ["Token", "Tile", "Drawing"];
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

/** Calque d'un document de la scène (tuile : Fond par défaut ; jeton : seulement ceux du module). */
function layerOf(doc) {
  const layer = flagOf(doc).layer;
  if (LAYERS[layer]) return layer;
  if (doc.documentName === "Tile") return "fond";
  if (doc.documentName === "Token") {
    const board = flagOf(doc.actor).board;
    return LAYERS[board] ? board : null;
  }
  return null;
}

/** Image et géométrie (pixels) d'une tuile ou d'un jeton d'image. */
function geometry(doc) {
  const grid = doc.parent?.grid?.size ?? canvas.dimensions?.size ?? 100;
  const isToken = doc.documentName === "Token";
  return {
    src: doc.texture?.src ?? "",
    name: doc.name || flagOf(doc).name || "",
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
/* Acteurs porteurs des jetons d'image                                                             */
/* ---------------------------------------------------------------------------------------------- */

const boardActors = {};

function actorType() {
  const types = (game.documentTypes?.Actor ?? Object.keys(CONFIG.Actor.typeLabels ?? {})).filter((t) => t !== "base");
  return types.includes("npc") ? "npc" : types[0] ?? "base";
}

async function boardActor(kind) {
  const cached = boardActors[kind];
  if (cached && game.actors.has(cached.id)) return cached;
  let actor = game.actors.find((a) => flagOf(a).board === kind);
  if (!actor) {
    if (!game.user.isGM) throw new Error("Seul le MJ peut préparer le tableau.");
    let folder = game.folders.find((f) => f.type === "Actor" && flagOf(f).board === "folder");
    folder ??= await Folder.implementation.create({ name: "Tableau de jeu", type: "Actor", sorting: "a",
      flags: { [MODULE]: { board: "folder" } } });
    const levels = CONST.DOCUMENT_OWNERSHIP_LEVELS;
    actor = await Actor.implementation.create({
      name: kind === "joueurs" ? "Tableau - Joueurs" : "Tableau - MJ",
      type: actorType(),
      img: kind === "joueurs" ? "icons/svg/card-hand.svg" : "icons/svg/eye.svg",
      folder: folder.id,
      ownership: { default: kind === "joueurs" ? levels.OWNER : levels.NONE },
      prototypeToken: { actorLink: false, sight: { enabled: false } },
      flags: { [MODULE]: { board: kind } }
    });
  }
  boardActors[kind] = actor;
  return actor;
}

/* ---------------------------------------------------------------------------------------------- */
/* Création et changement de calque                                                                */
/* ---------------------------------------------------------------------------------------------- */

/** Données d'une tuile ou d'un jeton pour un calque, à partir d'une géométrie. */
async function layerData(layer, g) {
  const flags = { [MODULE]: { layer, ...(g.group ? { group: g.group } : {}), ...(g.name ? { name: g.name } : {}) } };
  const level = g.level ?? currentLevel();
  if (layer === "fond") {
    return { type: "Tile", data: {
      texture: { src: g.src }, x: g.x, y: g.y, width: g.w, height: g.h, rotation: g.rotation,
      locked: g.locked, hidden: false, flags,
      ...(level && TileDocument.schema?.fields?.levels ? { levels: [level] } : {})
    } };
  }
  const actor = await boardActor(layer);
  const grid = canvas.scene?.grid?.size ?? canvas.dimensions.size;
  const displayModes = CONST.TOKEN_DISPLAY_MODES;
  const token = await actor.getTokenDocument({
    name: g.name || baseName(g.src) || "Image",
    texture: { src: g.src, fit: "contain" },
    x: g.x, y: g.y, width: g.w / grid, height: g.h / grid, rotation: g.rotation,
    locked: g.locked, hidden: layer === "mj" ? g.hidden : false,
    actorLink: false, displayName: displayModes.NONE, displayBars: displayModes.NONE,
    disposition: CONST.TOKEN_DISPOSITIONS.SECRET ?? CONST.TOKEN_DISPOSITIONS.NEUTRAL,
    sight: { enabled: false }, ring: { enabled: false }, lockRotation: false,
    ...(level && TokenDocument.schema?.fields?.level ? { level } : {}),
    // Systèmes qui recalent la taille d'un jeton sur celle de la créature (pf2e) : désactivé.
    flags: { ...flags, ...(game.system.id === "pf2e" ? { pf2e: { linkToActorSize: false, autoscale: false } } : {}) }
  });
  return { type: "Token", data: token.toObject() };
}

/** Pose une image sur la scène en cours, centrée sur (x, y) : calque MJ, cachée. */
async function placeImage({ src, name, x, y, layer = "mj" }) {
  const scene = canvas.scene;
  if (!scene || !src) return;
  if (!game.user.isGM) return notify("Seul le MJ peut poser des images sur la scène.", "warn");
  const { w, h } = fitSize(await naturalSize(src));
  const g = { src, name: name || baseName(src), x: Math.round(x - w / 2), y: Math.round(y - h / 2), w, h,
    rotation: 0, locked: false, hidden: true, group: null, level: currentLevel() };
  const { type, data } = await layerData(layer, g);
  const [doc] = await scene.createEmbeddedDocuments(type, [data]);
  notify(`« ${g.name} » posée sur le calque ${LAYERS[layer].label}${layer === "mj" ? " (cachée)" : ""}.`);
  return doc;
}

/** Fait passer des tuiles et jetons d'image sur un autre calque (position, taille, rotation, groupe gardés). */
async function moveToLayer(docs, layer) {
  if (!game.user.isGM) return;
  const items = docs.filter((d) => layerOf(d) && layerOf(d) !== layer && d.texture?.src);
  if (!items.length) return;
  const byScene = new Map();
  for (const doc of items) {
    const scene = doc.parent;
    if (!byScene.has(scene)) byScene.set(scene, { Tile: [], Token: [], remove: { Tile: [], Token: [] } });
    const g = geometry(doc);
    if (layer === "fond") g.locked = true;     // un fond ne doit pas bouger par accident
    if (layer === "mj") g.hidden = true;       // entrer sur le calque MJ : caché par défaut
    const { type, data } = await layerData(layer, g);
    const batch = byScene.get(scene);
    batch[type].push(data);
    batch.remove[doc.documentName].push(doc.id);
  }
  for (const [scene, batch] of byScene) {
    for (const type of ["Tile", "Token"]) if (batch[type].length) await scene.createEmbeddedDocuments(type, batch[type]);
    for (const type of ["Tile", "Token"]) if (batch.remove[type].length) await scene.deleteEmbeddedDocuments(type, batch.remove[type]);
  }
  notify(`${items.length} image(s) sur le calque ${LAYERS[layer].label}.`);
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
  const all = withGroups(docs).filter((d) => d.documentName !== "Token" || layerOf(d) === "mj");
  if (!all.length) return notify("Seules les images du calque MJ (et les dessins, tuiles) se cachent ou s'affichent.", "warn");
  const hide = !all.every((d) => d.hidden);
  await updateMany(all, { hidden: hide });
  notify(hide ? "Caché aux joueurs." : "Visible des joueurs (sans pouvoir le déplacer).");
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
  options[MODULE] ??= { op: foundry.utils.randomID(), moved: [], deltas: {} };
  options[MODULE].moved.push(doc.id);
  options[MODULE].deltas[group] ??= { dx, dy };
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

/* Jetons : avec l'API de mouvement, un déplacement à la souris peut ne pas passer x / y dans preUpdate.
   Le hook moveToken (tous les clients) donne l'origine et la destination : le MJ actif l'utilise quand
   preUpdate n'a rien noté. Les jetons d'une même opération partagent l'objet `operation`. */
const pendingMoves = new WeakMap();

function onMoveToken(doc, movement, operation) {
  if (!isActiveGM() || !operation || operation[MODULE]) return;
  const group = flagOf(doc).group;
  if (!group || !movement?.origin || !movement?.destination) return;
  const dx = movement.destination.x - movement.origin.x;
  const dy = movement.destination.y - movement.origin.y;
  if (!dx && !dy) return;
  let batch = pendingMoves.get(operation);
  if (!batch) {
    batch = { moved: new Set(), deltas: {}, scene: doc.parent };
    pendingMoves.set(operation, batch);
    setTimeout(() => {
      for (const [g, d] of Object.entries(batch.deltas)) {
        const others = groupMembers(batch.scene, g).filter((m) => !batch.moved.has(m.id));
        if (others.length) updateMany(others, (m) => ({ x: m.x + d.dx, y: m.y + d.dy })).catch((err) => console.error(`${MODULE} |`, err));
      }
    }, 0);
  }
  batch.moved.add(doc.id);
  batch.deltas[group] ??= { dx, dy };
}

/* Jetons du tableau : un joueur peut les déplacer et les tourner, rien d'autre (ni image, ni verrou). */
// Champs de mouvement de Foundry (TokenDocument.MOVEMENT_FIELDS) et données internes du mouvement.
const PLAYER_TOKEN_FIELDS = new Set(["x", "y", "rotation", "elevation", "level", "width", "height", "depth", "shape",
  "_id", "sort", "_movementHistory", "_regions", "movementAction"]);

function guardPlayerTokenUpdate(doc, change, options) {
  if (game.user.isGM || !layerOf(doc)) return;
  const keys = Object.keys(foundry.utils.flattenObject(change)).map((k) => k.split(".")[0]);
  if (keys.some((k) => !PLAYER_TOKEN_FIELDS.has(k))) {
    notify("Les images du tableau se déplacent seulement : le reste est réservé au MJ.", "warn");
    return false;
  }
}

function guardPlayerTokenCreate(doc) {
  if (game.user.isGM) return;
  if (flagOf(doc.actor ?? game.actors.get(doc.actorId)).board) {
    notify("Seul le MJ pose des images sur le tableau.", "warn");
    return false;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Montrer en grand                                                                                */
/* ---------------------------------------------------------------------------------------------- */

function showLarge(doc) {
  const src = doc?.texture?.src;
  if (!src) return;
  const Popout = ImagePopoutClass();
  const title = doc.name || flagOf(doc).name || baseName(src) || "Image";
  // showTitle : les joueurs n'ont pas de droit sur le jeton, le titre serait masqué chez eux.
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

/** Dépôt du navigateur sur la scène : fichiers de l'ordinateur, <img> glissée d'un journal ou d'une fiche. */
function onNativeDrop(event) {
  const board = boardElement();
  if (!board || event.target !== board || !game.user.isGM || !canvas.scene) return;
  const dt = event.dataTransfer;
  if (!dt) return;
  const text = dt.getData("text/plain");
  if (text && text.trim().startsWith("{")) return;  // document de Foundry : laissé à dropCanvasData
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
  if (doc.documentName === "Token" && !isImage) return;  // jeton de personnage : rien à ajouter
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
  if (doc.documentName === "Token") {
    box.append(hudButton(doc.locked ? "fa-solid fa-lock" : "fa-solid fa-lock-open",
      doc.locked ? "Déverrouiller (avec son groupe)" : "Verrouiller (avec son groupe)", () => toggleLock(targets(doc)), doc.locked));
  }
  const group = flagOf(doc).group;
  box.append(group
    ? hudButton("fa-solid fa-object-ungroup", "Retirer du groupe", () => ungroup(targets(doc)), true)
    : hudButton("fa-solid fa-object-group", "Grouper la sélection", () => groupSelection(targets(doc))));
  column.append(box);
}

/* ---------------------------------------------------------------------------------------------- */
/* Panneau « Tableau de jeu »                                                                      */
/* ---------------------------------------------------------------------------------------------- */

const { ApplicationV2 } = foundry.applications.api;

class TableauPanel extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: APP_ID,
    tag: "div",
    classes: ["tableau-de-jeu"],
    window: { title: "Tableau de jeu", icon: "fa-solid fa-chalkboard", resizable: true },
    position: { width: 380, height: "auto", top: 80, left: 120 }
  };

  static open() {
    const app = foundry.applications.instances?.get(APP_ID) ?? new TableauPanel();
    return app.render({ force: true });
  }

  constructor(options) {
    super(options);
    // « state » est réservé par ApplicationV2 : nom propre au module.
    this.tbView = { newScene: "Tableau", prepared: "" };
  }

  async _renderHTML() {
    const scene = canvas.scene;
    const div = document.createElement("div");
    div.className = "tableau__body";
    if (!scene) {
      div.innerHTML = "<p>Aucune scène affichée.</p>";
      return div;
    }
    const counts = { fond: 0, joueurs: 0, mj: 0, mjVisible: 0 };
    for (const doc of [...scene.tiles, ...scene.tokens]) {
      const layer = layerOf(doc);
      if (!layer) continue;
      counts[layer] += 1;
      if (layer === "mj" && !doc.hidden) counts.mjVisible += 1;
    }
    const names = scene.flags?.[MODULE]?.groups ?? {};
    const groups = new Map();
    for (const type of GROUPABLE) for (const d of scene.getEmbeddedCollection(type)) {
      const g = flagOf(d).group;
      if (g) groups.set(g, (groups.get(g) ?? 0) + 1);
    }
    const sel = selection();
    const scenes = game.scenes.filter((s) => s.id !== scene.id).sort((a, b) => a.name.localeCompare(b.name));
    const active = game.scenes.active;
    const btn = (action, icon, label, extra = "") =>
      `<button type="button" data-do="${action}" ${extra}><i class="${icon}"></i> ${label}</button>`;
    div.innerHTML = `
      <section>
        <h3>Calques de « ${escapeHtml(scene.name)} »</h3>
        <ul class="tableau__layers">
          <li><i class="${LAYERS.fond.icon}"></i> Fond : ${counts.fond}</li>
          <li><i class="${LAYERS.joueurs.icon}"></i> Joueurs : ${counts.joueurs}</li>
          <li><i class="${LAYERS.mj.icon}"></i> MJ : ${counts.mj}${counts.mjVisible ? ` (${counts.mjVisible} visible${counts.mjVisible > 1 ? "s" : ""})` : ""}</li>
        </ul>
        <p class="tableau__hint">Déposez une image sur la scène : elle arrive sur le calque MJ, cachée. Clic droit sur une image pour la changer de calque, la verrouiller, la montrer en grand ou la grouper.</p>
        <div class="tableau__row">
          ${btn("show-mj", "fa-solid fa-eye", "Montrer le calque MJ")}
          ${btn("hide-mj", "fa-solid fa-eye-slash", "Cacher le calque MJ")}
        </div>
        <div class="tableau__row">
          ${btn("clear-joueurs", "fa-solid fa-broom", "Nettoyer Joueurs")}
          ${btn("clear-mj", "fa-solid fa-broom", "Nettoyer MJ")}
        </div>
      </section>
      <section>
        <h3>Sélection (${sel.length})</h3>
        <div class="tableau__row">
          ${LAYER_ORDER.map((k) => btn(`to-${k}`, LAYERS[k].icon, LAYERS[k].label, sel.length ? "" : "disabled")).join("")}
        </div>
        <div class="tableau__row">
          ${btn("lock", "fa-solid fa-lock", "Verrou", sel.length ? "" : "disabled")}
          ${btn("hide", "fa-solid fa-eye-slash", "Visibilité", sel.length ? "" : "disabled")}
          ${btn("show-large", "fa-solid fa-expand", "En grand", sel.length === 1 ? "" : "disabled")}
        </div>
      </section>
      <section>
        <h3>Groupes</h3>
        <div class="tableau__row">
          ${btn("group", "fa-solid fa-object-group", "Grouper la sélection", sel.length > 1 ? "" : "disabled")}
          ${btn("ungroup", "fa-solid fa-object-ungroup", "Dégrouper", sel.some((d) => flagOf(d).group) ? "" : "disabled")}
        </div>
        ${groups.size ? `<ul class="tableau__groups">${[...groups].map(([id, n]) => `
          <li>
            <span>${escapeHtml(names[id] ?? "Groupe")} <small>(${n})</small></span>
            <span class="tableau__icons">
              <a data-do="g-add" data-group="${id}" data-tooltip="Ajouter la sélection (autre calque compris)"><i class="fa-solid fa-plus"></i></a>
              <a data-do="g-lock" data-group="${id}" data-tooltip="Verrouiller / déverrouiller"><i class="fa-solid fa-lock"></i></a>
              <a data-do="g-hide" data-group="${id}" data-tooltip="Montrer / cacher"><i class="fa-solid fa-eye-slash"></i></a>
              <a data-do="g-rename" data-group="${id}" data-tooltip="Renommer"><i class="fa-solid fa-pen"></i></a>
              <a data-do="g-dissolve" data-group="${id}" data-tooltip="Défaire le groupe"><i class="fa-solid fa-xmark"></i></a>
            </span>
          </li>`).join("")}</ul>` : `<p class="tableau__hint">Sélectionnez des images, dessins ou formes puis « Grouper ». Pour mêler plusieurs calques : groupez sur l'un, puis sélectionnez sur l'autre et « + » sur le groupe.</p>`}
      </section>
      <section>
        <h3>Scènes</h3>
        <div class="tableau__row">
          <input type="text" name="newScene" value="${escapeHtml(this.tbView.newScene)}" aria-label="Nom de la scène">
          ${btn("new-scene", "fa-solid fa-chalkboard", "Nouvelle scène tableau")}
        </div>
        <p class="tableau__hint">Scène en cours pour les joueurs : <strong>${escapeHtml(active?.name ?? "aucune")}</strong>${active?.id === scene.id ? " (celle-ci)" : ""}.</p>
        <div class="tableau__row">
          <select name="prepared" aria-label="Scène suivante">
            <option value="">Scène suivante…</option>
            ${scenes.map((s) => `<option value="${s.id}" ${s.id === this.tbView.prepared ? "selected" : ""}>${escapeHtml(s.name)}${s.active ? " (active)" : ""}</option>`).join("")}
          </select>
        </div>
        <div class="tableau__row">
          ${btn("prepare", "fa-solid fa-hourglass-half", "Préparer")}
          ${btn("switch", "fa-solid fa-person-walking-arrow-right", "Basculer le groupe")}
        </div>
        <div class="tableau__row">
          ${active?.id === scene.id ? "" : btn("activate-here", "fa-solid fa-bullseye", "Amener le groupe ici")}
        </div>
      </section>`;
    return div;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  _onRender() {
    for (const el of this.element.querySelectorAll("[data-do]")) {
      el.addEventListener("click", (event) => {
        event.preventDefault();
        this.run(el.dataset.do, el.dataset.group).catch((err) => {
          console.error(`${MODULE} |`, err);
          notify(err.message ?? String(err), "error");
        });
      });
    }
    this.element.querySelector('[name="newScene"]')?.addEventListener("input", (e) => { this.tbView.newScene = e.target.value; });
    this.element.querySelector('[name="prepared"]')?.addEventListener("change", (e) => { this.tbView.prepared = e.target.value; });
  }

  async run(action, group) {
    const scene = canvas.scene;
    const sel = selection();
    const boardTokens = (kind) => scene.tokens.filter((t) => layerOf(t) === kind);
    switch (action) {
      case "show-mj": return updateMany(boardTokens("mj"), { hidden: false });
      case "hide-mj": return updateMany(boardTokens("mj"), { hidden: true });
      case "clear-joueurs":
      case "clear-mj": {
        const kind = action === "clear-mj" ? "mj" : "joueurs";
        const ids = boardTokens(kind).map((t) => t.id);
        if (!ids.length) return notify(`Calque ${LAYERS[kind].label} déjà vide.`);
        const ok = await DialogV2().confirm({ window: { title: `Nettoyer le calque ${LAYERS[kind].label}` },
          content: `<p>Retirer les ${ids.length} image(s) du calque ${LAYERS[kind].label} de « ${escapeHtml(scene.name)} » ? Les fichiers restent sur le serveur.</p>` });
        if (ok) await scene.deleteEmbeddedDocuments("Token", ids);
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
        const current = scene.flags?.[MODULE]?.groups?.[group] ?? "Groupe";
        const name = await DialogV2().prompt({
          window: { title: "Renommer le groupe" },
          content: `<input type="text" name="name" value="${escapeHtml(current)}" autofocus>`,
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
        const next = game.scenes.get(this.tbView.prepared) ?? (canvas.scene.active ? null : canvas.scene);
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
  // Foundry 13 et 14 : contrôles indexés par nom ; ancien format en tableau.
  const tokens = Array.isArray(controls) ? controls.find((c) => c.name === "token") : (controls.tokens ?? controls.token);
  if (!tokens) return;
  if (Array.isArray(tokens.tools)) tokens.tools.push({ ...tool, onClick: tool.onChange });
  else tokens.tools[tool.name] = tool;
});

Hooks.once("ready", () => {
  window.addEventListener("drop", onNativeDrop, true);
  const module = game.modules.get(MODULE);
  if (module) module.api = { open: () => TableauPanel.open(), placeImage, moveToLayer, toggleLock, toggleHidden, groupSelection, ungroup, createBoardScene };
});

Hooks.on("dropCanvasData", onDropCanvasData);
Hooks.on("moveToken", onMoveToken);
Hooks.on("preUpdateToken", guardPlayerTokenUpdate);
Hooks.on("preCreateToken", guardPlayerTokenCreate);
Hooks.on("renderTokenHUD", onRenderHUD);
Hooks.on("renderTileHUD", onRenderHUD);
Hooks.on("renderDrawingHUD", onRenderHUD);

for (const type of GROUPABLE) {
  Hooks.on(`preUpdate${type}`, onPreUpdate);
  Hooks.on(`update${type}`, onUpdate);
  for (const event of ["create", "update", "delete"]) Hooks.on(`${event}${type}`, refreshPanel);
}
for (const event of ["controlToken", "controlTile", "controlDrawing", "canvasReady", "updateScene"]) Hooks.on(event, refreshPanel);
