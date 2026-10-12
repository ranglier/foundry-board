# Tableau de jeu

Module pour Foundry VTT 13 et 14 : utiliser Foundry comme un tableau blanc, à la Roll20. Pour les tables qui montrent des images, gèrent fiches et journaux et lancent des dés, plus que des donjons en vision dynamique.

Installation : Modules complémentaires > Installer un module > manifeste :

    https://github.com/ranglier/foundry-board/releases/latest/download/module.json

## Ce que fait le module (pour le MJ)

- **Glisser-déposer d'images sur la scène**, depuis :
  - une page image d'un journal (depuis le sommaire du journal) ou une image dans le texte d'un journal ;
  - toute image d'une fenêtre ouverte : portrait d'une fiche de personnage ou de PNJ, image d'une page de journal, image dans le texte d'un journal (glisser l'image elle-même, pas la fenêtre) ;
  - un acteur de la barre latérale avec **Maj** enfoncée : son portrait (sans Maj, c'est un jeton, comme d'habitude) ;
  - un objet (glisser l'objet : son image est posée) ;
  - un fichier de l'ordinateur (envoyé dans `worlds/<monde>/tableau/`).
  L'image arrive **sur le calque MJ, cachée**, à l'endroit du dépôt.
- **Trois calques**, tous faits de tuiles (images libres : poignées de redimensionnement, Maj + molette pour tourner, pas de règle de mouvement) :
  - **Fond** : sous les autres images, verrouillée en y entrant ;
  - **Joueurs** : visible, déplaçable par les joueurs (un simple glisser, même jeu en pause) ;
  - **MJ** : invisible des joueurs, ou visible sans pouvoir être déplacée (œil).
- Les images se prennent avec l'**outil Tuiles** (barre de gauche), activé automatiquement après un dépôt.
- **Clic droit sur une image** : changer de calque, montrer en grand aux joueurs, verrouiller, grouper.
- **Verrou** sur les images, tuiles et dessins : plus rien ne bouge par accident, même pour le MJ.
- **Groupes** d'images, de dessins et de formes : ils bougent ensemble, se verrouillent, se montrent et se cachent ensemble. Pour mêler des calques : grouper sur un calque, puis sélectionner sur l'autre et « + » sur le groupe dans le panneau.
- **Panneau « Tableau de jeu »** (outil dans les contrôles des jetons, ou Maj+B) : compte des images par calque, montrer ou cacher tout le calque MJ, nettoyer le calque Joueurs ou MJ, actions sur la sélection, groupes, nouvelle scène tableau (sans grille ni brouillard), préparer la scène suivante (préchargée chez les joueurs, vue du MJ seul) puis y basculer le groupe.

## Raccourcis (modifiables dans Configurer les contrôles)

| Raccourci | Action |
|---|---|
| Maj+B | Panneau Tableau de jeu |
| Maj+F / Maj+J / Maj+M | Sélection vers Fond / Joueurs / MJ |
| Maj+H | Montrer / cacher (calque MJ, tuiles, dessins) |
| Maj+L | Verrouiller / déverrouiller |
| Maj+G | Grouper la sélection |
| Maj+V | Montrer en grand l'image sélectionnée |

## Fonctionnement

Foundry ne laisse que le MJ modifier une tuile. Pour le calque Joueurs, le module gère le glisser chez le joueur (aperçu immédiat) et demande le déplacement au MJ connecté par le canal du module ; le MJ vérifie que l'image est bien sur le calque Joueurs, visible et non verrouillée, puis l'applique (le groupe suit). Un MJ doit donc être en ligne.

La version 1.0 posait des jetons rattachés à deux acteurs « Tableau - Joueurs » et « Tableau - MJ » : au premier lancement de la 1.1, le MJ les convertit en tuiles dans toutes les scènes. Ces deux acteurs (dossier d'acteurs « Tableau de jeu ») peuvent ensuite être supprimés.

## Limites connues

- Un acteur glissé sans Maj crée un jeton de personnage, comme d'habitude (Alt : jeton caché) ; une page de texte glissée crée une note ; un objet lâché sur un jeton est laissé au système.
- Les joueurs déplacent les images du calque Joueurs ; ils ne les redimensionnent ni ne les tournent. Leur personnage, s'il est sous le pointeur, reste prioritaire.
- Maj+F pendant le glisser d'un jeton reste le « point de passage non aimanté » de Foundry : le raccourci Fond ne joue qu'en dehors d'un glisser.
- Pour développer : le dossier du module doit s'appeler `tableau-de-jeu` (identifiant du module), pas `foundry-board`.
- Seul le MJ pose des images.
