# Tableau de jeu

Module pour Foundry VTT 13 et 14 : utiliser Foundry comme un tableau blanc, à la Roll20. Pour les tables qui montrent des images, gèrent fiches et journaux et lancent des dés, plus que des donjons en vision dynamique.

Installation : Modules complémentaires > Installer un module > manifeste :

    https://github.com/ranglier/foundry-board/releases/latest/download/module.json

## Ce que fait le module (pour le MJ)

- **Glisser-déposer d'images sur la scène**, depuis :
  - une page image d'un journal (depuis le sommaire du journal) ou une image dans le texte d'un journal ;
  - le portrait d'une fiche de personnage ou de PNJ (glisser le portrait de la fiche ouverte, ou Maj + glisser l'acteur depuis la barre latérale) ;
  - un objet (glisser l'objet : son image est posée) ;
  - un fichier de l'ordinateur (envoyé dans `worlds/<monde>/tableau/`).
  L'image arrive **sur le calque MJ, cachée**, à l'endroit du dépôt.
- **Trois calques** :
  - **Fond** : tuile sous tout le reste, verrouillée en y entrant, déplaçable par le MJ seul ;
  - **Joueurs** : visible, déplaçable par les joueurs ;
  - **MJ** : invisible des joueurs, ou visible sans pouvoir être déplacée (œil).
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

Les images des calques Joueurs et MJ sont des jetons sans vision, nom ni barres, rattachés à deux acteurs créés par le module dans le dossier d'acteurs « Tableau de jeu » : « Tableau - Joueurs » (propriété de tous les joueurs, qui peuvent donc déplacer ses jetons) et « Tableau - MJ » (MJ seul). Foundry ne laisse en effet que le MJ déplacer une tuile. Ne supprimez pas ces deux acteurs (ils sont recréés au besoin, mais les images posées avec les anciens perdent leur rattachement).

Le déplacement d'un groupe par un joueur est appliqué aux autres membres par le MJ connecté : un MJ doit être en ligne.

## Limites connues

- Sur une scène avec vision des jetons, un joueur qui sélectionne une image du calque Joueurs voit la scène comme s'il n'avait pas de jeton (les images n'ont pas de vision). Les scènes tableau n'ont pas de vision : utilisez-les pour montrer des images.
- Un acteur glissé sans Maj crée un jeton de personnage, comme d'habitude (Alt : jeton caché) ; une page de texte glissée crée une note ; un objet lâché sur un jeton est laissé au système.
- Les joueurs déplacent et tournent les images du calque Joueurs, sans pouvoir en changer l'image, le verrou ni en créer.
- Maj+F pendant le glisser d'un jeton reste le « point de passage non aimanté » de Foundry : le raccourci Fond ne joue qu'en dehors d'un glisser.
- Pour développer : le dossier du module doit s'appeler `tableau-de-jeu` (identifiant du module), pas `foundry-board`.
- Seul le MJ pose des images.
