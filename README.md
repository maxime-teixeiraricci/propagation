# Propagation

Jeu de grille à deux joueurs. Chacun place des points sur ses cases ; à 4 points, une case déborde sur ses 4 voisines. Parties à distance avec un lien ou un code.

Contenu : `server.js` (le serveur, aucune dépendance), `index.html` (le jeu), `package.json`.
Il faut seulement Node 18 ou plus.

## 1. Essayer chez toi

```
node server.js
```

Ouvre http://localhost:3000. Le bouton « Jouer à deux ici » permet de tester seul.
Pour jouer avec un ami à distance, il faut que ton PC soit joignable : utilise un tunnel gratuit (ngrok, Cloudflare Tunnel…) qui expose le port 3000, ou passe à l'étape 2.

## 2. Mettre en ligne gratuitement (Render)

1. Crée un dépôt GitHub avec ces 3 fichiers à la racine.
2. Sur render.com, crée un compte gratuit, puis New > Web Service et choisis ton dépôt.
3. Runtime : Node. Build Command : laisse vide. Start Command : `node server.js`. Plan : Free.
4. Au bout de quelques minutes, tu obtiens une adresse du type `https://propagation-xxxx.onrender.com`. C'est le jeu : envoie-la à ton ami.

Comment on joue : l'un clique sur « Créer une partie », puis « Copier le lien » et l'envoie. L'autre ouvre le lien et la partie démarre.

## À savoir

- L'offre gratuite de Render met le service en veille après environ 15 minutes sans visite. Le premier chargement après une veille prend 30 à 60 secondes.
- Les parties sont gardées en mémoire : elles disparaissent si le serveur redémarre ou s'endort. Elles sont oubliées après 24 h sans coup.
- Quiconque connaît le lien ou le code d'une partie peut la rejoindre (si la place est libre) ou la regarder.
- Un joueur retrouve sa place en rechargeant la page, mais pas s'il ferme l'onglet.
