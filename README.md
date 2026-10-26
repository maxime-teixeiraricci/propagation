# Propagation

Jeu de grille de 2 à 8 joueurs. Chacun place des points sur ses cases ; à 4 points, une case déborde sur ses 4 voisines. Le dernier joueur qui a encore des cases gagne. Parties à distance avec un lien ou un code.

Contenu : `server.js` (le serveur, aucune dépendance), `index.html` (le jeu), `package.json`, `render.yaml` (déploiement Render).
Il faut seulement Node 18 ou plus.

## Modes

- 2, 4, 6 ou 8 joueurs, chacun pour soi. Chaque joueur a une couleur et une forme de point.
- La grille s'adapte au nombre de joueurs (6 à 10 à deux, jusqu'à 16 à huit).
- Un joueur qui n'a plus aucune case est éliminé, son tour est sauté.
- Tant que la partie n'est pas complète, le créateur peut la lancer avec les joueurs déjà présents (« Lancer maintenant »).
- Si quelqu'un ne joue plus pendant 45 secondes, les autres voient un bouton « L'éliminer » pour débloquer la partie.
- « Revanche » relance une partie avec les mêmes joueurs.

## Essayer chez toi

```
node server.js
```

Ouvre http://localhost:3000. « Jouer sur le même écran » permet de tester seul.

## Mettre en ligne gratuitement (Render)

1. Dépôt GitHub avec ces fichiers à la racine.
2. Sur render.com : New > Blueprint, choisis le dépôt, valide. Render lit `render.yaml`.
3. Tu obtiens une adresse du type `https://propagation-xxxx.onrender.com`. C'est le jeu.

À chaque mise à jour du dépôt, Render redéploie tout seul.

## À savoir

- L'offre gratuite de Render met le service en veille après environ 15 minutes sans visite. Le premier chargement après une veille prend 30 à 60 secondes.
- Les parties sont gardées en mémoire : elles disparaissent si le serveur redémarre ou s'endort. Elles sont oubliées après 24 h sans coup.
- Quiconque connaît le lien ou le code d'une partie peut la rejoindre (si une place est libre) ou la regarder.
- Un joueur retrouve sa place en rechargeant la page, mais pas s'il ferme l'onglet.
