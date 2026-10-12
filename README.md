# Tableau de jeu

Module pour Foundry VTT 13 et 14 : utiliser Foundry comme un tableau blanc, à la Roll20. Pour les tables qui montrent des images, gèrent fiches et journaux et lancent des dés, plus que des donjons en vision dynamique.

Installation : Modules complémentaires > Installer un module > manifeste :

    https://github.com/ranglier/foundry-board/releases/latest/download/module.json

## Ce que fait le module (pour le MJ)

- **Couche active, comme dans Roll20** : barre en haut de la scène (Fond / Joueurs / MJ, Maj+1 / 2 / 3) et liseré de couleur autour de la scène (gris, vert, rouge). Seuls les images et dessins de la couche active se prennent ; les autres laissent passer le clic. Au survol, une pastille indique la couche d'une image ou d'un dessin, s'il est caché, verrouillé ou groupé.
- **Glisser-déposer d'images sur la scène**, sur la couche active (cachée aux joueurs si c'est la couche MJ), depuis :
  - un fichier de l'ordinateur (plusieurs à la fois ; envoyés dans `worlds/<monde>/tableau/`) ;
  - toute image d'une fenêtre ouverte : portrait d'une fiche de personnage ou de PNJ, image d'une page de journal, image dans le texte d'un journal (glisser l'image elle-même, pas la fenêtre) ;
  - une page image depuis le sommaire d'un journal, un objet, ou un acteur de la barre latérale avec **Maj** (son portrait ; sans Maj, c'est un jeton, comme d'habitude).
- **Trois couches**, toutes faites de tuiles (poignées de redimensionnement, Maj + molette pour tourner, pas de règle de mouvement) :
  - **Fond** : sous les autres images ;
  - **Joueurs** : visible, déplaçable par les joueurs (un simple glisser, même jeu en pause) ;
  - **MJ** : invisible des joueurs, ou visible sans pouvoir être déplacée (œil).
- **Dessins et formes** (outil Dessins de Foundry : main levée, rectangle, ellipse, polygone, texte) rangés dans les mêmes couches : un dessin tracé arrive sur la couche active (caché sur la couche MJ). Ensuite, un clic sur un dessin de la couche active le prend, quel que soit l'outil sélectionné (Tuiles, Jetons ou Dessins en mode sélection) : le module bascule de lui-même sur le bon outil. Un dessin passe au-dessus des images pour le clic. Les dessins faits avant la 1.3 sont sur la couche Joueurs s'ils sont visibles, MJ s'ils sont cachés (Maj+M / Maj+F pour les ranger).
- **Clic droit sur une image ou un dessin** : l'envoyer sur une autre couche, la montrer en grand aux joueurs, la verrouiller, la grouper.
- **Verrou** sur les images et dessins : plus rien ne bouge par accident, même pour le MJ.
- **Groupes** d'images, de dessins et de formes : ils bougent, se verrouillent, se montrent et se cachent ensemble. Pour mêler des couches : grouper sur une couche, passer sur l'autre, sélectionner et « + » sur le groupe.
- **Panneau « Tableau de jeu »** (Maj+B, bouton de la barre) en trois onglets :
  - **Couche** : couche active et son contenu, tout montrer / cacher, tout déverrouiller, vider la couche, actions sur la sélection ;
  - **Groupes** : liste, ajout, verrou, visibilité, renommage ;
  - **Scènes** : où vous êtes et où sont les joueurs, préparer la scène suivante (préchargée chez eux, vue de vous seul) puis y basculer le groupe, nouvelle scène tableau (sans grille ni brouillard).
  - Bouton **?** : gestes et raccourcis.

## Raccourcis (modifiables dans Configurer les contrôles)

| Raccourci | Action |
|---|---|
| Maj+1 / Maj+2 / Maj+3 | Couche active : Fond / Joueurs / MJ |
| Maj+F / Maj+J / Maj+M | Envoyer la sélection vers Fond / Joueurs / MJ |
| Maj+H | Montrer / cacher |
| Maj+L | Verrouiller / déverrouiller |
| Maj+G | Grouper la sélection |
| Maj+V | Montrer en grand l'image sélectionnée |
| Maj+B | Panneau Tableau de jeu |

Réglages (Paramètres du jeu > Tableau de jeu) : liseré de la couche active, pastille au survol.

## Fonctionnement

Foundry ne laisse que le MJ modifier une tuile ou un dessin qui n'est pas le sien. Pour la couche Joueurs, le module gère le glisser chez le joueur (aperçu immédiat) et demande le déplacement au MJ connecté par le canal du module ; le MJ vérifie que l'image ou le dessin est bien sur la couche Joueurs, visible et non verrouillée, puis l'applique (le groupe suit). Un MJ doit donc être en ligne.

La version 1.1 verrouillait les images envoyées sur le Fond : la 1.2 les déverrouille une fois (la couche active suffit à les protéger). La version 1.0 posait des jetons rattachés à deux acteurs « Tableau - Joueurs » et « Tableau - MJ » : au premier lancement de la 1.1, le MJ les convertit en tuiles dans toutes les scènes. Ces deux acteurs (dossier d'acteurs « Tableau de jeu ») peuvent ensuite être supprimés.

## Limites connues

- Un acteur glissé sans Maj crée un jeton de personnage, comme d'habitude (Alt : jeton caché) ; une page de texte glissée crée une note ; un objet lâché sur un jeton est laissé au système.
- Les joueurs déplacent les images et dessins de la couche Joueurs ; un dessin tracé par un joueur arrive sur la couche Joueurs ; ils ne les redimensionnent ni ne les tournent. Leur personnage, s'il est sous le pointeur, reste prioritaire.
- Maj+F pendant le glisser d'un jeton reste le « point de passage non aimanté » de Foundry : le raccourci Fond ne joue qu'en dehors d'un glisser.
- Pour développer : le dossier du module doit s'appeler `tableau-de-jeu` (identifiant du module), pas `foundry-board`.
- Seul le MJ pose des images.
- Sélection de plusieurs éléments au cadre : outil Tuiles pour les images, outil Dessins pour les dessins (Foundry ne mélange pas les deux) ; pour agir sur les deux à la fois, les grouper.
